-- schema.sql — consolidated D1 schema for a FRESH database.
--
-- Generated from migrations/0001..0013 (applied in order to an empty SQLite
-- database, then the resulting DDL dumped). Use this for a first install:
--
--   npx wrangler d1 execute emailer_db --remote --file=schema.sql
--
-- Existing databases must keep using migrations/:
--
--   npx wrangler d1 migrations apply emailer_db --remote
--
-- Do not run this file against a database that already has tables.

PRAGMA foreign_keys = ON;

CREATE TABLE campaign_tags (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (campaign_id, tag_id)
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
, external_template_id TEXT, segment_id INTEGER REFERENCES lists(id), var_mapping TEXT, body_html TEXT, subject TEXT, daily_cap INTEGER, send_days TEXT, send_time TEXT, send_timezone TEXT, ramp_start INTEGER, ramp_days INTEGER, spread_minutes INTEGER);

CREATE TABLE contact_rate (
  ip_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE "contact_tags" (
  contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES "tags"(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, tag_id)
);

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
, source_table   TEXT, source_row_key TEXT, last_seen_at   INTEGER, ghl_contact_id TEXT);

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

CREATE TABLE list_members (
  list_id      INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  contact_id   INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, contact_id)
);

CREATE TABLE lists (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  filter_json  TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
, kind TEXT NOT NULL DEFAULT 'static');

CREATE TABLE "sends" (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id     INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id      INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  email           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','sending','sent','delivered','bounced','failed','skipped','complained')),
  smtp2go_id      TEXT,
  error           TEXT,
  ghl_contact_id  TEXT,
  queued_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  sent_at         INTEGER,
  delivered_at    INTEGER,
  bounced_at      INTEGER,
  opened_at       INTEGER,
  clicked_at      INTEGER,
  UNIQUE (campaign_id, contact_id)
);

CREATE TABLE settings (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL,
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE source_tables (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name      TEXT NOT NULL UNIQUE,
  email_column    TEXT NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1,
  cron_enabled    INTEGER NOT NULL DEFAULT 1,
  last_synced_at  INTEGER,
  last_row_count  INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE suppressions (
  email        TEXT PRIMARY KEY COLLATE NOCASE,
  reason       TEXT NOT NULL,                 -- bounce | complaint | unsubscribe | manual
  source       TEXT NOT NULL DEFAULT 'webhook',
  detail       TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE "tags" (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL COLLATE NOCASE,
  scope       TEXT NOT NULL DEFAULT 'contact',
  color       TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (name, scope)
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
, is_base INTEGER NOT NULL DEFAULT 0);

CREATE TABLE webhook_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  event_type      TEXT NOT NULL,
  email           TEXT,
  smtp2go_id      TEXT,
  payload         TEXT NOT NULL
);

CREATE INDEX idx_campaign_tags_tag ON campaign_tags(tag_id);

CREATE INDEX idx_campaigns_status ON campaigns(status);

CREATE INDEX idx_contact_rate_window ON contact_rate (window_start);

CREATE INDEX idx_contact_tags_tag ON contact_tags(tag_id);

CREATE INDEX idx_contacts_email ON contacts(email);

CREATE INDEX idx_contacts_ghl_contact_id ON contacts(ghl_contact_id);

CREATE INDEX idx_contacts_source     ON contacts(source_table, source_row_key);

CREATE INDEX idx_contacts_source_seen ON contacts(source_table, last_seen_at);

CREATE INDEX idx_contacts_status ON contacts(status);

CREATE INDEX idx_sends_campaign_queued ON sends(campaign_id, queued_at);

CREATE INDEX idx_sends_campaign_status ON sends(campaign_id, status);

CREATE INDEX idx_sends_email ON sends(email);

CREATE INDEX idx_sends_ghl_contact_id ON sends(ghl_contact_id);

CREATE INDEX idx_sends_smtp2go_id ON sends(smtp2go_id);

CREATE INDEX idx_webhook_events_email ON webhook_events(email);

-- Seed: default base template (was migration 0005).
INSERT INTO templates (source, external_id, name, subject, html, text, is_base)
SELECT 'local', NULL, 'Base template', 'Example Co',
  '<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6">{{content}}</body></html>',
  '{{content}}',
  1
WHERE NOT EXISTS (SELECT 1 FROM templates WHERE is_base = 1);
