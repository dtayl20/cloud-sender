-- 0013_ghl_send_template.sql - a GHL tag can send one SMTP2GO template to one
-- contact through this Worker (`POST /api/webhooks/send-template`).
--
-- Two columns carry the GHL contact id so a later write-back (notes/tags on the
-- GHL contact) can be matched back:
--   * contacts.ghl_contact_id - the contact this email address belongs to in GHL.
--   * sends.ghl_contact_id    - the contact a particular send went to.
--
-- `contacts.ghl_contact_id` is a plain ADD COLUMN.
--
-- `sends.campaign_id`, however, was declared `INTEGER NOT NULL REFERENCES
-- campaigns(id)` in 0001, because until now every send came from a campaign.
-- A GHL tag-triggered template send is NOT a campaign: there is no campaign to
-- point at, so the column has to accept NULL. SQLite cannot drop a NOT NULL
-- constraint in place (`ALTER TABLE ... ADD COLUMN` is the only ALTER it
-- supports), so `sends` is rebuilt here - the same technique 0006 used for
-- `tags`. The rebuild is data-preserving:
--   * every existing row, id included, is copied verbatim;
--   * the column set is identical, plus `ghl_contact_id`;
--   * the CHECK on `status`, the UNIQUE(campaign_id, contact_id) and every index
--     are recreated unchanged.
--
-- Nothing in the campaign sending path changes. It reads and writes `sends` by
-- campaign_id (which is never NULL for a campaign send) and by primary key, and
-- a nullable campaign_id plus new rows simply never match those queries. The
-- existing SMTP2GO open/click callback matches on (email, smtp2go_id), so it
-- stamps opened_at/clicked_at on these rows exactly as it does on campaign rows.
--
-- runs once (tracked in d1_migrations) and is a single transaction in D1, so a
-- partial failure rolls back rather than leaving a half-swapped schema.

-- 1) GHL contact id on the contact.
ALTER TABLE contacts ADD COLUMN ghl_contact_id TEXT;
CREATE INDEX IF NOT EXISTS idx_contacts_ghl_contact_id ON contacts(ghl_contact_id);

-- 2) Rebuild `sends`: campaign_id becomes nullable and ghl_contact_id is added.
CREATE TABLE IF NOT EXISTS sends_ghl_v2 (
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

INSERT INTO sends_ghl_v2
  (id, campaign_id, contact_id, email, status, smtp2go_id, error,
   queued_at, sent_at, delivered_at, bounced_at, opened_at, clicked_at)
SELECT
   id, campaign_id, contact_id, email, status, smtp2go_id, error,
   queued_at, sent_at, delivered_at, bounced_at, opened_at, clicked_at
FROM sends;

DROP TABLE sends;
ALTER TABLE sends_ghl_v2 RENAME TO sends;

CREATE INDEX IF NOT EXISTS idx_sends_campaign_status ON sends(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_sends_email ON sends(email);
CREATE INDEX IF NOT EXISTS idx_sends_smtp2go_id ON sends(smtp2go_id);
CREATE INDEX IF NOT EXISTS idx_sends_campaign_queued ON sends(campaign_id, queued_at);
CREATE INDEX IF NOT EXISTS idx_sends_ghl_contact_id ON sends(ghl_contact_id);
