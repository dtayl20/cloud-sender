/**
 * The public contact endpoint — `POST /api/contact`.
 *
 * This is the only unauthenticated, mail-sending route on the Worker (everything
 * else under /api is behind Cloudflare Access), so it is written defensively:
 *
 *   - the recipient is the CONTACT_TO_EMAIL variable, never the request. The
 *     route is not an open relay: `to`, `from`, `cc`, `bcc`, `subject` and any
 *     other header in the body are ignored entirely.
 *   - the body is validated server-side (required fields, length caps, email
 *     shape) and a bad submission is a 400 with per-field errors.
 *   - a filled honeypot is dropped silently with the same 200 a real visitor
 *     gets, so the trap is never advertised.
 *   - per-IP rate limiting over a rolling window, keyed by a salted hash of the
 *     address (see migrations/0012_contact_rate.sql) — no address is stored.
 *   - the mail is built here: a plain-text part and an HTML part whose every
 *     interpolated value is escaped, so nothing a submitter types can become
 *     markup.
 *
 * Cloudflare Access must bypass this path or the site's POST is redirected to a
 * login page instead of reaching the Worker — see README "Contact form".
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../types";
import { smtp2goSend } from "../smtp2go";
import { senderLine } from "../sendPayload";

export const CONTACT_TO_EMAIL_DEFAULT = "you@example.com";

/** Hard cap on what each field may carry. Anything longer is refused, not trimmed. */
export const CONTACT_LIMITS = {
  name: 100,
  email: 254,
  phone: 40,
  message: 5000,
} as const;

export const CONTACT_HONEYPOT_FIELD = "hp_field";

export const DEFAULT_RATE_LIMIT = 5;
export const DEFAULT_RATE_WINDOW_SECONDS = 600;

/** The sites allowed to post here from a browser. */
const CONTACT_ORIGINS = [
  "https://example.com",
  "https://www.example.com",
  "https://your-site.pages.dev",
];

/** Read the optional comma-separated CONTACT_ALLOWED_ORIGINS variable. */
function extraOrigins(env: Env): string[] {
  return (env.CONTACT_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export function isAllowedOrigin(
  origin: string,
  extra: string[] = [],
  previewSuffix: string = "",
): boolean {
  if (!origin) return false;
  if (CONTACT_ORIGINS.includes(origin) || extra.includes(origin)) return true;
  try {
    const url = new URL(origin);
    // Preview builds get a fresh subdomain each time.
    if (previewSuffix && url.hostname.endsWith(previewSuffix)) return true;
    // Local dev, any port (`npm run dev` serves on 8080).
    if (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface ContactInput {
  name: string;
  email: string;
  phone: string;
  message: string;
}

export interface ContactValidation {
  ok: boolean;
  errors: Record<string, string>;
  values: ContactInput;
}

/**
 * Server-side validation. The browser validates too, but a browser is not a
 * control — this is the one that decides.
 */
export function validateContactInput(body: unknown): ContactValidation {
  const errors: Record<string, string> = {};
  const raw = (body ?? {}) as Record<string, unknown>;

  const str = (key: string): string =>
    typeof raw[key] === "string" ? (raw[key] as string).trim() : "";

  const name = str("name");
  const email = str("email");
  const phone = str("phone");
  const message = str("message");

  if (!name) errors.name = "required";
  else if (name.length > CONTACT_LIMITS.name) errors.name = "too_long";

  if (!email) errors.email = "required";
  else if (email.length > CONTACT_LIMITS.email) errors.email = "too_long";
  else if (!EMAIL_SHAPE.test(email)) errors.email = "invalid";

  if (phone) {
    if (phone.length > CONTACT_LIMITS.phone) errors.phone = "too_long";
    else if (phone.replace(/[^0-9]/g, "").length < 6) errors.phone = "invalid";
  }

  if (!message) errors.message = "required";
  else if (message.length > CONTACT_LIMITS.message) errors.message = "too_long";

  return { ok: Object.keys(errors).length === 0, errors, values: { name, email, phone, message } };
}

/** Escape for HTML text position. Everything interpolated into the mail goes through this. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface ContactMail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Build the mail server-side. The subject carries the submitter's name, so it is
 * flattened to a single line first — a newline in a subject is a header
 * injection.
 */
export function buildContactMail(input: ContactInput, now: Date = new Date()): ContactMail {
  const oneLine = (v: string) => v.replace(/[\r\n]+/g, " ").trim();
  const subject = `Website enquiry from ${oneLine(input.name).slice(0, 80)}`.slice(0, 160);
  const submittedAt = now.toISOString();
  const phone = input.phone || "not provided";

  const text = [
    "New enquiry from the Peak Marketing Systems website.",
    "",
    `Name:     ${input.name}`,
    `Email:    ${input.email}`,
    `Phone:    ${phone}`,
    "",
    "Message:",
    input.message,
    "",
    `Submitted: ${submittedAt}`,
  ].join("\n");

  const row = (label: string, value: string) =>
    `<tr><td style="padding:4px 12px 4px 0;vertical-align:top;color:#666">${escapeHtml(
      label,
    )}</td><td style="padding:4px 0;vertical-align:top">${escapeHtml(value)}</td></tr>`;

  const html = [
    '<h2 style="margin:0 0 12px">New website enquiry</h2>',
    '<table style="border-collapse:collapse;font:14px/1.5 system-ui,sans-serif">',
    row("Name", input.name),
    row("Email", input.email),
    row("Phone", phone),
    row("Submitted", submittedAt),
    "</table>",
    '<h3 style="margin:20px 0 6px">Message</h3>',
    // Escaped first, then newlines become <br /> — so the only markup in the
    // message block is the one we added.
    `<div style="white-space:pre-wrap;font:14px/1.6 system-ui,sans-serif">${escapeHtml(
      input.message,
    ).replace(/\r?\n/g, "<br />")}</div>`,
  ].join("\n");

  return { subject, text, html };
}

/** The address a submission came from, as Cloudflare reports it. */
export function clientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/** Pseudonymous key for the rate limiter: salted SHA-256 of the address, hex. */
export async function ipHash(ip: string, salt: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${ip}|${salt}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  retryAfter: number;
}

/**
 * Rolling-window counter. A row's window restarts once it has elapsed, so one
 * row per address is all that is ever needed.
 */
export async function checkRateLimit(
  db: D1Database,
  hashedIp: string,
  opts: { limit: number; windowSeconds: number; now: number },
): Promise<RateLimitResult> {
  const existing = await db
    .prepare("SELECT window_start, count FROM contact_rate WHERE ip_hash = ?")
    .bind(hashedIp)
    .first<{ window_start: number; count: number }>();

  const elapsed = existing ? opts.now - existing.window_start : Infinity;

  if (!existing || elapsed >= opts.windowSeconds) {
    await db
      .prepare(
        `INSERT INTO contact_rate (ip_hash, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT(ip_hash) DO UPDATE SET window_start = excluded.window_start, count = 1`,
      )
      .bind(hashedIp, opts.now)
      .run();
    return { allowed: true, count: 1, retryAfter: 0 };
  }

  if (existing.count >= opts.limit) {
    return {
      allowed: false,
      count: existing.count,
      retryAfter: Math.max(1, opts.windowSeconds - elapsed),
    };
  }

  await db
    .prepare("UPDATE contact_rate SET count = count + 1 WHERE ip_hash = ?")
    .bind(hashedIp)
    .run();
  return { allowed: true, count: existing.count + 1, retryAfter: 0 };
}

function intVar(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const contactRoutes = new Hono<{ Bindings: Env }>();

// Route-scoped CORS: configured origins, an optional preview suffix and localhost
// only. The Worker's blanket /api/* CORS is skipped for this path (index.ts) so
// this is the only thing setting the header here.
contactRoutes.use("*", async (c, next) => {
  const extra = extraOrigins(c.env);
  return cors({
    origin: (origin) =>
    isAllowedOrigin(origin, extra, c.env.CONTACT_PREVIEW_SUFFIX ?? "") ? origin : undefined,
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    maxAge: 86400,
  })(c, next);
});

contactRoutes.post("/", async (c) => {
  const origin = c.req.header("Origin") ?? "";
  // Browsers always send Origin on a cross-origin POST. A present-but-unlisted
  // origin is refused outright; an absent one is a non-browser client, which
  // CORS cannot stop and the honeypot/rate limit handle instead.
  if (
    origin &&
    !isAllowedOrigin(origin, extraOrigins(c.env), c.env.CONTACT_PREVIEW_SUFFIX ?? "")
  ) {
    return c.json({ error: "origin_not_allowed" }, 403);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "invalid_json" }, 400);
  }

  // Honeypot: only a bot fills a field it cannot see. Answer exactly as a real
  // submission would and send nothing.
  const honeypot = (body as Record<string, unknown>)[CONTACT_HONEYPOT_FIELD];
  if (typeof honeypot === "string" && honeypot.trim() !== "") {
    console.log("contact rejected: honeypot");
    return c.json({ ok: true });
  }

  const validation = validateContactInput(body);
  if (!validation.ok) {
    return c.json({ error: "validation_failed", errors: validation.errors }, 400);
  }
  const values = validation.values;

  const salt = c.env.IP_SALT ?? "contact-salt-unset";
  const hashedIp = await ipHash(clientIp(c.req.raw), salt);
  const limit = intVar(c.env.CONTACT_RATE_LIMIT, DEFAULT_RATE_LIMIT);
  const windowSeconds = intVar(c.env.CONTACT_RATE_WINDOW_SECONDS, DEFAULT_RATE_WINDOW_SECONDS);
  const rate = await checkRateLimit(c.env.DB, hashedIp, {
    limit,
    windowSeconds,
    now: Math.floor(Date.now() / 1000),
  });
  if (!rate.allowed) {
    c.header("Retry-After", String(rate.retryAfter));
    console.log("contact rejected: rate limit");
    return c.json({ error: "rate_limited" }, 429);
  }

  const to = (c.env.CONTACT_TO_EMAIL ?? CONTACT_TO_EMAIL_DEFAULT).trim();
  const fromEmail = (c.env.CONTACT_FROM_EMAIL ?? c.env.DEFAULT_FROM_EMAIL ?? "").trim();
  const fromName = c.env.CONTACT_FROM_NAME ?? "Peak Marketing Systems";

  if (!c.env.SMTP2GO_API_KEY || !to || !fromEmail) {
    console.error("contact misconfigured: smtp2go key, recipient or sender missing");
    return c.json({ error: "not_configured" }, 503);
  }

  const mail = buildContactMail(values);

  try {
    const result = await smtp2goSend(c.env.SMTP2GO_API_KEY, {
      to: [to],
      sender: senderLine(fromName, fromEmail),
      subject: mail.subject,
      text_body: mail.text,
      html_body: mail.html,
      // Reply goes straight back to the submitter rather than the system sender.
      custom_headers: [{ header: "Reply-To", value: values.email }],
    });
    const data = result?.data;
    if (data && data.failed && !data.succeeded) {
      console.error("contact send failed:", data.error ?? data.failures ?? "unknown");
      return c.json({ error: "send_failed" }, 502);
    }
  } catch (error) {
    console.error("contact send threw:", error instanceof Error ? error.message : error);
    return c.json({ error: "send_failed" }, 502);
  }

  // Non-identifying: no name, address, message text or IP — just the shape.
  console.log(
    `contact accepted ${JSON.stringify({
      messageChars: values.message.length,
      hasPhone: Boolean(values.phone),
      origin: origin || "none",
      rateCount: rate.count,
    })}`,
  );
  return c.json({ ok: true });
});
