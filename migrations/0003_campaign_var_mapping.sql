-- Per-campaign mapping of contact fields to SMTP2GO template variables.
-- JSON shape: { "<template_var_name>": "<dotted.contact.field>" }
-- Example: { "fname": "first_name", "promo": "attributes.promo_code" }
ALTER TABLE campaigns ADD COLUMN var_mapping TEXT;
