/**
 * GHL engagement write-back — mirror an email open/click onto the GHL contact.
 *
 * Called from the SMTP2Go callback (`POST /api/webhooks/smtp2go`) once the
 * `sends` row has been stamped. A tag (`email_opened` / `email_clicked`) plus a
 * dated note let Damon see engagement on the contact record in GHL.
 *
 * Everything here is best-effort: the caller wraps it in try/catch and the
 * webhook still answers 200. The token never reaches the logs, and only the
 * contact id (not the address) is ever reported back.
 *
 * Repeat opens/clicks are common, so the caller stamps a per-direction flag on
 * the send row (`ghl_open_noted_at` / `ghl_click_noted_at`) and skips a second
 * write. The flag is left unset when GHL errors, so a later event retries.
 */
import type { Env } from "./types";

export const GHL_DEFAULTS = {
  base: "https://services.leadconnectorhq.com",
  locationId: "4RCtnflQWYDE2whrQGyf",
  openTag: "email_opened",
  clickTag: "email_clicked",
} as const;

const GHL_API_VERSION = "2021-07-28";
const GHL_TIMEOUT_MS = 8000;
// GHL sits behind Cloudflare, which answers 1010 to requests without a
// browser-ish User-Agent. A plain API client is rejected with no useful error.
const GHL_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export interface GhlConfig {
  base: string;
  locationId: string;
  openTag: string;
  clickTag: string;
}

/** Resolve the GHL settings from env, falling back to the committed defaults. */
export function ghlConfig(env: Env): GhlConfig {
  return {
    base: (env.GHL_API_BASE?.trim() || GHL_DEFAULTS.base).replace(/\/+$/, ""),
    locationId: env.GHL_LOCATION_ID?.trim() || GHL_DEFAULTS.locationId,
    openTag: env.GHL_OPEN_TAG?.trim() || GHL_DEFAULTS.openTag,
    clickTag: env.GHL_CLICK_TAG?.trim() || GHL_DEFAULTS.clickTag,
  };
}

/** The write-back needs a token; without one it is a no-op (never a failure). */
export function ghlConfigured(env: Env): boolean {
  return Boolean(env.GHL_API_KEY && env.GHL_API_KEY.trim());
}

function ghlHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.GHL_API_KEY}`,
    Version: GHL_API_VERSION,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": GHL_USER_AGENT,
  };
}

interface GhlResponse {
  ok: boolean;
  status: number;
  body: any;
}

async function ghl(
  env: Env,
  config: GhlConfig,
  path: string,
  init: RequestInit = {},
): Promise<GhlResponse> {
  const res = await fetch(`${config.base}${path}`, {
    ...init,
    headers: { ...ghlHeaders(env), ...((init.headers as Record<string, string>) ?? {}) },
    signal: AbortSignal.timeout(GHL_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 300);
    }
  }
  return { ok: res.ok, status: res.status, body };
}

/**
 * Find a contact id by email. The search filter has been unreliable, so the
 * exact email is verified client-side and the list endpoint is a fallback.
 * Returns null when nothing matches; never throws.
 */
export async function ghlFindContactId(
  env: Env,
  config: GhlConfig,
  email: string,
): Promise<string | null> {
  const wanted = (email ?? "").trim().toLowerCase();
  if (!wanted) return null;

  const attempts: Array<() => Promise<GhlResponse>> = [
    () =>
      ghl(env, config, "/contacts/search/", {
        method: "POST",
        body: JSON.stringify({ locationId: config.locationId, query: email, pageLimit: 20 }),
      }),
    () =>
      ghl(
        env,
        config,
        `/contacts/?locationId=${encodeURIComponent(config.locationId)}&query=${encodeURIComponent(email)}`,
        { method: "GET" },
      ),
  ];

  for (const attempt of attempts) {
    const r = await attempt();
    if (!r.ok) continue;
    const list: any[] = Array.isArray(r.body?.contacts) ? r.body.contacts : [];
    const hit = list.find(
      (c) => typeof c?.email === "string" && c.email.trim().toLowerCase() === wanted,
    );
    if (hit?.id) return String(hit.id);
  }
  return null;
}

/** Add a tag. GHL treats this as idempotent, so re-adding the same tag is safe. */
export async function ghlAddTag(
  env: Env,
  config: GhlConfig,
  contactId: string,
  tag: string,
): Promise<boolean> {
  if (!tag) return true;
  const r = await ghl(env, config, `/contacts/${encodeURIComponent(contactId)}/tags`, {
    method: "POST",
    body: JSON.stringify({ tags: [tag] }),
  });
  return r.ok;
}

/** Create a note on the contact. */
export async function ghlAddNote(
  env: Env,
  config: GhlConfig,
  contactId: string,
  body: string,
): Promise<boolean> {
  const r = await ghl(env, config, `/contacts/${encodeURIComponent(contactId)}/notes`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
  return r.ok;
}

/** `YYYY-MM-DD HH:MM UTC` — unambiguous wherever the contact is read. */
export function formatUtc(seconds: number): string {
  const d = new Date(seconds * 1000);
  const iso = Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** The note text: `Opened "<subject>" — <when>` / `Clicked <url> in "<subject>"`. */
export function engagementNote(
  kind: "open" | "click",
  subject: string | null | undefined,
  url: string | null | undefined,
  seconds: number,
): string {
  const subj = (subject ?? "").trim();
  if (kind === "click") {
    const link = (url ?? "").trim();
    if (link && subj) return `Clicked ${link} in "${subj}"`;
    if (link) return `Clicked ${link}`;
    return subj ? `Clicked a link in "${subj}"` : "Clicked a link";
  }
  return subj
    ? `Opened "${subj}" — ${formatUtc(seconds)}`
    : `Opened an email — ${formatUtc(seconds)}`;
}

export interface EngagementInput {
  kind: "open" | "click";
  email: string;
  /** Known GHL contact id (from the send row); skips the email lookup. */
  ghlContactId?: string | null;
  subject?: string | null;
  url?: string | null;
  /** Event time in epoch seconds; defaults to now. */
  occurredAt?: number | null;
}

export interface EngagementResult {
  status: "written" | "skipped" | "no_contact" | "error";
  contactId?: string | null;
  detail?: string;
}

/**
 * Resolve the contact, then write the tag + note. The tag goes first because it
 * is idempotent; the note is only reported written when both calls succeed.
 */
export async function writeEngagement(
  env: Env,
  input: EngagementInput,
): Promise<EngagementResult> {
  if (!ghlConfigured(env)) return { status: "skipped", detail: "not_configured" };
  const config = ghlConfig(env);
  try {
    const contactId =
      input.ghlContactId?.trim() || (await ghlFindContactId(env, config, input.email));
    if (!contactId) return { status: "no_contact" };

    const tag = input.kind === "click" ? config.clickTag : config.openTag;
    const note = engagementNote(
      input.kind,
      input.subject,
      input.url,
      input.occurredAt && Number.isFinite(input.occurredAt)
        ? input.occurredAt
        : Math.floor(Date.now() / 1000),
    );

    const tagOk = await ghlAddTag(env, config, contactId, tag);
    const noteOk = await ghlAddNote(env, config, contactId, note);
    if (tagOk && noteOk) return { status: "written", contactId };
    return { status: "error", contactId, detail: `tag=${tagOk} note=${noteOk}` };
  } catch (error) {
    return { status: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}

export interface WebhookEngagement {
  kind: "open" | "click";
  email: string;
  smtp2goId: string | number | null;
  subject?: string | null;
  url?: string | null;
  occurredAt?: number | null;
}

/** The flag column for a direction. Kept as a literal whitelist (no injection). */
const NOTED_COLUMN = { open: "ghl_open_noted_at", click: "ghl_click_noted_at" } as const;

/**
 * The entry point the SMTP2Go handler calls. Finds the send this event belongs
 * to, skips a repeat, writes back, and stamps the flag. Never throws.
 */
export async function applyEngagementWriteBack(
  env: Env,
  input: WebhookEngagement,
): Promise<EngagementResult | null> {
  if (!ghlConfigured(env)) return null;

  const row = await env.DB.prepare(
    `SELECT s.id, s.ghl_contact_id, s.ghl_open_noted_at, s.ghl_click_noted_at,
            c.ghl_contact_id AS contact_ghl_contact_id
       FROM sends s
       LEFT JOIN contacts c ON c.id = s.contact_id
      WHERE s.smtp2go_id = ? AND lower(s.email) = lower(?)
      ORDER BY s.id DESC LIMIT 1`,
  )
    .bind(input.smtp2goId ?? null, input.email)
    .first<{
      id: number;
      ghl_contact_id: string | null;
      ghl_open_noted_at: number | null;
      ghl_click_noted_at: number | null;
      contact_ghl_contact_id: string | null;
    }>();
  if (!row) return null;

  const column = NOTED_COLUMN[input.kind];
  const already = input.kind === "click" ? row.ghl_click_noted_at : row.ghl_open_noted_at;
  if (already != null) return { status: "skipped", detail: "already_written" };

  const result = await writeEngagement(env, {
    kind: input.kind,
    email: input.email,
    ghlContactId: row.ghl_contact_id || row.contact_ghl_contact_id || null,
    subject: input.subject,
    url: input.url,
    occurredAt: input.occurredAt,
  });

  if (result.status === "written") {
    // Remember the resolved id so later events skip the email lookup.
    if (!row.ghl_contact_id && result.contactId) {
      await env.DB.prepare("UPDATE sends SET ghl_contact_id = ? WHERE id = ?")
        .bind(result.contactId, row.id)
        .run();
    }
    await env.DB.prepare(`UPDATE sends SET ${column} = unixepoch() WHERE id = ?`)
      .bind(row.id)
      .run();
  } else if (result.status === "no_contact") {
    // Nothing to write, and re-querying GHL on every repeat open is wasteful:
    // stamp it so this direction is not attempted again.
    await env.DB.prepare(`UPDATE sends SET ${column} = unixepoch() WHERE id = ?`)
      .bind(row.id)
      .run();
  }
  // status "error" (or "skipped"): leave the flag NULL so the next event retries.

  return result;
}
