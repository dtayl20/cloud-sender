-- Tags, lists/segments, campaign audience refinements

CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color       TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS contact_tags (
  contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_contact_tags_tag ON contact_tags(tag_id);

-- Allow segments (dynamic lists) alongside static lists
ALTER TABLE lists ADD COLUMN kind TEXT NOT NULL DEFAULT 'static';

-- Allow campaigns to reference a SMTP2GO template directly (no import step)
ALTER TABLE campaigns ADD COLUMN external_template_id TEXT;

-- Allow campaigns to target a segment as well as a static list
ALTER TABLE campaigns ADD COLUMN segment_id INTEGER REFERENCES lists(id);
