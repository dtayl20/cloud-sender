-- 0007_campaign_subject.sql - per-campaign subject line.
--
-- Until now the subject lived only on templates.subject, so every campaign
-- built from a template shared one subject. This adds an optional per-campaign
-- subject override.
--
-- Additive only. Existing data keeps working exactly as before:
--   * campaigns.subject IS NULL -> the template's subject is used, unchanged.
--   * templates.subject is untouched, and the template editor is unchanged.
--
-- Ordering note: the brief asked for 0006_campaign_subject.sql, but 0006 is
-- already 0006_campaign_tags.sql on main, so this is 0007 (D1 tracks migration
-- filenames in d1_migrations; reusing 0006 would silently skip this file).

ALTER TABLE campaigns ADD COLUMN subject TEXT;
