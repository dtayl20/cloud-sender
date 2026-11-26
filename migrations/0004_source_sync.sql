-- Import-first: mirror source DB tables into local contacts on a schedule.

CREATE TABLE IF NOT EXISTS source_tables (
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

-- Attach source-tracking fields to contacts so upserts are idempotent and we
-- can detect deletions ("not seen this run" -> mark disabled).
ALTER TABLE contacts ADD COLUMN source_table   TEXT;
ALTER TABLE contacts ADD COLUMN source_row_key TEXT;
ALTER TABLE contacts ADD COLUMN last_seen_at   INTEGER;

CREATE INDEX IF NOT EXISTS idx_contacts_source     ON contacts(source_table, source_row_key);
CREATE INDEX IF NOT EXISTS idx_contacts_source_seen ON contacts(source_table, last_seen_at);
