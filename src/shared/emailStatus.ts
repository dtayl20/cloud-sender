// Email-verification status vocabulary, shared by the Worker and the web UI.
//
// Bulk Email Checker runs out-of-band from the 1-minute cron (see
// worker/emailVerify.ts). A contact's `contacts.email_status` is one of these.
// NULL means "never checked"; migration 0017 back-fills pre-existing rows to
// 'pending', but NULL stays a distinct, non-sendable state.

export const EMAIL_STATUSES = ["pending", "valid", "risky", "invalid", "unknown"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/**
 * Named switch for whether a 'risky' address may be sent to. It defaults OFF:
 * a contact becomes sendable once verification says 'valid' or 'unknown'. Flip
 * it to true to also permit 'risky' — nothing else changes, because SENDABLE_
 * and SEND_BLOCKED_ are derived from each other below.
 */
export const ALLOW_RISKY_SENDS = false;

/**
 * The ONLY statuses that may be sent to. A contact is sendable when its
 * verification status is 'valid' OR 'unknown'; 'pending' (still queued),
 * 'invalid' (bad/disposable/gibberish) and NULL ("never checked") are held back.
 * 'risky' joins the list only when ALLOW_RISKY_SENDS is on.
 *
 * 'unknown' means Bulk Email Checker returned an inconclusive answer (see
 * mapVerifyStatus) - typically a catch-all or temporarily unverifiable domain.
 * The owner's 2026-10-08 decision is that such an address IS sendable: an
 * inconclusive check must not strand a real address forever. The 1-minute pass
 * still re-checks stale 'unknown' rows (RECHECK_UNKNOWN_AFTER_SECONDS).
 */
export const SENDABLE_EMAIL_STATUSES: readonly EmailStatus[] = ALLOW_RISKY_SENDS
  ? ["valid", "risky", "unknown"]
  : ["valid", "unknown"];

/**
 * The send blocklist, derived from the allowlist so the two can never
 * contradict. With ALLOW_RISKY_SENDS off this is ['pending', 'risky', 'invalid'];
 * 'unknown' is no longer blocked.
 */
export const SEND_BLOCKED_EMAIL_STATUSES: readonly EmailStatus[] = EMAIL_STATUSES.filter(
  (s) => !SENDABLE_EMAIL_STATUSES.includes(s),
);

/** UI labels. */
export const EMAIL_STATUS_LABELS: Record<EmailStatus, string> = {
  pending: "Pending",
  valid: "Valid",
  risky: "Risky",
  invalid: "Invalid",
  unknown: "Unknown",
};

/**
 * True when a stored status must be held back from sending. NULL/undefined is
 * blocked too: "never checked" is not "verified", so it is not sendable.
 */export function isSendBlocked(status: string | null | undefined): boolean {
  return status == null || !(SENDABLE_EMAIL_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// Re-verify cadence (stale verifications)
// ---------------------------------------------------------------------------
//
// A 'valid' address is not valid forever: mailboxes close and domains lapse, so
// after a configurable age a verified address becomes *stale* and is due a
// re-check. The age is a settings value so it can be changed without a deploy.
// A stale 'valid' is still exactly as sendable as a fresh one until the pass
// actually re-checks it and returns a new result - the cadence only decides what
// the pass may pick up, never the send rule (see isSendBlocked above).

/** Settings key holding the re-verify age in days. */
export const STALE_DAYS_SETTING_KEY = "email_verify_stale_days";

/** Default re-verify cadence: 6 months. */
export const DEFAULT_STALE_DAYS = 180;

/** Settings key holding the last credits-remaining figure the API reported. */
export const CREDITS_REMAINING_SETTING_KEY = "email_verify_credits_remaining";

/**
 * Settings key for the cron verification pause switch. When true the 1-minute
 * pass is a no-op, so the owner can run manual checks in the Bulk Email Checker
 * dashboard without our pass colliding (default: off / not paused).
 */
export const VERIFY_PAUSED_SETTING_KEY = "email_verify_paused";

/** The `email_verified_at` below which a 'valid' address is stale and due a re-check. */
export function staleBeforeSeconds(nowSeconds: number, staleDays: number): number {
  return nowSeconds - Math.max(0, Math.floor(staleDays)) * 86400;
}

/** Clamp a stored/typed cadence to something sane (1..3650 days). */
export function normalizeStaleDays(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_STALE_DAYS;
  return Math.min(3650, Math.max(1, Math.floor(n)));
}
