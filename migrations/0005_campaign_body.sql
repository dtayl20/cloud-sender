-- 0005_campaign_body.sql — base templates + per-campaign body content.
--
-- Additive only. Existing data keeps working exactly as before:
--   * campaigns.body_html IS NULL  -> today's behaviour (the template is sent as-is)
--   * templates.is_base defaults 0 -> every existing template stays a normal template
--
-- A base template supplies the chrome (header/footer/styles) and marks where the
-- campaign body goes with a {{content}} slot. The campaign supplies the body.

ALTER TABLE campaigns ADD COLUMN body_html TEXT;
ALTER TABLE templates ADD COLUMN is_base INTEGER NOT NULL DEFAULT 0;

-- Default base template (matches the Worker's
-- DEFAULT_FROM_EMAIL). Idempotent: inserted only when no base template with
-- this name exists yet.
INSERT INTO templates (source, external_id, name, subject, html, text, is_base)
SELECT
  'local',
  NULL,
  'Base template',
  'Example Co',
  '<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Example Co</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#f1f5f9;">
<tr>
<td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid #e2e8f0;border-radius:8px;">
<tr>
<td style="padding:20px 28px;background-color:#0f766e;font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:bold;color:#ffffff;">Example Co</td>
</tr>
<tr>
<td style="padding:28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1e293b;">{{content}}</td>
</tr>
<tr>
<td style="padding:18px 28px;background-color:#f8fafc;border-top:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#64748b;">
You are receiving this email from Example Co.
<br />Not relevant? Reply to this email and we will take you off the list.
<br /><a href="https://example.com" style="color:#0f766e;">example.com</a>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>',
  '{{content}}

--
LocalDentists.au
https://localdentists.au',
  1
WHERE NOT EXISTS (
  SELECT 1 FROM templates WHERE name = 'Base template' AND is_base = 1
);
