-- 0015_ghl_tag_trigger_campaign.sql - give GHL tag-triggered sends a home so
-- they are visible in the Bulk emailer UI.
--
-- `POST /api/webhooks/send-template` records a send per tag-triggered email.
-- Until now that row had campaign_id = NULL, so it appeared on no campaign and
-- its opens/clicks were invisible in the app. The route now attaches every such
-- send to ONE pseudo-campaign named "GHL tag triggers" (created on demand by the
-- route), whose stats then come from the normal per-campaign aggregation.
--
-- That pseudo-campaign is a container, not a scheduled blast: it is created with
-- status 'draft' and no send window / plan, which is exactly the shape the
-- every-minute dispatcher (dispatchDueCampaigns) never selects. See
-- src/worker/ghlCampaign.ts.
--
-- The one schema change this needs: `sends` carried UNIQUE (campaign_id,
-- contact_id) from 0001 - within a campaign a contact appears at most once. That
-- rule is right for a campaign audience (it is what enqueueCampaign's INSERT OR
-- IGNORE dedupes against) but wrong for the tag-trigger container, which holds
-- ad-hoc, repeatable sends: the same contact can receive send_playbook and later
-- send_ld_general_info, and each send must keep its own smtp2go_id so the
-- open/click callback still matches.
--
-- So the table-level UNIQUE is replaced by a PARTIAL unique index that keeps the
-- one-row-per-contact rule for campaign sends only. GHL tag sends always carry a
-- ghl_contact_id (the endpoint's validation requires it); campaign sends never
-- set it. The index therefore applies to campaign rows and not to tag sends.
--
-- `sends` was last rebuilt in 0013; this is the same data-preserving technique.
-- The column set now also carries ghl_open_noted_at / ghl_click_noted_at (0014).

CREATE TABLE IF NOT EXISTS sends_trigger_v3 (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id     INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id      INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  email           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','sending','sent','delivered','bounced','failed','skipped','complained')),
  smtp2go_id      TEXT,
  error           TEXT,
  ghl_contact_id  TEXT,
  ghl_open_noted_at  INTEGER,
  ghl_click_noted_at INTEGER,
  queued_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  sent_at         INTEGER,
  delivered_at    INTEGER,
  bounced_at      INTEGER,
  opened_at       INTEGER,
  clicked_at      INTEGER
);

INSERT INTO sends_trigger_v3
  (id, campaign_id, contact_id, email, status, smtp2go_id, error, ghl_contact_id,
   ghl_open_noted_at, ghl_click_noted_at,
   queued_at, sent_at, delivered_at, bounced_at, opened_at, clicked_at)
SELECT
   id, campaign_id, contact_id, email, status, smtp2go_id, error, ghl_contact_id,
   ghl_open_noted_at, ghl_click_noted_at,
   queued_at, sent_at, delivered_at, bounced_at, opened_at, clicked_at
FROM sends;

DROP TABLE sends;
ALTER TABLE sends_trigger_v3 RENAME TO sends;

CREATE INDEX IF NOT EXISTS idx_sends_campaign_status ON sends(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_sends_email ON sends(email);
CREATE INDEX IF NOT EXISTS idx_sends_smtp2go_id ON sends(smtp2go_id);
CREATE INDEX IF NOT EXISTS idx_sends_campaign_queued ON sends(campaign_id, queued_at);
CREATE INDEX IF NOT EXISTS idx_sends_ghl_contact_id ON sends(ghl_contact_id);

-- The 0001 UNIQUE (campaign_id, contact_id), re-expressed as a partial index:
-- campaign sends only. A GHL tag send carries a ghl_contact_id and is allowed to
-- repeat, so it is exempt; INSERT OR IGNORE on the campaign path is unchanged.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sends_campaign_contact
  ON sends(campaign_id, contact_id)
  WHERE campaign_id IS NOT NULL AND ghl_contact_id IS NULL;
