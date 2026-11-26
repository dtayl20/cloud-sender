-- 0024_sequence_step_content.sql - a sequence step owns its own email copy.
--
-- The builder's new docked editor edits a step as its OWN editable copy, seeded
-- from a template but never live-linked to it: editing a step must never mutate
-- a template, and editing a template must never change a step that was seeded
-- from it. The copy is stored on the step:
--
--   content_html              the step's own HTML body (full document)
--   content_text              optional plain-text body
--   seeded_from_template_id   provenance only ("inserted from template X");
--                             never read at render time
--
-- A step with content_html IS the send body: the consumer renders it directly
-- (Mustache over the stored HTML) instead of merging into templates.html at
-- {{content}}. Steps with content_html NULL keep the original behaviour
-- (template_id / external_template_id + body_html merged at {{content}}), so
-- every existing sequence keeps sending exactly as before.
--
-- Additive only: three nullable columns on sequence_steps. No table is rebuilt.
ALTER TABLE sequence_steps ADD COLUMN content_html TEXT;
ALTER TABLE sequence_steps ADD COLUMN content_text TEXT;
ALTER TABLE sequence_steps ADD COLUMN seeded_from_template_id INTEGER;
