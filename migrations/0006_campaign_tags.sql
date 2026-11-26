-- 0006_campaign_tags.sql — campaign tags, independent of contact tags.
--
-- Until now `tags` was a single global namespace: a "melbourne" tag on a
-- contact and a "melbourne" tag on a campaign were the same row. This migration
-- gives every tag a `scope` and makes uniqueness per-scope, so the two can
-- coexist as separate rows with separate ids.
--
-- SQLite cannot drop a UNIQUE constraint, so `tags` is rebuilt:
--   new table -> copy existing rows as scope='contact' -> swap -> rename.
-- Ids are preserved, so existing contact_tags rows keep pointing at the same
-- tags. The join table is rebuilt too, because a DROP TABLE on a table that is
-- still referenced would cascade-delete its rows under foreign key enforcement.
--
-- Runs once (tracked in d1_migrations); the file is a single transaction in D1,
-- so a partial failure rolls back rather than leaving a half-swapped schema.

-- 1) New tags shape: name is unique per scope (case-insensitive within a scope).
CREATE TABLE IF NOT EXISTS tags_scope_v2 (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL COLLATE NOCASE,
  scope       TEXT NOT NULL DEFAULT 'contact',
  color       TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (name, scope)
);

-- 2) Every existing tag becomes a contact tag, keeping its id.
INSERT OR IGNORE INTO tags_scope_v2 (id, name, scope, color, created_at)
SELECT id, name, 'contact', color, created_at FROM tags;

-- 3) Rebuild contact_tags against the new tags table. Referencing `tags_scope_v2`
--    (not `tags`) means nothing points at `tags` while it is dropped.
CREATE TABLE IF NOT EXISTS contact_tags_scope_v2 (
  contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES tags_scope_v2(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, tag_id)
);
INSERT OR IGNORE INTO contact_tags_scope_v2 (contact_id, tag_id)
SELECT contact_id, tag_id FROM contact_tags;

DROP TABLE IF EXISTS contact_tags;
DROP TABLE IF EXISTS tags;

-- Renaming rewrites the REFERENCES clause in contact_tags_scope_v2 to `tags`.
ALTER TABLE tags_scope_v2 RENAME TO tags;
ALTER TABLE contact_tags_scope_v2 RENAME TO contact_tags;

CREATE INDEX IF NOT EXISTS idx_contact_tags_tag ON contact_tags(tag_id);

-- 4) Campaign-side join, mirrored on contact_tags.
CREATE TABLE IF NOT EXISTS campaign_tags (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (campaign_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_tags_tag ON campaign_tags(tag_id);
