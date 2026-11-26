// Bulk Email Checker integration.
//
// One address per call, FORM-ENCODED (a JSON body is rejected by the API with
// "Invalid or missing API key"; a query-string GET also works). The API allows
// 1500 checks/hour and ONE concurrent thread, so calls are strictly sequential
// and the per-minute cron pass is capped at VERIFY_PER_PASS (20 x 60 = 1200/hr,
// under both the 1500/hour ceiling and the 25/min assumption).
//
// The 1-minute cron calls verifyPendingContacts(). A pass can outlive its tick
// (slow responses, retries, a long queue), so the whole pass is guarded by a
// single-flight lease in `verify_lock`: a pass that cannot atomically claim the
// lease skips the tick entirely, so two passes can never overlap and open two
// connections (the account's concurrency warning). A `VERIFY_PAUSED` switch
// (env or settings) makes the pass a no-op so a manual dashboard run cannot
// collide with it.
//
// verifyPendingContacts() is the only entry point the Worker calls. It never
// touches the network when the API key is unset.
//
// Selection priority inside one pass:
//   1. Explicit operator requests (`email_verify_queued = 1`, set by the
//      Contacts "Queue verification" action) — these get the full per-pass
//      budget so a bulk re-verify is never starved.
//   2. Never-checked rows ('pending' and the legacy NULL state).
//   3. Stale 'unknown' rows (BEC may resolve a catch-all later).
//   4. Only when 1-3 are all empty: stale 'valid' rows (older than the cadence),
//      at a deliberately low rate. A fresh 'valid' is never selected here.

import type { Env } from "./types";
import { type EmailStatus } from "../shared/emailStatus";
import {
  CREDITS_REMAINING_SETTING_KEY,
  DEFAULT_STALE_DAYS,
  STALE_DAYS_SETTING_KEY,
  VERIFY_PAUSED_SETTING_KEY,
  normalizeStaleDays,
  staleBeforeSeconds,
} from "../shared/emailStatus";

export const BULK_EMAIL_CHECKER_URL = "https://api.bulkemailchecker.com/real-time/";

/**
 * Addresses one pass may check. 20 x 60 = 1200/hour, which sits under the
 * 1500/hour API ceiling and the 25/min assumption with headroom. Because the
 * single-flight lease means only one pass runs at a time, this is the true
 * hourly rate.
 */
export const VERIFY_PER_PASS = 20;

/**
 * How many stale 'valid' addresses the pass re-checks per pass once the queue
 * and the never-checked backlog are both empty. Kept low on purpose: automatic
 * re-verification must never crowd out an explicit bulk re-verify.
 */
export const VERIFY_STALE_PER_PASS = 2;

/**
 * A pass may reclaim the single-flight lease once it is older than this. Longer
 * than the worst realistic pass (a slow 20-check pass is well under a minute),
 * short enough that a crashed pass cannot wedge the cron for long.
 */
export const VERIFY_LOCK_STALE_SECONDS = 5 * 60;

/**
 * An 'unknown' result is re-checked after this long (BEC may resolve a
 * catch-all/transient later). 'valid'/'invalid' are terminal and are never
 * re-checked; only 'pending', stale 'unknown' and explicitly-queued rows are
 * selected again.
 */
export const RECHECK_UNKNOWN_AFTER_SECONDS = 7 * 24 * 60 * 60;

export interface VerifySignals {
  status: string | null;
  event: string | null;
  isDisposable: boolean;
  isGibberish: boolean;
  isRoleAccount: boolean;
  isComplainer: boolean;
  isFreeService: boolean;
  emailSuggested: string | null;
  creditsRemaining: number | null;
  hourlyQuotaRemaining: number | null;
}

export type VerifyResult =
  | { kind: "checked"; status: EmailStatus; signals: VerifySignals }
  | {
      kind: "stop";
      reason: "no-key" | "quota" | "rate-limit" | "concurrency" | "error";
      message?: string;
    };

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function bool(v: unknown): boolean {
  return v === true || v === 1 || v === "true" || v === "1";
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/**
 * Map a BEC payload to our status. The signals we trust are the booleans
 * (`isDisposable`/`isGibberish`) and `status === 'passed'`; anything that is
 * neither a clear pass nor a clear fail lands on 'unknown' (held back), never
 * on 'valid'. 'risky' is a pass that we still record distinctly.
 */
export function mapVerifyStatus(
  s: Pick<VerifySignals, "status" | "isDisposable" | "isGibberish" | "isComplainer">,
): EmailStatus {
  if (s.isGibberish || s.isDisposable) return "invalid";
  if (s.status === "passed" || s.status === "pass") return s.isComplainer ? "risky" : "valid";
  if (s.status === "risky") return "risky";
  if (s.status === "failed" || s.status === "fail" || s.status === "invalid") return "invalid";
  return "unknown";
}

/** Normalise the raw API JSON into the signals we store. */
export function parseSignals(data: any): VerifySignals {
  const d = data && typeof data === "object" ? data : {};
  return {
    status: str(d.status),
    event: str(d.event),
    isDisposable: bool(d.isDisposable),
    isGibberish: bool(d.isGibberish),
    isRoleAccount: bool(d.isRoleAccount),
    isComplainer: bool(d.isComplainer),
    isFreeService: bool(d.isFreeService),
    emailSuggested: str(d.emailSuggested),
    creditsRemaining: num(d.creditsRemaining),
    hourlyQuotaRemaining: num(d.hourlyQuotaRemaining),
  };
}

const LIMIT_SIGNAL = /concurren|too many|rate.?limit|throttl|limit reached|quota/i;

/** A 2xx payload that still names a concurrency/rate problem, else null. */
function detectLimitMessage(data: any): string | null {
  if (!data || typeof data !== "object") return null;
  for (const k of ["error", "message", "detail"]) {
    const v = (data as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim() && LIMIT_SIGNAL.test(v)) return v.trim();
  }
  return null;
}

/**
 * Check one address. Returns a `checked` result (even when the response says the
 * hourly quota is spent - the caller records it and then stops) or a `stop`
 * reason that tells the pass to give up until next minute.
 */
export async function verifyEmail(env: Env, email: string): Promise<VerifyResult> {
  const key = env.BULK_EMAIL_CHECKER_API;
  if (!key) return { kind: "stop", reason: "no-key", message: "BULK_EMAIL_CHECKER_API not set" };

  const body = new URLSearchParams({ key, email });
  let res: Response;
  try {
    res = await fetch(BULK_EMAIL_CHECKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (e: any) {
    return { kind: "stop", reason: "error", message: String(e?.message ?? e) };
  }
  // Any rate-limit / concurrency / server signal is stop-now: the pass aborts,
  // never retries inside the pass, and releases the lease (see the `finally` in
  // verifyPendingContacts). A 5xx is not something to hammer either.
  if (res.status === 429) return { kind: "stop", reason: "rate-limit" };
  if (res.status >= 500) return { kind: "stop", reason: "error", message: `HTTP ${res.status}` };
  if (!res.ok) return { kind: "stop", reason: "error", message: `HTTP ${res.status}` };

  let data: any;
  try {
    data = await res.json();
  } catch {
    return { kind: "stop", reason: "error", message: "invalid JSON" };
  }
  // A 2xx body can still report a limit/concurrency problem; treat that as
  // stop-now too rather than recording a bogus result.
  const limitMessage = detectLimitMessage(data);
  if (limitMessage) return { kind: "stop", reason: "concurrency", message: limitMessage };
  const signals = parseSignals(data);
  return { kind: "checked", status: mapVerifyStatus(signals), signals };
}

/** Read the re-verify cadence (days) from settings; falls back to the default. */
export async function getStaleDays(env: Env): Promise<number> {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?")
      .bind(STALE_DAYS_SETTING_KEY)
      .first<{ value: string }>();
    if (!row) return DEFAULT_STALE_DAYS;
    let v: unknown = row.value;
    try {
      v = JSON.parse(row.value);
    } catch {
      /* stored as a bare string/number */
    }
    return normalizeStaleDays(v);
  } catch {
    return DEFAULT_STALE_DAYS;
  }
}

/** Remember the last credits-remaining figure so the UI can show a real budget. */
async function rememberCredits(env: Env, credits: number): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=unixepoch()",
    )
      .bind(CREDITS_REMAINING_SETTING_KEY, JSON.stringify(credits))
      .run();
  } catch {
    /* best-effort: never let bookkeeping fail a pass */
  }
}

export interface VerifyPassResult {
  /** Addresses checked in this pass. */
  checked: number;
  /** Why the pass stopped early, or null when it drained the selection. */
  stopped: string | null;
  /** Pending contacts still waiting after this pass. */
  remaining: number;
  /** Credits the API last reported, when it did. */
  creditsRemaining?: number | null;
  /** The cadence (days) this pass used. */
  staleDays?: number;
  /** True when the pass did no work (paused, or another pass held the lease). */
  skipped?: boolean;
}

interface PassState {
  checked: number;
  stopped: string | null;
  creditsRemaining: number | null;
  now: number;
}

interface CheckRow {
  id: number;
  email: string;
}

/**
 * Check each row in order, recording the result and clearing the queued flag.
 * Stops (without touching the rest) on a `stop` result or when the API says the
 * hour's quota is spent. Strictly sequential - the API allows one thread.
 */
async function runChecks(env: Env, rows: CheckRow[], state: PassState): Promise<void> {
  for (const row of rows) {
    const r = await verifyEmail(env, row.email);
    if (r.kind === "stop") {
      state.stopped = r.reason;
      return;
    }
    await env.DB.prepare(
      `UPDATE contacts
         SET email_status = ?, email_verified_at = ?, email_check_event = ?,
             email_check_flags = ?, email_verify_queued = 0, updated_at = unixepoch()
       WHERE id = ?`,
    )
      .bind(
        r.status,
        state.now,
        r.signals.event,
        JSON.stringify({
          becStatus: r.signals.status,
          isDisposable: r.signals.isDisposable,
          isGibberish: r.signals.isGibberish,
          isRoleAccount: r.signals.isRoleAccount,
          isComplainer: r.signals.isComplainer,
          isFreeService: r.signals.isFreeService,
          emailSuggested: r.signals.emailSuggested,
        }),
        row.id,
      )
      .run();
    state.checked++;
    if (r.signals.creditsRemaining != null) state.creditsRemaining = r.signals.creditsRemaining;
    // The API's own budget is authoritative: stop the pass the moment it says
    // the hour is spent, and let next minute's pass resume.
    if (r.signals.hourlyQuotaRemaining != null && r.signals.hourlyQuotaRemaining <= 0) {
      state.stopped = "quota";
      return;
    }
  }
}

/** Rows the primary queue would still have left after this pass. */
async function countPrimaryBacklog(env: Env, staleUnknownBefore: number): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM contacts
      WHERE email_verify_queued = 1
         OR email_status = 'pending'
         OR email_status IS NULL
         OR (email_status = 'unknown' AND (email_verified_at IS NULL OR email_verified_at < ?))`,
  )
    .bind(staleUnknownBefore)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** Truthy parse for a switch that may arrive as an env string or a JSON value. */
function flagOn(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "1" || s === "true" || s === "yes" || s === "on";
  }
  return false;
}

/**
 * True when the owner has paused the cron pass (env VERIFY_PAUSED or the
 * `email_verify_paused` settings key), so a manual run in the Bulk Email Checker
 * dashboard cannot collide with ours. Default: not paused.
 */
export async function isVerifyPaused(env: Env): Promise<boolean> {
  if (flagOn(env.VERIFY_PAUSED)) return true;
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?")
      .bind(VERIFY_PAUSED_SETTING_KEY)
      .first<{ value: string }>();
    if (!row) return false;
    let v: unknown = row.value;
    try {
      v = JSON.parse(row.value);
    } catch {
      /* stored as a bare string/number */
    }
    return flagOn(v);
  } catch {
    return false;
  }
}

export interface VerifyLease {
  acquired: boolean;
  /** The owner id used to claim (and later release) the lease. */
  owner: string;
  /** Who held it when we were refused, and for how long (seconds). */
  heldBy?: string;
  heldSeconds?: number;
}

/**
 * Atomically claim the single-flight lease. This is a compare-and-set in ONE
 * statement: the upsert's `WHERE verify_lock.started_at < staleBefore` is
 * evaluated against the existing row inside the same write, so D1's single
 * writer serialises two contenders and exactly one sees changes=1. A plain
 * SELECT-then-UPDATE would let both read "free" and both then write.
 */
export async function acquireVerifyLease(
  env: Env,
  nowSeconds: number,
  owner: string = crypto.randomUUID(),
): Promise<VerifyLease> {
  const staleBefore = nowSeconds - VERIFY_LOCK_STALE_SECONDS;
  const res = await env.DB.prepare(
    `INSERT INTO verify_lock (id, owner, started_at)
       VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE
       SET owner = excluded.owner, started_at = excluded.started_at
       WHERE verify_lock.started_at < ?`,
  )
    .bind(owner, nowSeconds, staleBefore)
    .run();
  if (Number(res.meta?.changes ?? 0) > 0) return { acquired: true, owner };

  const holder = await env.DB.prepare("SELECT owner, started_at FROM verify_lock WHERE id=1")
    .first<{ owner: string; started_at: number }>();
  return {
    acquired: false,
    owner,
    heldBy: holder?.owner,
    heldSeconds: holder ? nowSeconds - holder.started_at : undefined,
  };
}

/**
 * Release the lease, but only if we still hold it. Guarding on owner means a
 * lease that went stale and was reclaimed by a newer pass is left untouched by
 * the original holder's (late) cleanup. Best-effort: a failed release is
 * reclaimed by the stale timeout.
 */
export async function releaseVerifyLease(env: Env, owner: string): Promise<void> {
  try {
    await env.DB.prepare("DELETE FROM verify_lock WHERE id=1 AND owner=?").bind(owner).run();
  } catch {
    /* reclaimable via the stale timeout */
  }
}

/**
 * The body of one pass: verify up to `limit` addresses, strictly sequentially.
 * Explicitly-queued rows come first, then never-checked ('pending'/NULL) rows,
 * then stale 'unknown' rows. Only when all of those are empty does it re-check
 * stale 'valid' rows, and then at most VERIFY_STALE_PER_PASS of them. Stops
 * early - without touching the rest - when the API reports its hourly quota is
 * spent, rate-limits us, reports a concurrency problem, or errors.
 */
async function runPass(
  env: Env,
  limit: number,
  now: number,
  staleDaysOpt?: number,
): Promise<VerifyPassResult> {
  const staleDays = staleDaysOpt ?? (await getStaleDays(env));
  const staleBefore = staleBeforeSeconds(now, staleDays);
  const staleUnknownBefore = now - RECHECK_UNKNOWN_AFTER_SECONDS;

  const state: PassState = { checked: 0, stopped: null, creditsRemaining: null, now };

  // 1-3: the primary queue. Queued (explicit) first, then never-checked, then
  // stale 'unknown'. A fresh 'valid' can never appear here.
  const primary = await env.DB.prepare(
    `SELECT id, email FROM contacts
      WHERE email_verify_queued = 1
         OR email_status = 'pending'
         OR email_status IS NULL
         OR (email_status = 'unknown' AND (email_verified_at IS NULL OR email_verified_at < ?))
      ORDER BY (email_verify_queued = 1) DESC, id
      LIMIT ?`,
  )
    .bind(staleUnknownBefore, limit)
    .all<CheckRow>();
  await runChecks(env, primary.results, state);

  // 4: stale 'valid' re-checks, low rate, only once the primary queue is empty.
  if (!state.stopped && state.checked < limit) {
    const backlog = await countPrimaryBacklog(env, staleUnknownBefore);
    if (backlog === 0) {
      const staleLimit = Math.min(VERIFY_STALE_PER_PASS, limit - state.checked);
      const stale = await env.DB.prepare(
        `SELECT id, email FROM contacts
          WHERE email_status = 'valid'
            AND email_verified_at IS NOT NULL
            AND email_verified_at < ?
          ORDER BY email_verified_at, id
          LIMIT ?`,
      )
        .bind(staleBefore, staleLimit)
        .all<CheckRow>();
      await runChecks(env, stale.results, state);
    }
  }

  if (state.creditsRemaining != null) await rememberCredits(env, state.creditsRemaining);

  const remaining = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM contacts WHERE email_status = 'pending' OR email_status IS NULL",
  ).first<{ n: number }>();
  const result: VerifyPassResult = {
    checked: state.checked,
    stopped: state.stopped,
    remaining: remaining?.n ?? 0,
    creditsRemaining: state.creditsRemaining,
    staleDays,
  };
  console.log("email-verify pass", JSON.stringify(result));
  return result;
}

/**
 * One cron pass, guarded by the single-flight lease and the pause switch.
 * Returns without touching the network when the API key is unset, when
 * VERIFY_PAUSED is on, or when another pass already holds the lease; the lease
 * is always released in `finally` (a crashed pass is reclaimed by the stale
 * timeout). The selection itself lives in runPass and is recomputed, never
 * remembered - a fresh 'valid' is never selected.
 */
export async function verifyPendingContacts(
  env: Env,
  opts: { limit?: number; nowSeconds?: number; staleDays?: number } = {},
): Promise<VerifyPassResult> {
  const limit = Math.max(1, Math.floor(opts.limit ?? VERIFY_PER_PASS));
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!env.BULK_EMAIL_CHECKER_API) return { checked: 0, stopped: "no-key", remaining: 0 };

  // Pause switch first: a paused pass takes nothing (not even the lease), so a
  // manual dashboard run cannot collide with it.
  if (await isVerifyPaused(env)) {
    console.log("email-verify pass skipped", JSON.stringify({ reason: "paused" }));
    return { checked: 0, stopped: "paused", remaining: 0, skipped: true };
  }

  // Single-flight: a pass that outlives its minute must not overlap the next
  // tick (two connections). Claim the lease or skip this tick entirely.
  const lease = await acquireVerifyLease(env, now);
  if (!lease.acquired) {
    console.log(
      "email-verify pass skipped",
      JSON.stringify({ reason: "lease-held", heldBy: lease.heldBy, heldSeconds: lease.heldSeconds }),
    );
    return { checked: 0, stopped: "lease-held", remaining: 0, skipped: true };
  }

  try {
    return await runPass(env, limit, now, opts.staleDays);
  } finally {
    await releaseVerifyLease(env, lease.owner);
  }
}
