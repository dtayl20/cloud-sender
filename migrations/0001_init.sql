-- Bulk Emailer initial schema

CREATE TABLE contacts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  first_name   TEXT,
  last_name    TEXT,
  practice_name TEXT,
  attributes   TEXT NOT NULL DEFAULT '{}',   -- JSON blob
  status       TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','unsubscribed','bounced','complained','disabled')),
  source       TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_contacts_status ON contacts(status);
CREATE INDEX idx_contacts_email ON contacts(email);

CREATE TABLE suppressions (
  email        TEXT PRIMARY KEY COLLATE NOCASE,
  reason       TEXT NOT NULL,                 -- bounce | complaint | unsubscribe | manual
  source       TEXT NOT NULL DEFAULT 'webhook',
  detail       TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE lists (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  filter_json  TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE list_members (
  list_id      INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  contact_id   INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, contact_id)
);

CREATE TABLE templates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT NOT NULL CHECK (source IN ('local','smtp2go')),
  external_id  TEXT,                          -- SMTP2GO template id when source=smtp2go
  name         TEXT NOT NULL,
  subject      TEXT NOT NULL DEFAULT '',
  html         TEXT NOT NULL DEFAULT '',
  text         TEXT,
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE campaigns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  template_id     INTEGER REFERENCES templates(id),
  list_id         INTEGER REFERENCES lists(id),
  audience_filter TEXT,                       -- JSON filter; null = all active
  sending_domain  TEXT,
  from_name       TEXT,
  from_email      TEXT,
  reply_to        TEXT,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','scheduled','sending','paused','sent','failed','cancelled')),
  scheduled_at    INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  started_at      INTEGER,
  finished_at     INTEGER
);
CREATE INDEX idx_campaigns_status ON campaigns(status);

CREATE TABLE sends (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id     INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
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
  UNIQUE (campaign_id, contact_id)
);
CREATE INDEX idx_sends_campaign_status ON sends(campaign_id, status);
CREATE INDEX idx_sends_email ON sends(email);
CREATE INDEX idx_sends_smtp2go_id ON sends(smtp2go_id);

CREATE TABLE webhook_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  event_type      TEXT NOT NULL,
  email           TEXT,
  smtp2go_id      TEXT,
  payload         TEXT NOT NULL
);
CREATE INDEX idx_webhook_events_email ON webhook_events(email);

CREATE TABLE settings (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL,
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE import_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT NOT NULL,             -- 'csv' | 'd1'
  status          TEXT NOT NULL DEFAULT 'pending',
  total           INTEGER DEFAULT 0,
  processed       INTEGER DEFAULT 0,
  inserted        INTEGER DEFAULT 0,
  skipped         INTEGER DEFAULT 0,
  error           TEXT,
  config          TEXT,                       -- JSON: column map, source table, etc.
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  finished_at     INTEGER
);
