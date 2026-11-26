-- 0017_email_verification_backfill.sql - queue the pre-existing contacts for
-- verification so they can become sendable again.
--
-- 0016 added `contacts.email_status` nullable and left every existing row NULL
-- ("never checked"). Under the send rule, only 'valid' is sendable, so a NULL
-- row is held back - and the verification pass only selects 'pending'. Without
-- this back-fill the whole pre-existing list would be dark forever.
--
-- This is a data-only, additive migration: it moves NULL -> 'pending' so the
-- 1-minute cron starts verifying the existing base. Nothing is deleted and no
-- table is rebuilt. It is idempotent (the WHERE matches nothing on a re-run).

UPDATE contacts SET email_status = 'pending' WHERE email_status IS NULL;
