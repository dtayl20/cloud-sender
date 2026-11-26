import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, SendJob } from "./types";
import { contactsRoutes } from "./routes/contacts";
import { suppressionsRoutes } from "./routes/suppressions";
import { templatesRoutes } from "./routes/templates";
import { smtp2goRoutes } from "./routes/smtp2go";
import { campaignsRoutes } from "./routes/campaigns";
import { importsRoutes } from "./routes/imports";
import { settingsRoutes } from "./routes/settings";
import { senderIdentitiesRoutes } from "./routes/senderIdentities";
import { tagsRoutes } from "./routes/tags";
import { listsRoutes } from "./routes/lists";
import { sourceDbRoutes } from "./routes/source_db";
import { deliverabilityRoutes } from "./routes/deliverability";
import { contactRoutes } from "./routes/contact";
import { sequencesRoutes } from "./routes/sequences";
import { webhooksRoutes } from "./webhooks";
import { processSendBatch } from "./consumer";
import { verifyPendingContacts } from "./emailVerify";
import { syncAll } from "./sync";
import { dispatchDueCampaigns } from "./routes/campaigns";
import { dispatchSequences } from "./sequences";

const app = new Hono<{ Bindings: Env }>();
// Blanket CORS for the app's own API. /api/contact is excluded: it is public
// (the rest is behind Cloudflare Access), so it sets its own origin allowlist in
// routes/contact.ts rather than inheriting `Access-Control-Allow-Origin: *`.
const apiCors = cors();
app.use("/api/*", (c, next) =>
  c.req.path.startsWith("/api/contact") ? next() : apiCors(c, next),
);

app.onError((err, c) => {
  console.error("API error", c.req.method, c.req.path, err);
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  return c.json({ error: message, where: `${c.req.method} ${c.req.path}`, stack }, 500);
});

app.get("/api/me", (c) => {
  const email = c.req.header("Cf-Access-Authenticated-User-Email") ?? "anonymous@local";
  return c.json({ email });
});
app.get("/api/health", (c) => c.json({ ok: true }));

app.route("/api/contacts", contactsRoutes);
app.route("/api/suppressions", suppressionsRoutes);
app.route("/api/templates", templatesRoutes);
app.route("/api/smtp2go", smtp2goRoutes);
app.route("/api/campaigns", campaignsRoutes);
app.route("/api/imports", importsRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/sender-identities", senderIdentitiesRoutes);
app.route("/api/tags", tagsRoutes);
app.route("/api/lists", listsRoutes);
app.route("/api/source-db", sourceDbRoutes);
app.route("/api/deliverability", deliverabilityRoutes);
app.route("/api/contact", contactRoutes);
app.route("/api/sequences", sequencesRoutes);
app.route("/api/webhooks", webhooksRoutes);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return app.fetch(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },

  async queue(batch: MessageBatch<SendJob>, env: Env): Promise<void> {
    await processSendBatch(batch, env);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Dispatch due scheduled campaigns every minute.
    ctx.waitUntil(
      dispatchDueCampaigns(env)
        .then((r) => console.log("cron dispatch", JSON.stringify(r)))
        .catch((err) => console.error("cron dispatch failed", err)),
    );
    // Verify a slice of the pending contacts every minute. Strictly sequential
    // and capped at 25, matching the API's 1500/hour, one-thread limit; a no-op
    // when BULK_EMAIL_CHECKER_API is unset.
    ctx.waitUntil(
      verifyPendingContacts(env).catch((err) => console.error("cron verify failed", err)),
    );
    // Dispatch due sequence steps every minute, under a single-flight lease so a
    // slow tick cannot overlap the next (same discipline as the verify pass).
    ctx.waitUntil(
      dispatchSequences(env)
        .then((r) => {
          if (r.released > 0 || r.skipped) console.log("cron sequences", JSON.stringify(r));
        })
        .catch((err) => console.error("cron sequences failed", err)),
    );
    // Source-DB mirror sync stays hourly (top of the hour).
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    if (minute === 0) {
      ctx.waitUntil(
        syncAll(env)
          .then((results) => console.log("cron sync", JSON.stringify(results)))
          .catch((err) => console.error("cron sync failed", err)),
      );
    }
  },
};
