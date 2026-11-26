-- 0022_form_submission.sql - form-submission webhook (POST /api/webhooks/form-submission).
--
-- The forms team posts one fixed payload per submission (see
-- src/worker/formSubmission.ts). This table is both the IDEMPOTENCY key and the
-- audit record: the PRIMARY KEY on `submission_id` is claimed with one
-- INSERT OR IGNORE, so the same submission never verifies or enrols twice
-- (a repeat call reads this row back and returns its stored outcome).
--
-- Additive only: one new table + indexes. No existing table is touched, so the
-- campaign / sequence send paths are unaffected.
--
--   status        processing | enrolled | held | not_enrolled | suppressed
--                 | unmapped | error
--                 'held' = captured into a DRAFT sequence: enrolled, but the
--                 clock is NULL until the sequence is activated (see
--                 sequence_enrollments.next_due_at IS NULL / releaseHeldEnrollments).
--   verify_status the Bulk Email Checker result recorded for THIS address at
--                 submit time (valid | risky | invalid | unknown | pending when
--                 the API errored and the address was queued instead).
--   consent       JSON { accepted, text, at } - the wording shown and when, an
--                 auditable copy of what the submitter agreed to.
--   payload       the raw normalised request body (audit).

CREATE TABLE IF NOT EXISTS form_submissions (
  submission_id TEXT PRIMARY KEY,
  form_slug     TEXT,
  email         TEXT,
  contact_id    INTEGER,
  sequence_id   INTEGER,
  enrollment_id INTEGER,
  status        TEXT NOT NULL DEFAULT 'processing',
  reason        TEXT,
  verify_status TEXT,
  consent       TEXT,
  payload       TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_form_submissions_email ON form_submissions(email);
CREATE INDEX IF NOT EXISTS idx_form_submissions_slug ON form_submissions(form_slug, created_at);
