import { Hono } from "hono";
import type { Env } from "../types";
import { DEFAULT_SEND_TIMEZONE } from "../../shared/sendPlan";

export const settingsRoutes = new Hono<{ Bindings: Env }>();

settingsRoutes.get("/", async (c) => {
  const obj: Record<string, unknown> = {};

  obj.db_configured = Boolean(c.env.DB);
  obj.settings_table_configured = false;
  if (c.env.DB) {
    try {
      const rows = await c.env.DB.prepare("SELECT key, value FROM settings").all<{
        key: string;
        value: string;
      }>();
      obj.settings_table_configured = true;
      for (const r of rows.results ?? []) {
        try {
          obj[r.key] = JSON.parse(r.value);
        } catch {
          obj[r.key] = r.value;
        }
      }
    } catch (error) {
      obj.settings_error = getSafeErrorMessage(error);
    }
  }
  // Surface env defaults (read-only)
  obj.env_default_from_email = c.env.DEFAULT_FROM_EMAIL ?? "";
  obj.env_default_from_name = c.env.DEFAULT_FROM_NAME ?? "";
  // Verification pause switch: the env override (the email_verify_paused
  // settings key is already surfaced by the wholesale settings dump above).
  obj.env_verify_paused = /^(1|true|yes|on)$/i.test(String(c.env.VERIFY_PAUSED ?? "").trim());
  // The zone a campaign's daily-batch window is measured in unless the campaign
  // overrides it. Shown verbatim in the campaign editor so "10:00" is never
  // ambiguous.
  obj.env_default_send_timezone = c.env.SEND_TIMEZONE || DEFAULT_SEND_TIMEZONE;
  obj.expected_bindings = {
    db: "DB",
    source_db: "SOURCE_DB",
    send_queue: "SEND_QUEUE",
  };
  obj.expected_secrets = {
    smtp2go_api_key: "SMTP2GO_API_KEY",
    webhook_token: "WEBHOOK_TOKEN",
  };
  obj.smtp2go_configured = typeof c.env.SMTP2GO_API_KEY === "string" && c.env.SMTP2GO_API_KEY.trim().length > 0;
  obj.webhook_token_configured = typeof c.env.WEBHOOK_TOKEN === "string" && c.env.WEBHOOK_TOKEN.trim().length > 0;
  obj.source_db_configured = Boolean(c.env.SOURCE_DB);
  obj.send_queue_configured = Boolean(c.env.SEND_QUEUE);
  return c.json(obj);
});

settingsRoutes.put("/:key", async (c) => {
  const key = c.req.param("key");
  const body = await c.req.json();
  if (!c.env.DB) {
    return c.json({ error: "DB binding is not configured" }, 503);
  }
  await c.env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=unixepoch()",
  )
    .bind(key, JSON.stringify(body.value))
    .run();
  return c.json({ ok: true });
});

function getSafeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.toLowerCase().includes("no such table")) {
    return "D1 migrations have not been applied yet; settings table is missing.";
  }
  return message || "Unable to read settings from D1.";
}
