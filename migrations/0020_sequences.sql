-- 0020_sequences.sql - sequenced email campaigns ("sequences").
--
-- A sequence is an ordered list of steps, each with a wait measured RELATIVE to
-- the previous step's send (step 1 from enrolment). A contact enrolled in a
-- sequence receives step 1, then (step 2's wait) after step 1 was sent, and so
-- on, until no step with a higher position remains.
--
-- The engine keys off `sequence_enrollments.last_sent_position`:
--
--   * a step is DUE when step.position > enrollment.last_sent_position.
--
-- That is the whole trick: nothing stores a step *index*, so appending a step
-- later makes completed enrolments eligible for the NEW step only (nobody
-- restarts), and a step inserted mid-sequence is naturally skipped by every
-- contact who already passed that position. See src/worker/sequences.ts.
--
-- Additive only. One new nullable column on `contacts` (timezone, derived from
-- the contact's state - see 0021 for the back-fill) plus new tables. No existing
-- table is rebuilt, so the campaign send path is untouched.

-- Per-contact IANA zone, derived from the contact's state at import/sync time.
-- NULL = unknown; the sequence's own send_timezone is the fallback at send time.
ALTER TABLE contacts ADD COLUMN timezone TEXT;
CREATE INDEX IF NOT EXISTS idx_contacts_timezone ON contacts(timezone);

CREATE TABLE IF NOT EXISTS sequences (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','paused','archived')),
  -- Audience: exactly one of list_id / segment_id / (all active). Mirrors the
  -- campaign audience columns, so resolveAudience's rules apply unchanged.
  list_id         INTEGER REFERENCES lists(id),
  segment_id      INTEGER,
  audience_filter TEXT,
  from_name       TEXT,
  from_email      TEXT,
  reply_to        TEXT,
  -- Sending plan: the SAME ramp/spread settings a campaign uses (see
  -- shared/sendPlan.ts), read per sequence. daily_cap + send_days + send_time
  -- are the ramp the owner already configured for campaigns.
  daily_cap       INTEGER,
  send_days       TEXT,
  send_time       TEXT,
  send_timezone   TEXT,
  ramp_start      INTEGER,
  ramp_days       INTEGER,
  spread_minutes  INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  started_at      INTEGER
);

CREATE TABLE IF NOT EXISTS sequence_steps (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence_id       INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  -- Ordering. Assigned with wide gaps (see worker/sequences.ts) so a mid-sequence
  -- insert is a single row, and a renumber fallback keeps integers friendly.
  position          INTEGER NOT NULL,
  name              TEXT,
  template_id       INTEGER REFERENCES templates(id),
  external_template_id TEXT,
  subject           TEXT,
  body_html         TEXT,
  -- Wait BEFORE this step, measured from the previous send (step 1: from
  -- enrolment). Minutes, so "3 days" = 4320. 0 = send as soon as due.
  wait_minutes      INTEGER NOT NULL DEFAULT 0,
  -- NULL = this step is not yet released to COMPLETED enrolments. Appending a
  -- step leaves this NULL so a completed contact never receives it until the
  -- operator confirms the release preview. Mid-sequence contacts are unaffected.
  released_to_completed_at INTEGER,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (sequence_id, position)
);

CREATE TABLE IF NOT EXISTS sequence_enrollments (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence_id        INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  contact_id         INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  email              TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','completed','stopped','removed')),
  -- unsubscribe | bounce | complaint | manual | blocked
  stop_reason        TEXT,
  enrolled_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  -- Position of the last step released to this contact. NEVER a step index.
  last_sent_position INTEGER NOT NULL DEFAULT 0,
  -- When the last step went out. Also the anchor for the NEXT step's wait, and
  -- (for a released append) the moment the wait restarts.
  last_sent_at       INTEGER,
  -- When the next step becomes due, in epoch seconds. Advisory: the dispatcher
  -- recomputes it, but it drives the per-recipient "next due" view.
  next_due_at        INTEGER,
  restarts           INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (sequence_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_seq_enroll_status ON sequence_enrollments(sequence_id, status);
CREATE INDEX IF NOT EXISTS idx_seq_enroll_contact ON sequence_enrollments(contact_id);
CREATE INDEX IF NOT EXISTS idx_seq_enroll_due ON sequence_enrollments(sequence_id, next_due_at);

-- One row per (sequence, contact, step) send. The UNIQUE index is the
-- idempotency key the whole engine leans on: a step can never be sent twice to
-- the same contact, so a duplicated or overlapping cron tick is a no-op.
CREATE TABLE IF NOT EXISTS sequence_sends (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence_id     INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  enrollment_id   INTEGER REFERENCES sequence_enrollments(id) ON DELETE CASCADE,
  step_id         INTEGER,
  step_position   INTEGER NOT NULL,
  contact_id      INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  email           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','sending','sent','delivered','bounced','failed','skipped','complained')),
  smtp2go_id      TEXT,
  error           TEXT,
  queued_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  sent_at         INTEGER,
  delivered_at    INTEGER,
  bounced_at      INTEGER,
  opened_at       INTEGER,
  clicked_at      INTEGER,
  unsubscribed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_seq_sends_unique
  ON sequence_sends(sequence_id, contact_id, step_position);
CREATE INDEX IF NOT EXISTS idx_seq_sends_step ON sequence_sends(sequence_id, step_position);
CREATE INDEX IF NOT EXISTS idx_seq_sends_smtp2go ON sequence_sends(smtp2go_id);
CREATE INDEX IF NOT EXISTS idx_seq_sends_email ON sequence_sends(email);
CREATE INDEX IF NOT EXISTS idx_seq_sends_queued ON sequence_sends(sequence_id, queued_at);

-- Enrolment / lifecycle history. Every explicit operator action and every
-- engine transition that matters (enrol, re-enrol with its mode, remove,
-- complete, stop on unsubscribe/bounce) is recorded here.
CREATE TABLE IF NOT EXISTS sequence_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence_id   INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  enrollment_id INTEGER,
  contact_id    INTEGER,
  type          TEXT NOT NULL,
  detail        TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_seq_events_seq ON sequence_events(sequence_id, created_at);
CREATE INDEX IF NOT EXISTS idx_seq_events_enroll ON sequence_events(enrollment_id, created_at);

-- Single-flight lease for the sequence dispatcher, same discipline as
-- verify_lock (0019): a tick must claim it with one conditional write, so a pass
-- that outlives its minute cannot overlap the next one.
CREATE TABLE IF NOT EXISTS sequence_lock (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  owner      TEXT NOT NULL,
  started_at INTEGER NOT NULL
);

-- TEST MODE output. A whole sequence can be run to one controlled address with
-- the waits compressed; those sends are recorded HERE, never in sequence_sends,
-- and they create no enrolment and touch no metric.
CREATE TABLE IF NOT EXISTS sequence_test_sends (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence_id   INTEGER NOT NULL,
  step_position INTEGER NOT NULL,
  email         TEXT NOT NULL,
  smtp2go_id    TEXT,
  error         TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
