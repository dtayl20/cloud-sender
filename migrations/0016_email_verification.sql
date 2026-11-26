-- 0016_email_verification.sql - per-contact email verification (Bulk Email
-- Checker) so imports are checked out-of-band and bad addresses are held back.
--
-- Additive only: four new nullable columns on `contacts` plus one index. No
-- table is rebuilt.
--
-- Existing rows are migrated in with email_status = NULL, which means "never
-- checked" and is deliberately treated as sendable (grandfathered) so this
-- migration cannot stop the current list from sending. New rows -- CSV/D1
-- imports, the source-DB mirror sync and manual adds -- are inserted as
-- 'pending'.
--
--   email_status       pending | valid | risky | invalid | unknown   (NULL = never checked)
--   email_verified_at  unix seconds of the last check               (NULL = never checked)
--   email_check_event  BEC's `event` for the last check, e.g. mailbox_exists
--   email_check_flags  JSON of the raw signals used (isDisposable, isGibberish, ...)
--
-- The status vocabulary and the send blocklist live in src/shared/emailStatus.ts.

ALTER TABLE contacts ADD COLUMN email_status TEXT;
ALTER TABLE contacts ADD COLUMN email_verified_at INTEGER;
ALTER TABLE contacts ADD COLUMN email_check_event TEXT;
ALTER TABLE contacts ADD COLUMN email_check_flags TEXT;

CREATE INDEX IF NOT EXISTS idx_contacts_email_status ON contacts(email_status);
