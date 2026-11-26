import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "./types";
import { smtp2goSend } from "./smtp2go";
import { senderLine } from "./sendPayload";
import { buildClinicReportMail, validateClinicReport } from "./clinicReport";
import { buildTemplateData, validateSendTemplate } from "./sendTemplate";
import { ensureGhlTagTriggerCampaign } from "./ghlCampaign";
import { applyEngagementWriteBack } from "./ghl";
import { stopContactSequences } from "./sequences";
import { handleFormSubmission, validateFormSubmission } from "./formSubmission";

export const webhooksRoutes = new Hono<{ Bindings: Env }>();

const CLINIC_REPORT_FROM_DEFAULT = "reports@localdentists.au";
const SEND_TEMPLATE_FROM_DEFAULT = "listing@localdentists.au";

// Token check for the /api/webhooks routes GHL calls. Same three accepted forms
// as the clinic-report route: ?token=..., X-Webhook-Token: ..., or Bearer ...
// (GHL's webhook action and SMTP2GO differ in which one they can send).
function webhookTokenOk(c: Context<{ Bindings: Env }>): boolean {
  const auth = c.req.header("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const token = c.req.query("token") ?? c.req.header("X-Webhook-Token") ?? bearer;
  const expected = [c.env.WEBHOOK_TOKEN, c.env.REPORT_SEND_TOKEN].filter(Boolean) as string[];
  return Boolean(token && expected.includes(token));
}

// Called by the GHL workflow when the voice agent is asked for the report again.
// Token-gated (same WEBHOOK_TOKEN as the SMTP2GO callback) and lives under
// /api/webhooks/* so it rides the existing Cloudflare Access bypass.
webhooksRoutes.post("/clinic-report", async (c) => {
  // Three accepted forms: ?token=..., X-Webhook-Token: ..., or Authorization: Bearer ...
  // (GHL's webhook action and SMTP2GO differ in which one they can send).
  const auth = c.req.header("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const token = c.req.query("token") ?? c.req.header("X-Webhook-Token") ?? bearer;
  const expected = [c.env.WEBHOOK_TOKEN, c.env.REPORT_SEND_TOKEN].filter(Boolean) as string[];
  if (!token || !expected.includes(token)) {
    return c.text("forbidden", 403);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const validation = validateClinicReport(body);
  if (!validation.ok) {
    return c.json({ error: "validation_failed", errors: validation.errors }, 400);
  }
  const v = validation.values;

  const fromEmail = (c.env.REPORT_FROM_EMAIL ?? c.env.DEFAULT_FROM_EMAIL ?? CLINIC_REPORT_FROM_DEFAULT).trim();
  const fromName = c.env.REPORT_FROM_NAME ?? "LocalDentists.au";
  if (!c.env.SMTP2GO_API_KEY || !fromEmail) {
    console.error("clinic-report misconfigured: smtp2go key or sender missing");
    return c.json({ error: "not_configured" }, 503);
  }

  const templateId = (v.template_id || c.env.REPORT_TEMPLATE_ID || "").trim();
  // Nobody should read "Hi ," — an unknown first name falls back to a neutral greeting.
  const name = v.name || "there";
  const mail = buildClinicReportMail({ ...v, name });
  const base = {
    to: [v.email],
    sender: senderLine(fromName, fromEmail),
    // reply_to at the top level is silently dropped by SMTP2GO (see smtp2go.ts).
    custom_headers: [{ header: "Reply-To", value: fromEmail }],
  };
  try {
    const result = await smtp2goSend(
      c.env.SMTP2GO_API_KEY,
      templateId
        // The SMTP2GO template carries the copy and subject; we only supply the variables.
        ? {
            ...base,
            template_id: templateId,
            template_data: {
              clinic_name: v.clinic_name,
              name,
              report_url: v.report_url,
            },
          }
        : { ...base, subject: mail.subject, text_body: mail.text, html_body: mail.html },
    );
    const data = result?.data;
    if (data && data.failed && !data.succeeded) {
      console.error("clinic-report send failed:", data.error ?? data.failures ?? "unknown");
      return c.json({ error: "send_failed" }, 502);
    }
  } catch (error) {
    console.error("clinic-report send threw:", error instanceof Error ? error.message : error);
    return c.json({ error: "send_failed" }, 502);
  }

  // No clinic name or address in the logs — just the shape of the call.
  console.log(`clinic-report sent ${JSON.stringify({ urlHost: new URL(v.report_url).hostname, named: Boolean(v.name) })}`);
  return c.json({ ok: true });
});

// One SMTP2GO template, one contact, triggered by a GHL tag.
//
// The GHL workflow applies a tag (e.g. send_playbook, send_ld_general_info) and
// calls this endpoint with the contact's GHL id and email. The tag picks the
// SMTP2GO template; the send is recorded on the `sends` table with the SMTP2GO
// message id and the GHL contact id, so the existing open/click callback can
// stamp opened_at/clicked_at on the row and a later write-back can find the
// contact. Token-gated exactly like clinic-report and under /api/webhooks/*, so
// it rides the existing Cloudflare Access bypass.
webhooksRoutes.post("/send-template", async (c) => {
  if (!webhookTokenOk(c)) {
    return c.text("forbidden", 403);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const validation = validateSendTemplate(body);
  if (!validation.ok) {
    return c.json({ error: "validation_failed", errors: validation.errors }, 400);
  }
  const v = validation.values;

  const fromEmail = (c.env.DEFAULT_FROM_EMAIL ?? SEND_TEMPLATE_FROM_DEFAULT).trim();
  const fromName = c.env.DEFAULT_FROM_NAME ?? "LocalDentists.au";
  if (!c.env.SMTP2GO_API_KEY || !fromEmail) {
    console.error("send-template misconfigured: smtp2go key or sender missing");
    return c.json({ error: "not_configured" }, 503);
  }

  // Never mail a suppressed/bounced/complained address.
  const suppressed = await c.env.DB.prepare("SELECT reason FROM suppressions WHERE email=?")
    .bind(v.email)
    .first<{ reason: string }>();
  if (suppressed) {
    return c.json({ error: "suppressed", reason: suppressed.reason }, 409);
  }

  // Upsert the contact by email and store the GHL id, so the write-back half
  // (and any future send) can find the row. Existing fields are kept when the
  // payload does not supply them.
  const contact = await c.env.DB.prepare(
    `INSERT INTO contacts (email, first_name, practice_name, ghl_contact_id, source)
     VALUES (?,?,?,?, 'ghl')
     ON CONFLICT(email) DO UPDATE SET
       first_name = COALESCE(excluded.first_name, contacts.first_name),
       practice_name = COALESCE(excluded.practice_name, contacts.practice_name),
       ghl_contact_id = excluded.ghl_contact_id,
       updated_at = unixepoch()
     RETURNING id`,
  )
    .bind(v.email, v.first_name || null, v.clinic_name || null, v.ghl_contact_id)
    .first<{ id: number }>();
  const contactId = contact?.id ?? null;

  // The send row is written before the call, so the SMTP2GO callback (which
  // matches on email + smtp2go_id) has a row to stamp opened_at/clicked_at on.
  // It points at the shared "GHL tag triggers" container campaign so the send
  // (and its opens/clicks) is visible in the UI instead of hiding with
  // campaign_id = NULL. The container is never dispatched - see ghlCampaign.ts.
  const campaignId = await ensureGhlTagTriggerCampaign(c.env);
  const send = await c.env.DB.prepare(
    "INSERT INTO sends (campaign_id, contact_id, email, status, ghl_contact_id) VALUES (?,?,?,'queued',?) RETURNING id",
  )
    .bind(campaignId, contactId, v.email, v.ghl_contact_id)
    .first<{ id: number }>();
  const sendId = send?.id;
  if (sendId == null) {
    return c.json({ error: "send_row_failed" }, 500);
  }

  try {
    const result = await smtp2goSend(c.env.SMTP2GO_API_KEY, {
      to: [v.email],
      sender: senderLine(fromName, fromEmail),
      // The SMTP2GO template carries the subject and copy; we supply the variables.
      template_id: v.template_id,
      template_data: buildTemplateData(v.first_name, v.clinic_name, v.fields),
      // reply_to at the top level is silently dropped by SMTP2GO (see smtp2go.ts).
      custom_headers: [{ header: "Reply-To", value: fromEmail }],
    });
    const data = result?.data;
    if (data && data.failed && !data.succeeded) {
      const detail = String(data.error ?? data.failures ?? "unknown").slice(0, 500);
      await c.env.DB.prepare("UPDATE sends SET status='failed', error=? WHERE id=?")
        .bind(detail, sendId)
        .run();
      console.error("send-template send failed:", detail);
      return c.json({ error: "send_failed" }, 502);
    }
    const emailId = data?.email_id ?? result?.request_id ?? null;
    await c.env.DB.prepare(
      "UPDATE sends SET status='sent', sent_at=unixepoch(), smtp2go_id=? WHERE id=?",
    )
      .bind(emailId, sendId)
      .run();
    // No address or name in the logs — just the shape of the call.
    console.log(
      `send-template sent ${JSON.stringify({ template_id: v.template_id, tagged: Boolean(v.tag) })}`,
    );
    return c.json({ ok: true, send_id: sendId });
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    await c.env.DB.prepare("UPDATE sends SET status='failed', error=? WHERE id=?")
      .bind(detail, sendId)
      .run();
    console.error("send-template send threw:", detail);
    return c.json({ error: "send_failed" }, 502);
  }
});

// Website form submissions. The forms team posts one fixed payload per
// submission (see formSubmission.ts): idempotent on submission_id, verifies the
// address inline, upserts the contact, records consent, and enrols into the
// sequence mapped to the form_slug - capturing and holding while that sequence
// is still a draft. Token-gated exactly like the routes above and under
// /api/webhooks/* so it rides the existing Cloudflare Access bypass.
webhooksRoutes.post("/form-submission", async (c) => {
  if (!webhookTokenOk(c)) {
    return c.text("forbidden", 403);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const validation = validateFormSubmission(body);
  if (!validation.ok || !validation.values) {
    return c.json({ error: "validation_failed", errors: validation.errors }, 400);
  }

  const result = await handleFormSubmission(c.env, validation.values);
  return c.json(result);
});

// SMTP2GO posts JSON; configure URL like
//   https://your.worker.dev/api/webhooks/smtp2go?token=YOUR_WEBHOOK_TOKEN
webhooksRoutes.post("/smtp2go", async (c) => {
  const token = c.req.query("token");
  if (!token || token !== c.env.WEBHOOK_TOKEN) {
    return c.text("forbidden", 403);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.text("bad json", 400);
  }

  // SMTP2GO event shapes vary; normalise common fields
  const event = String(body.event ?? body.event_type ?? "unknown").toLowerCase();
  const email = String(body.email ?? body.rcpt ?? body.recipient ?? "").toLowerCase();
  const smtp2goId = body.email_id ?? body.id ?? null;

  // Store raw event always
  await c.env.DB.prepare(
    "INSERT INTO webhook_events (event_type, email, smtp2go_id, payload) VALUES (?,?,?,?)",
  )
    .bind(event, email || null, smtp2goId, JSON.stringify(body))
    .run();

  if (!email) return c.json({ ok: true });

  const stmts: D1PreparedStatement[] = [];
  // A hard bounce or an unsubscribe stops the WHOLE sequence for this contact
  // (below), standalone of GHL. Tracked here, applied after the batch.
  let stopSeqReason: string | null = null;

  // Match event → action. Every branch mirrors the campaign `sends` update onto
  // `sequence_sends` (matched on email + smtp2go_id), so a sequence step's
  // per-step metrics track opens/clicks/bounces exactly like a campaign send.
  if (event.includes("bounce")) {
    const isHard = String(body.bounce_type ?? body.type ?? "").toLowerCase().includes("hard");
    if (isHard) {
      stmts.push(suppress(c.env.DB, email, "bounce", JSON.stringify(body).slice(0, 500)));
      stmts.push(setContactStatus(c.env.DB, email, "bounced"));
      stopSeqReason = "bounce";
    }
    const reason = String(body.reason ?? "").slice(0, 500);
    stmts.push(
      c.env.DB.prepare("UPDATE sends SET status='bounced', bounced_at=unixepoch(), error=? WHERE email=? AND smtp2go_id=?")
        .bind(reason, email, smtp2goId),
    );
    stmts.push(
      c.env.DB.prepare("UPDATE sequence_sends SET status='bounced', bounced_at=unixepoch(), error=? WHERE email=? AND smtp2go_id=?")
        .bind(reason, email, smtp2goId),
    );
  } else if (event.includes("spam") || event.includes("complain")) {
    stmts.push(suppress(c.env.DB, email, "complaint", null));
    stmts.push(setContactStatus(c.env.DB, email, "complained"));
    stmts.push(
      c.env.DB.prepare("UPDATE sends SET status='complained' WHERE email=? AND smtp2go_id=?")
        .bind(email, smtp2goId),
    );
    stmts.push(
      c.env.DB.prepare("UPDATE sequence_sends SET status='complained' WHERE email=? AND smtp2go_id=?")
        .bind(email, smtp2goId),
    );
  } else if (event.includes("unsub")) {
    stmts.push(suppress(c.env.DB, email, "unsubscribe", null));
    stmts.push(setContactStatus(c.env.DB, email, "unsubscribed"));
    stopSeqReason = "unsubscribe";
    // Stamp the step that carried the unsubscribe, so per-step unsubscribe
    // counts are meaningful; fall back to the contact's latest sequence send.
    stmts.push(
      c.env.DB.prepare(
        `UPDATE sequence_sends SET unsubscribed_at=COALESCE(unsubscribed_at, unixepoch())
          WHERE email=? AND (? IS NOT NULL AND smtp2go_id=?)
             OR (id = (SELECT MAX(id) FROM sequence_sends WHERE email=?))`,
      ).bind(email, smtp2goId, smtp2goId, email),
    );
  } else if (event.includes("deliver")) {
    stmts.push(
      c.env.DB.prepare("UPDATE sends SET status='delivered', delivered_at=unixepoch() WHERE email=? AND smtp2go_id=?")
        .bind(email, smtp2goId),
    );
    stmts.push(
      c.env.DB.prepare("UPDATE sequence_sends SET status='delivered', delivered_at=unixepoch() WHERE email=? AND smtp2go_id=?")
        .bind(email, smtp2goId),
    );
  } else if (event.includes("open")) {
    stmts.push(
      c.env.DB.prepare("UPDATE sends SET opened_at=COALESCE(opened_at, unixepoch()) WHERE email=? AND smtp2go_id=?")
        .bind(email, smtp2goId),
    );
    stmts.push(
      c.env.DB.prepare("UPDATE sequence_sends SET opened_at=COALESCE(opened_at, unixepoch()) WHERE email=? AND smtp2go_id=?")
        .bind(email, smtp2goId),
    );
  } else if (event.includes("click")) {
    stmts.push(
      c.env.DB.prepare("UPDATE sends SET clicked_at=COALESCE(clicked_at, unixepoch()) WHERE email=? AND smtp2go_id=?")
        .bind(email, smtp2goId),
    );
    stmts.push(
      c.env.DB.prepare("UPDATE sequence_sends SET clicked_at=COALESCE(clicked_at, unixepoch()) WHERE email=? AND smtp2go_id=?")
        .bind(email, smtp2goId),
    );
  }

  if (stmts.length) {
    try {
      await c.env.DB.batch(stmts);
    } catch (e) {
      console.error("webhook batch failed", e);
    }
  }

  // Standalone sequence stop: an unsubscribe or hard bounce halts the WHOLE
  // sequence for the contact, regardless of any GHL tags or workflows.
  if (stopSeqReason) {
    try {
      await stopContactSequences(c.env, { email }, stopSeqReason);
    } catch (e) {
      console.error("sequence stop failed", e);
    }
  }

  // GHL write-back: mirror an open/click onto the contact (a tag + a note) so
  // engagement shows on the record in GHL. Best-effort by design - any failure
  // is swallowed here, because SMTP2Go must always get its 200 and the send row
  // above is already stamped.
  if (event.includes("open") || event.includes("click")) {
    try {
      await applyEngagementWriteBack(c.env, {
        kind: event.includes("click") ? "click" : "open",
        email,
        smtp2goId,
        subject: typeof body.subject === "string" ? body.subject : body.Subject,
        url: typeof body.url === "string" ? body.url : null,
        occurredAt: eventTime(body),
      });
    } catch (error) {
      // No address or token in the log - just the failure.
      console.error(
        "ghl write-back failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return c.json({ ok: true });
});

/** SMTP2Go carries an ISO timestamp per event; turn it into epoch seconds. */
function eventTime(body: any): number | null {
  const raw = body["opened-at"] ?? body["clicked-at"] ?? body.time ?? body.sendtime ?? null;
  if (typeof raw !== "string" || !raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function suppress(db: D1Database, email: string, reason: string, detail: string | null) {
  return db
    .prepare(
      "INSERT INTO suppressions (email, reason, source, detail) VALUES (?,?,?,?) ON CONFLICT(email) DO UPDATE SET reason=excluded.reason, detail=excluded.detail",
    )
    .bind(email, reason, "webhook", detail);
}
function setContactStatus(db: D1Database, email: string, status: string) {
  return db
    .prepare("UPDATE contacts SET status=?, updated_at=unixepoch() WHERE email=?")
    .bind(status, email);
}
