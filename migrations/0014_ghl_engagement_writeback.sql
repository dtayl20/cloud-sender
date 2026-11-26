-- 0014_ghl_engagement_writeback.sql - remember which send directions have been
-- written back to GHL, so a repeat open/click does not re-post the same note.
--
-- The open/click callback (POST /api/webhooks/smtp2go) now mirrors an event onto
-- the GHL contact: a note plus a tag (email_opened / email_clicked by default).
-- Repeat opens are common, so each direction is written at most once:
--
--   ghl_open_noted_at   - unixepoch() once the open note+tag is written
--   ghl_click_noted_at  - unixepoch() once the click note+tag is written
--
-- NULL means "not yet written back". These are deliberately separate from
-- opened_at/clicked_at (the app's own first-event stamps): when GHL errors the
-- flag stays NULL, so a later event retries the write-back.
--
-- The contact id the write-back needs already lives on `sends.ghl_contact_id`
-- and `contacts.ghl_contact_id` (0013); when it is absent the handler falls back
-- to a lookup by email, so no further column is required here.

ALTER TABLE sends ADD COLUMN ghl_open_noted_at INTEGER;
ALTER TABLE sends ADD COLUMN ghl_click_noted_at INTEGER;
