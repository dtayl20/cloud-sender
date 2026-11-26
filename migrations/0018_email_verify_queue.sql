-- 0018_email_verify_queue.sql - explicit "check this address" queue for the
-- Bulk Email Checker pass, plus an index for the re-verify cadence.
--
-- Additive only: one new NOT NULL column with a default, so every existing row
-- is 0 ("not queued") and nothing about the current send rule changes.
--
--   email_verify_queued 1 = the operator asked for this address to be checked on
--                            the next cron pass (the Contacts "Queue
--                            verification" action). The pass clears it back to
--                            0 as soon as it has a fresh answer.
--
-- Why a flag rather than re-using email_status='pending': queuing a re-check of
-- an already-'valid' address must NOT pull it out of the send audience while it
-- waits its turn behind the 25/min cap. The flag leaves email_status (and so
-- sendability) untouched until the pass has a new result for the row; only then
-- is email_status/email_verified_at rewritten.
--
-- The cadence itself is a settings value (email_verify_stale_days, default 180)
-- and needs no schema: it is read at pass time from the settings table.

ALTER TABLE contacts ADD COLUMN email_verify_queued INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_contacts_verify_queued ON contacts(email_verify_queued);
CREATE INDEX IF NOT EXISTS idx_contacts_email_verified_at ON contacts(email_verified_at);
