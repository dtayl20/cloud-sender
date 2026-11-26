// Sequenced email campaigns.
//
// A sequence is an ordered list of steps. A contact enrolled in it receives the
// steps in order, each one `wait_minutes` after the previous send (step 1's wait
// is measured from enrolment). The engine is a pure function of the tables: a
// step is DUE for an enrolment when `step.position > enrollment.last_sent_position`
// and the wait has elapsed. Nothing stores a step *index*, which is exactly what
// makes "append a step, completed users get only the new step, nobody restarts"
// work, and makes a mid-sequence insert a skip for contacts who passed it.
//
// Dispatch runs from the same 1-minute cron as campaigns, under the same two
// disciplines:
//   * single-flight - a one-row lease (sequence_lock) is claimed with a single
//     conditional write, so a slow tick cannot overlap the next (verify_lock,
//     0019, is the precedent);
//   * idempotency - the UNIQUE (sequence_id, contact_id, step_position) index on
//     sequence_sends makes a repeated release a no-op, so even without the lease
//     a step cannot go out twice.
//
// Caps and pacing reuse the campaign ramp/spread machinery (shared/sendPlan.ts):
// daily_cap / send_days / send_time / ramp_* / spread_minutes are read per
// sequence. send_time is LOCAL to the CONTACT (contacts.timezone, derived from
// its state and back-filled by 0021); the sequence's send_timezone is the
// fallback when a contact's zone is unknown.

import type { Env, SendJob } from "./types";
import {
  DEFAULT_SEND_TIMEZONE,
  evaluatePlanNow,
  localDayWindow,
  normalizeDailyCap,
  normalizeRampDays,
  normalizeRampStart,
  normalizeSendTime,
  normalizeSpreadMinutes,
  parseSendDays,
  parseSendTime,
  sendRamp,
  spreadTarget,
  currentWindowStart,
  todayRampAllowance,
  resolveTimeZone,
} from "../shared/sendPlan";
import { buildAudienceQuery } from "./audience";
import { isSendBlocked } from "../shared/emailStatus";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function now2(nowSeconds?: number): number {
  return nowSeconds ?? Math.floor(Date.now() / 1000);
}

/** Position spacing for new steps, leaving room to insert between two steps. */
export const STEP_POSITION_GAP = 1000;

/** Lease staleness - same idea and order of magnitude as VERIFY_LOCK_STALE_SECONDS. */
export const SEQUENCE_LOCK_STALE_SECONDS = 5 * 60;

export interface SequenceRow {
  id: number;
  name: string;
  status: string;
  list_id: number | null;
  segment_id: number | null;
  audience_filter: string | null;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  /** Chosen sender identity (0023). NULL = default identity, else legacy from_*. */
  sender_identity_id: number | null;
  daily_cap: number | null;
  send_days: string | null;
  send_time: string | null;
  send_timezone: string | null;
  ramp_start: number | null;
  ramp_days: number | null;
  spread_minutes: number | null;
  created_at: number;
  started_at: number | null;
}

export interface SequenceStepRow {
  id: number;
  sequence_id: number;
  position: number;
  name: string | null;
  template_id: number | null;
  external_template_id: string | null;
  subject: string | null;
  body_html: string | null;
  /** The step's OWN copy of the email (0024). Non-null => rendered directly. */
  content_html: string | null;
  content_text: string | null;
  /** Provenance only: which template this step's copy was seeded from. */
  seeded_from_template_id: number | null;
  wait_minutes: number;
  released_to_completed_at: number | null;
  created_at: number;
}

/** The sequence's IANA zone: its own override, else the Worker var. */
export function sequenceTimeZone(env: Env, seq: Partial<SequenceRow>): string {
  return resolveTimeZone(seq.send_timezone, env.SEND_TIMEZONE ?? DEFAULT_SEND_TIMEZONE);
}

/** The zone a CONTACT's send_time window is measured in: its own, else the sequence's. */
export function contactTimeZone(env: Env, seq: Partial<SequenceRow>, contactTimezone?: string | null): string {
  return resolveTimeZone(contactTimezone ?? null, sequenceTimeZone(env, seq));
}

// ---------------------------------------------------------------------------
// Steps & due computation
// ---------------------------------------------------------------------------

export async function loadSteps(env: Env, sequenceId: number): Promise<SequenceStepRow[]> {
  const r = await env.DB.prepare(
    "SELECT * FROM sequence_steps WHERE sequence_id=? ORDER BY position, id",
  )
    .bind(sequenceId)
    .all<SequenceStepRow>();
  return r.results ?? [];
}

/** The first step after `position`, or null when the sequence is exhausted. */
export function nextStepAfter(steps: SequenceStepRow[], position: number): SequenceStepRow | null {
  for (const s of steps) if (s.position > position) return s;
  return null;
}

/**
 * When the next step becomes due for an enrolment, in epoch seconds.
 * `last_sent_at` is the anchor: the previous send, or (for step 1) enrolment.
 */
export function nextDueAt(
  step: SequenceStepRow,
  lastSentAt: number | null,
  enrolledAt: number,
): number {
  const anchor = lastSentAt ?? enrolledAt;
  return anchor + Math.max(0, Math.floor(step.wait_minutes)) * 60;
}

export interface EnrollmentRow {
  id: number;
  sequence_id: number;
  contact_id: number;
  email: string;
  status: string;
  stop_reason: string | null;
  enrolled_at: number;
  last_sent_position: number;
  last_sent_at: number | null;
  next_due_at: number | null;
  restarts: number;
  created_at: number;
  updated_at: number;
}

/** Recompute and persist `next_due_at` for an enrolment's current position. */
function recomputeNextDue(
  steps: SequenceStepRow[],
  e: { last_sent_position: number; last_sent_at: number | null; enrolled_at: number },
): { dueAt: number | null; step: SequenceStepRow | null } {
  const step = nextStepAfter(steps, e.last_sent_position);
  if (!step) return { dueAt: null, step: null };
  return { dueAt: nextDueAt(step, e.last_sent_at, e.enrolled_at), step };
}

// ---------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------

export interface AudienceRow {
  id: number;
  email: string;
}

/**
 * A sequence's audience: its list, its segment, or all active contacts. Mirrors
 * the campaign resolveAudience and applies the shared sendable blocklist
 * (shared/emailStatus.ts) and the suppression list, so a sequence never even
 * enrols an address the send rule would hold back.
 */
export async function sequenceAudience(env: Env, seq: Partial<SequenceRow>): Promise<AudienceRow[]> {
  if (seq.segment_id) {
    const seg = await env.DB.prepare("SELECT filter_json FROM lists WHERE id=?")
      .bind(seq.segment_id)
      .first<{ filter_json: string | null }>();
    const filter = seg?.filter_json ? JSON.parse(seg.filter_json) : {};
    const { sql, binds } = buildAudienceQuery(filter, false, { forSending: true });
    const r = await env.DB.prepare(sql).bind(...binds).all<AudienceRow>();
    return r.results ?? [];
  }
  if (seq.list_id) {
    const r = await env.DB.prepare(
      `SELECT c.id, c.email FROM contacts c
        JOIN list_members lm ON lm.contact_id = c.id
       WHERE lm.list_id = ? AND c.status='active'
         AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = c.email)`,
    )
      .bind(seq.list_id)
      .all<AudienceRow>();
    return r.results ?? [];
  }
  const r = await env.DB.prepare(
    `SELECT id, email FROM contacts
      WHERE status='active'
        AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = contacts.email)`,
  ).all<AudienceRow>();
  return r.results ?? [];
}

/** Audience size for the editor, without loading rows. */
export async function sequenceAudienceCount(env: Env, seq: Partial<SequenceRow>): Promise<number> {
  if (seq.segment_id) {
    const seg = await env.DB.prepare("SELECT filter_json FROM lists WHERE id=?")
      .bind(seq.segment_id)
      .first<{ filter_json: string | null }>();
    const filter = seg?.filter_json ? JSON.parse(seg.filter_json) : {};
    const { sql, binds } = buildAudienceQuery(filter, true, { forSending: true });
    const r = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
    return r?.n ?? 0;
  }
  if (seq.list_id) {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM contacts c
        JOIN list_members lm ON lm.contact_id = c.id
       WHERE lm.list_id = ? AND c.status='active'
         AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = c.email)`,
    )
      .bind(seq.list_id)
      .first<{ n: number }>();
    return r?.n ?? 0;
  }
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM contacts
      WHERE status='active'
        AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = contacts.email)`,
  ).first<{ n: number }>();
  return r?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Single-flight lease (same discipline as verify_lock)
// ---------------------------------------------------------------------------

export interface SequenceLease {
  acquired: boolean;
  owner: string;
  heldBy?: string;
  heldSeconds?: number;
}

export async function acquireSequenceLease(
  env: Env,
  nowSeconds: number,
  owner: string = crypto.randomUUID(),
): Promise<SequenceLease> {
  const staleBefore = nowSeconds - SEQUENCE_LOCK_STALE_SECONDS;
  const res = await env.DB.prepare(
    `INSERT INTO sequence_lock (id, owner, started_at)
       VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE
       SET owner = excluded.owner, started_at = excluded.started_at
       WHERE sequence_lock.started_at < ?`,
  )
    .bind(owner, nowSeconds, staleBefore)
    .run();
  if (Number(res.meta?.changes ?? 0) > 0) return { acquired: true, owner };
  const holder = await env.DB.prepare("SELECT owner, started_at FROM sequence_lock WHERE id=1")
    .first<{ owner: string; started_at: number }>();
  return {
    acquired: false,
    owner,
    heldBy: holder?.owner,
    heldSeconds: holder ? nowSeconds - holder.started_at : undefined,
  };
}

export async function releaseSequenceLease(env: Env, owner: string): Promise<void> {
  try {
    await env.DB.prepare("DELETE FROM sequence_lock WHERE id=1 AND owner=?").bind(owner).run();
  } catch {
    /* reclaimed via the stale timeout */
  }
}

// ---------------------------------------------------------------------------
// Pacing: released-today count and ramp days, mirrored from the campaign path
// but reading sequence_sends.
// ---------------------------------------------------------------------------

const SEQ_RELEASED_IN_DAY = `sequence_sends.sequence_id = ?
  AND NOT (sequence_sends.status = 'skipped' AND sequence_sends.sent_at IS NULL)
  AND (
    (sequence_sends.sent_at IS NOT NULL AND sequence_sends.sent_at >= ? AND sequence_sends.sent_at < ?)
    OR (sequence_sends.sent_at IS NULL AND sequence_sends.queued_at >= ? AND sequence_sends.queued_at < ?)
  )`;

function seqReleasedInDayBinds(sequenceId: number, day: { start: number; end: number }) {
  return [sequenceId, day.start, day.end, day.start, day.end];
}

export async function sequenceReleasedTodayCount(
  env: Env,
  sequenceId: number,
  timezone: string,
  nowSeconds: number,
): Promise<number> {
  const day = localDayWindow(nowSeconds, timezone);
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sequence_sends WHERE ${SEQ_RELEASED_IN_DAY}`)
    .bind(...seqReleasedInDayBinds(sequenceId, day))
    .first<{ n: number }>();
  return r?.n ?? 0;
}

const MAX_RAMP_LOOKBACK = 400;

async function sequenceSendingDaysBefore(
  env: Env,
  seq: SequenceRow,
  timezone: string,
  nowSeconds: number,
  limit: number,
): Promise<number> {
  const need = Math.max(0, Math.floor(limit));
  if (need <= 0) return 0;
  const startedAt = Number(seq.started_at ?? 0);
  let dayStart = localDayWindow(nowSeconds, timezone).start;
  let found = 0;
  for (let back = 0; back < MAX_RAMP_LOOKBACK && found < need; back++) {
    const window = localDayWindow(dayStart - 1, timezone);
    dayStart = window.start;
    if (startedAt > 0 && window.end <= startedAt) break;
    const hit = await env.DB.prepare(
      `SELECT 1 AS x FROM sequence_sends
        WHERE sequence_id = ?
          AND NOT (status = 'skipped' AND sent_at IS NULL)
          AND (
            (sent_at IS NOT NULL AND sent_at >= ? AND sent_at < ?)
            OR (sent_at IS NULL AND queued_at >= ? AND queued_at < ?)
          )
        LIMIT 1`,
    )
      .bind(seq.id, window.start, window.end, window.start, window.end)
      .first();
    if (hit) found += 1;
  }
  return found;
}

/**
 * Today's release allowance for a sequence: the flat daily cap, or the ramp's
 * step for the sending day today is, further metered by a spread. Mirrors
 * runPlanTick's arithmetic exactly, on sequence_sends.
 */
async function sequenceAllowance(
  env: Env,
  seq: SequenceRow,
  timezone: string,
  nowSeconds: number,
): Promise<{ allowance: number; dayCeiling: number | null; releasedToday: number; paced: boolean; capped: boolean }> {
  const cap = normalizeDailyCap(seq.daily_cap);
  const releasedToday = await sequenceReleasedTodayCount(env, seq.id, timezone, nowSeconds);
  if (cap == null) {
    return { allowance: Number.MAX_SAFE_INTEGER, dayCeiling: null, releasedToday, paced: false, capped: false };
  }
  const ramp = sendRamp(seq as any);
  const prior = ramp ? await sequenceSendingDaysBefore(env, seq, timezone, nowSeconds, ramp.days - 1) : 0;
  const dayAllowance = todayRampAllowance(seq as any, prior) ?? cap;
  const spread = normalizeSpreadMinutes(seq.spread_minutes);
  const sendTime = parseSendTime(seq.send_time);
  const target = spreadTarget({
    dayAllowance,
    spreadMinutes: spread,
    windowStartAt: currentWindowStart({ nowSeconds, timezone, sendTime }),
    nowSeconds,
  });
  const dayCeiling = Math.max(0, Math.min(dayAllowance, target));
  const paced = spread != null && releasedToday < dayAllowance;
  return { allowance: dayCeiling - releasedToday, dayCeiling, releasedToday, paced, capped: true };
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export type SequenceTickAction = "released" | "cap-reached" | "paced" | "waiting" | "no-steps";

export interface SequenceTickResult {
  id: number;
  action: SequenceTickAction;
  released: number;
}

interface CandidateContactRow {
  id: number;
  email: string;
  status: string;
  email_status: string | null;
  timezone: string | null;
}

/**
 * One dispatcher pass over a single sequence. Recomputes everything from the
 * tables, so re-entering a tick (or sixty ticks an hour) releases nothing twice.
 */
export async function runSequenceTick(
  env: Env,
  seq: SequenceRow,
  opts: { nowSeconds?: number } = {},
): Promise<SequenceTickResult> {
  const now = now2(opts.nowSeconds);
  const steps = await loadSteps(env, seq.id);
  const base: SequenceTickResult = { id: seq.id, action: "waiting", released: 0 };
  if (!steps.length) return { ...base, action: "no-steps" };

  const timezone = sequenceTimeZone(env, seq);
  const sendDays = parseSendDays(seq.send_days);
  const sendTime = parseSendTime(seq.send_time);

  const allowanceInfo = await sequenceAllowance(env, seq, timezone, now);
  if (allowanceInfo.allowance <= 0) {
    return { ...base, action: allowanceInfo.paced ? "paced" : "cap-reached" };
  }

  // Due enrolments: active, with a step remaining. Order by the recorded due
  // time so the oldest waiting contacts go first; recompute the true due below.
  // `next_due_at IS NOT NULL` is the belt to the draft-sequence braces: a
  // captured-and-held contact (enrolled while the sequence was a draft) has a
  // NULL due time and must never be released until releaseHeldEnrollments runs
  // on activation, even if something activates the sequence without it.
  const rows = await env.DB.prepare(
    `SELECT e.id, e.sequence_id, e.contact_id, e.email, e.enrolled_at,
            e.last_sent_position, e.last_sent_at, e.next_due_at,
            c.status AS contact_status, c.email_status, c.timezone
       FROM sequence_enrollments e
       LEFT JOIN contacts c ON c.id = e.contact_id
      WHERE e.sequence_id = ? AND e.status = 'active' AND e.last_sent_position < ?
        AND e.next_due_at IS NOT NULL
      ORDER BY COALESCE(e.next_due_at, e.enrolled_at), e.id`,
  )
    .bind(seq.id, steps[steps.length - 1].position)
    .all<any>();

  let released = 0;
  for (const row of rows.results ?? []) {
    if (released >= allowanceInfo.allowance) break;
    const e: EnrollmentRow = row;
    const step = nextStepAfter(steps, Number(e.last_sent_position));
    if (!step) continue;
    const due = nextDueAt(step, e.last_sent_at, e.enrolled_at);
    if (due > now) continue;

    // Local window for THIS contact (send_time is local time).
    const ctz = contactTimeZone(env, seq, row.timezone);
    const plan = evaluatePlanNow({ nowSeconds: now, timezone: ctz, sendDays, sendTime });
    if (!plan.windowOpen) {
      // Not this contact's window yet: keep the computed due (the window is a
      // gate, not a delay) so the editor still shows the true wait.
      continue;
    }

    // Sendable checks. A contact that has since unsubscribed or bounced stops
    // the WHOLE sequence for them (standalone, no GHL). A contact merely blocked
    // by verification ('pending'/'invalid'/never-checked) is SKIPPED rather than
    // stopped: verification may still resolve and the step must not be burned.
    const contactStatus = row.contact_status ?? "active";
    if (contactStatus !== "active") {
      await stopEnrollment(env, e, contactStatus === "unsubscribed" ? "unsubscribe" : "blocked", now);
      continue;
    }
    if (isSendBlocked(row.email_status)) {
      continue;
    }
    const suppressed = await env.DB.prepare("SELECT 1 AS x FROM suppressions WHERE email=?")
      .bind(e.email)
      .first();
    if (suppressed) {
      await stopEnrollment(env, e, "suppressed", now);
      continue;
    }

    // Release: the unique index is the idempotency key. Only a row THIS call
    // inserted is enqueued, so overlapping ticks cannot double-send.
    const ins = await env.DB.prepare(
      `INSERT OR IGNORE INTO sequence_sends
         (sequence_id, enrollment_id, step_id, step_position, contact_id, email, status, queued_at)
       VALUES (?,?,?,?,?,?, 'queued', ?)`,
    )
      .bind(seq.id, e.id, step.id, step.position, e.contact_id, e.email, now)
      .run();

    if (Number(ins.meta?.changes ?? 0) === 0) {
      // The row already existed (another tick got there first). Advance the
      // enrolment's advisory due so we do not re-scan it every second.
      const { dueAt } = recomputeNextDue(steps, e);
      await env.DB.prepare(
        "UPDATE sequence_enrollments SET next_due_at=?, updated_at=unixepoch() WHERE id=?",
      )
        .bind(dueAt ?? now + 3600, e.id)
        .run();
      continue;
    }

    const sendId = Number(ins.meta.last_row_id);
    // Advance the enrolment NOW (release == consumed, exactly like a campaign's
    // sends row). last_sent_at is the anchor for the next step's wait.
    const next = nextStepAfter(steps, step.position);
    const newDue = next ? nextDueAt(next, now, e.enrolled_at) : null;
    await env.DB.prepare(
      `UPDATE sequence_enrollments
          SET last_sent_position=?, last_sent_at=?, next_due_at=?, updated_at=unixepoch()
        WHERE id=?`,
    )
      .bind(step.position, now, newDue, e.id)
      .run();

    await env.DB.prepare(
      "UPDATE sequences SET started_at=COALESCE(started_at, unixepoch()) WHERE id=?",
    )
      .bind(seq.id)
      .run();

    const job: SendJob = {
      sequence_id: seq.id,
      sequence_send_id: sendId,
      contact_id: e.contact_id,
      email: e.email,
    };
    await env.SEND_QUEUE.send(job);
    released++;

    if (!next) {
      await env.DB.prepare(
        "UPDATE sequence_enrollments SET status='completed' WHERE id=? AND status='active'",
      )
        .bind(e.id)
        .run();
      await recordEvent(env, seq.id, e.id, e.contact_id, "completed", `position:${step.position}`);
    }
  }

  return { id: seq.id, action: released > 0 ? "released" : "waiting", released };
}

/**
 * Cron entry point for sequences. Guarded by the single-flight lease so a pass
 * that outlives its minute cannot overlap the next tick; the lease is always
 * released in `finally` (a crashed pass is reclaimed by the stale timeout).
 */
export async function dispatchSequences(
  env: Env,
  nowSeconds?: number,
): Promise<{ ran: number; released: number; skipped?: boolean; sequences: SequenceTickResult[] }> {
  const now = now2(nowSeconds);
  const lease = await acquireSequenceLease(env, now);
  if (!lease.acquired) {
    return { ran: 0, released: 0, skipped: true, sequences: [] };
  }
  try {
    const active = await env.DB.prepare("SELECT * FROM sequences WHERE status='active'").all<SequenceRow>();
    const results: SequenceTickResult[] = [];
    let released = 0;
    for (const seq of active.results ?? []) {
      try {
        const tick = await runSequenceTick(env, seq, { nowSeconds: now });
        results.push(tick);
        released += tick.released;
      } catch (err) {
        console.error("sequence tick failed", seq.id, err instanceof Error ? err.message : String(err));
      }
    }
    return { ran: results.length, released, sequences: results };
  } finally {
    await releaseSequenceLease(env, lease.owner);
  }
}

// ---------------------------------------------------------------------------
// Enrolment, re-enrolment, removal, stopping
// ---------------------------------------------------------------------------

async function recordEvent(
  env: Env,
  sequenceId: number,
  enrollmentId: number | null,
  contactId: number | null,
  type: string,
  detail?: string,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO sequence_events (sequence_id, enrollment_id, contact_id, type, detail) VALUES (?,?,?,?,?)",
  )
    .bind(sequenceId, enrollmentId, contactId, type, detail ?? null)
    .run();
}

export type EnrollMode = "restart" | "resume";

/**
 * CAPTURE AND HOLD. A contact enrolled while the target sequence is still a
 * draft is captured (the enrolment exists) but their clock is NOT started:
 * `next_due_at` is left NULL. The wait begins at activation - see
 * releaseHeldEnrollments - so a lead that sits in a draft for a week does not
 * become instantly due the moment it is switched on.
 *
 * A held enrolment is exactly `status='active' AND next_due_at IS NULL`; the
 * dispatcher skips those rows (see runSequenceTick), so a held contact sends
 * nothing while it waits.
 */
function isDraft(seq: Partial<SequenceRow>): boolean {
  return seq.status === "draft";
}

/**
 * Release every held enrolment when a sequence becomes active: set the clock to
 * activation time + step 1's wait. `enrolled_at` is reset to the activation
 * instant too, because step 1's wait is anchored on `enrolled_at` - without
 * that the dispatcher would recompute the wait from the original (draft-time)
 * enrolment and fire immediately. Enrolments already mid-sequence (a non-NULL
 * next_due_at) are untouched, so they continue normally.
 */
export async function releaseHeldEnrollments(
  env: Env,
  seq: SequenceRow,
  nowSeconds?: number,
): Promise<number> {
  const now = now2(nowSeconds);
  const steps = await loadSteps(env, seq.id);
  const first = steps[0] ?? null;
  if (!first) return 0;
  const dueAt = nextDueAt(first, null, now);
  const held = await env.DB.prepare(
    `SELECT id, contact_id FROM sequence_enrollments
      WHERE sequence_id=? AND status='active' AND next_due_at IS NULL`,
  )
    .bind(seq.id)
    .all<{ id: number; contact_id: number }>();
  let released = 0;
  for (const e of held.results ?? []) {
    const r = await env.DB.prepare(
      `UPDATE sequence_enrollments
          SET enrolled_at=?, next_due_at=?, updated_at=unixepoch()
        WHERE id=? AND status='active' AND next_due_at IS NULL`,
    )
      .bind(now, dueAt, e.id)
      .run();
    if (Number(r.meta?.changes ?? 0) > 0) {
      await recordEvent(env, seq.id, e.id, e.contact_id, "released", `held:activation,position:${first.position}`);
      released++;
    }
  }
  return released;
}

export interface EnrollResult {
  enrolled: number;
  reenrolled: number;
  skipped: number;
}

/**
 * Enrol contacts in a sequence. `restart` (the default) resets progress and
 * clears the contact's previous send rows so step 1 can go out again; `resume`
 * keeps progress. Both are explicit actions and are recorded in sequence_events.
 */
export async function enrollContacts(
  env: Env,
  seq: SequenceRow,
  contacts: AudienceRow[],
  mode: EnrollMode = "restart",
  nowSeconds?: number,
): Promise<EnrollResult> {
  const now = now2(nowSeconds);
  const steps = await loadSteps(env, seq.id);
  const first = steps[0] ?? null;
  const draft = isDraft(seq);
  const out: EnrollResult = { enrolled: 0, reenrolled: 0, skipped: 0 };

  for (const c of contacts) {
    const existing = await env.DB.prepare(
      "SELECT * FROM sequence_enrollments WHERE sequence_id=? AND contact_id=?",
    )
      .bind(seq.id, c.id)
      .first<EnrollmentRow>();

    if (existing) {
      if (mode === "restart") {
        // Clear the prior run's send rows so the UNIQUE (sequence,contact,position)
        // key frees up for a fresh step 1. History stays in sequence_events.
        await env.DB.prepare(
          "DELETE FROM sequence_sends WHERE sequence_id=? AND enrollment_id=?",
        )
          .bind(seq.id, existing.id)
          .run();
        // Draft => held: no clock until the sequence is activated.
        const dueAt = draft ? null : first ? nextDueAt(first, now, now) : null;
        await env.DB.prepare(
          `UPDATE sequence_enrollments
              SET status='active', stop_reason=NULL, enrolled_at=?, last_sent_position=0,
                  last_sent_at=NULL, next_due_at=?, restarts=restarts+1, updated_at=unixepoch()
            WHERE id=?`,
        )
          .bind(now, dueAt, existing.id)
          .run();
        await recordEvent(env, seq.id, existing.id, c.id, "re-enrolled", `mode:restart,from:${existing.last_sent_position}${draft ? ",held:draft" : ""}`);
      } else {
        const { dueAt, step } = recomputeNextDue(steps, existing);
        // Resume keeps progress: a contact with no step left stays completed; a
        // stopped/removed contact goes back to active at the step they reached.
        const status = step ? "active" : "completed";
        await env.DB.prepare(
          `UPDATE sequence_enrollments
              SET status=?, stop_reason=NULL, next_due_at=?, updated_at=unixepoch()
            WHERE id=?`,
        )
          .bind(status, draft && step ? null : dueAt, existing.id)
          .run();
        await recordEvent(env, seq.id, existing.id, c.id, "re-enrolled", `mode:resume,from:${existing.last_sent_position}${draft ? ",held:draft" : ""}`);
      }
      out.reenrolled++;
      continue;
    }

    const dueAt = draft ? null : first ? nextDueAt(first, null, now) : null;
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO sequence_enrollments
         (sequence_id, contact_id, email, status, enrolled_at, last_sent_position, next_due_at)
       VALUES (?,?,?, 'active', ?, 0, ?) RETURNING id`,
    )
      .bind(seq.id, c.id, c.email, now, dueAt)
      .first<{ id: number }>();
    if (!r?.id) {
      out.skipped++;
      continue;
    }
    await recordEvent(env, seq.id, r.id, c.id, "enrolled", `mode:new${draft ? ",held:draft" : ""}`);
    out.enrolled++;
  }
  return out;
}

/** Re-enrol a single existing enrolment (used by the per-recipient UI). */
export async function reenroll(
  env: Env,
  seq: SequenceRow,
  enrollmentId: number,
  mode: EnrollMode,
  nowSeconds?: number,
): Promise<boolean> {
  const e = await env.DB.prepare(
    "SELECT * FROM sequence_enrollments WHERE id=? AND sequence_id=?",
  )
    .bind(enrollmentId, seq.id)
    .first<EnrollmentRow>();
  if (!e) return false;
  const steps = await loadSteps(env, seq.id);
  const first = steps[0] ?? null;
  const now = now2(nowSeconds);
  const draft = isDraft(seq);

  if (mode === "restart") {
    await env.DB.prepare("DELETE FROM sequence_sends WHERE sequence_id=? AND enrollment_id=?")
      .bind(seq.id, e.id)
      .run();
    await env.DB.prepare(
      `UPDATE sequence_enrollments
          SET status='active', stop_reason=NULL, enrolled_at=?, last_sent_position=0,
              last_sent_at=NULL, next_due_at=?, restarts=restarts+1, updated_at=unixepoch()
        WHERE id=?`,
    )
      .bind(now, draft ? null : first ? nextDueAt(first, now, now) : null, e.id)
      .run();
  } else {
    const { dueAt, step } = recomputeNextDue(steps, e);
    const status = step ? "active" : "completed";
    await env.DB.prepare(
      "UPDATE sequence_enrollments SET status=?, stop_reason=NULL, next_due_at=?, updated_at=unixepoch() WHERE id=?",
    )
      .bind(status, draft && step ? null : dueAt, e.id)
      .run();
  }
  await recordEvent(env, seq.id, e.id, e.contact_id, "re-enrolled", `mode:${mode},from:${e.last_sent_position}${draft ? ",held:draft" : ""}`);
  return true;
}

/** Remove an enrolment from a sequence (progress kept for history). */
export async function removeEnrollment(
  env: Env,
  sequenceId: number,
  enrollmentId: number,
): Promise<boolean> {
  const e = await env.DB.prepare(
    "SELECT * FROM sequence_enrollments WHERE id=? AND sequence_id=?",
  )
    .bind(enrollmentId, sequenceId)
    .first<EnrollmentRow>();
  if (!e) return false;
  await env.DB.prepare(
    "UPDATE sequence_enrollments SET status='removed', stop_reason='manual', updated_at=unixepoch() WHERE id=?",
  )
    .bind(enrollmentId)
    .run();
  await recordEvent(env, sequenceId, e.id, e.contact_id, "removed", "manual");
  return true;
}

/** Stop one enrolment, recording why. */
async function stopEnrollment(
  env: Env,
  e: EnrollmentRow,
  reason: string,
  nowSeconds: number,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE sequence_enrollments SET status='stopped', stop_reason=?, updated_at=unixepoch() WHERE id=? AND status='active'",
  )
    .bind(reason, e.id)
    .run();
  await recordEvent(env, e.sequence_id, e.id, e.contact_id, "stopped", reason);
}

/**
 * Stop EVERY active sequence enrolment for a contact - the standalone
 * unsubscribe / hard-bounce rule. Called from the SMTP2Go webhook. Returns how
 * many enrolments were stopped.
 */
export async function stopContactSequences(
  env: Env,
  opts: { email: string; contactId?: number | null },
  reason: string,
  nowSeconds?: number,
): Promise<number> {
  const now = now2(nowSeconds);
  const rows = await env.DB.prepare(
    `SELECT e.* FROM sequence_enrollments e
      WHERE e.status='active'
        AND (e.email = ? OR (? IS NOT NULL AND e.contact_id = ?))`,
  )
    .bind(opts.email.toLowerCase(), opts.contactId ?? null, opts.contactId ?? null)
    .all<EnrollmentRow>();
  let stopped = 0;
  for (const e of rows.results ?? []) {
    await stopEnrollment(env, e, reason, now);
    stopped++;
  }
  return stopped;
}

// ---------------------------------------------------------------------------
// Appending a step: release preview + explicit confirm
// ---------------------------------------------------------------------------

export interface ReleasePreview {
  /** Steps not yet released to completed enrolments. */
  pending_steps: { id: number; position: number; name: string | null }[];
  /** Completed enrolments that would newly qualify (would be re-activated). */
  would_qualify: number;
  /** Active enrolments, which are unaffected (they proceed automatically). */
  remain_active: number;
}

/**
 * What a release would do. Nothing is written. A completed enrolment qualifies
 * when a not-yet-released step now sits AHEAD of the position it reached.
 */
export async function releasePreview(env: Env, seq: SequenceRow): Promise<ReleasePreview> {
  const steps = await loadSteps(env, seq.id);
  const pending = steps.filter((s) => s.released_to_completed_at == null);

  const active = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM sequence_enrollments WHERE sequence_id=? AND status='active'",
  )
    .bind(seq.id)
    .first<{ n: number }>();

  const q = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM sequence_enrollments e
      WHERE e.sequence_id=? AND e.status='completed'
        AND EXISTS (SELECT 1 FROM sequence_steps s
                     WHERE s.sequence_id = e.sequence_id
                       AND s.released_to_completed_at IS NULL
                       AND s.position > e.last_sent_position)`,
  )
    .bind(seq.id)
    .first<{ n: number }>();

  // Only the steps that actually sit ahead of a completed contact are "awaiting
  // release"; the earlier unreleased steps were already delivered to them.
  const ahead = await env.DB.prepare(
    `SELECT DISTINCT s.id, s.position, s.name FROM sequence_steps s
      WHERE s.sequence_id = ? AND s.released_to_completed_at IS NULL
        AND EXISTS (SELECT 1 FROM sequence_enrollments e
                     WHERE e.sequence_id = s.sequence_id AND e.status='completed'
                       AND e.last_sent_position < s.position)
      ORDER BY s.position`,
  )
    .bind(seq.id)
    .all<{ id: number; position: number; name: string | null }>();

  return {
    pending_steps: ahead.results ?? [],
    would_qualify: q?.n ?? 0,
    remain_active: active?.n ?? 0,
  };
}

/**
 * Confirm the release: mark the not-yet-released steps released and re-activate
 * the completed enrolments they now lead. This is the ONLY path by which a
 * completed contact can receive an appended step.
 */
export async function confirmRelease(
  env: Env,
  seq: SequenceRow,
  opts: { nowSeconds?: number; stepIds?: number[] } = {},
): Promise<{ released_steps: number; reactivated: number }> {
  const now = now2(opts.nowSeconds);
  const steps = await loadSteps(env, seq.id);

  // The steps that genuinely await release: not yet released AND ahead of a
  // completed contact. Only these are marked, so the count is meaningful.
  const rows = await env.DB.prepare(
    `SELECT DISTINCT s.id FROM sequence_steps s
      WHERE s.sequence_id = ? AND s.released_to_completed_at IS NULL
        AND EXISTS (SELECT 1 FROM sequence_enrollments e
                     WHERE e.sequence_id = s.sequence_id AND e.status='completed'
                       AND e.last_sent_position < s.position)`,
  )
    .bind(seq.id)
    .all<{ id: number }>();
  let ids = (rows.results ?? []).map((r) => Number(r.id));
  if (opts.stepIds?.length) {
    const set = new Set(opts.stepIds);
    ids = ids.filter((i) => set.has(i));
  }
  if (!ids.length) return { released_steps: 0, reactivated: 0 };

  for (const id of ids) {
    await env.DB.prepare(
      "UPDATE sequence_steps SET released_to_completed_at=? WHERE id=? AND released_to_completed_at IS NULL",
    )
      .bind(now, id)
      .run();
  }

  const done = await env.DB.prepare(
    `SELECT e.* FROM sequence_enrollments e
      WHERE e.sequence_id=? AND e.status='completed'
        AND EXISTS (SELECT 1 FROM sequence_steps s
                     WHERE s.sequence_id = e.sequence_id
                       AND s.released_to_completed_at IS NOT NULL
                       AND s.position > e.last_sent_position)`,
  )
    .bind(seq.id)
    .all<EnrollmentRow>();

  let reactivated = 0;
  for (const e of done.results ?? []) {
    const step = nextStepAfter(steps, e.last_sent_position);
    if (!step) continue;
    // The wait restarts from the release: a released append is a fresh start for
    // a completed contact, not a back-dated send.
    const dueAt = now + Math.max(0, Math.floor(step.wait_minutes)) * 60;
    await env.DB.prepare(
      "UPDATE sequence_enrollments SET status='active', last_sent_at=?, next_due_at=?, updated_at=unixepoch() WHERE id=?",
    )
      .bind(now, dueAt, e.id)
      .run();
    await recordEvent(env, seq.id, e.id, e.contact_id, "released", `position:${step.position}`);
    reactivated++;
  }

  return { released_steps: ids.length, reactivated };
}

// ---------------------------------------------------------------------------
// Metrics & per-recipient view
// ---------------------------------------------------------------------------

export interface StepMetric {
  position: number;
  step_id: number | null;
  name: string | null;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  unsubscribed: number;
}

export async function sequenceMetrics(
  env: Env,
  seq: SequenceRow,
): Promise<{ steps: StepMetric[]; funnel: { position: number; reached: number }[] }> {
  const steps = await loadSteps(env, seq.id);
  const rows = await env.DB.prepare(
    `SELECT step_position,
            COUNT(*) AS total,
            SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sent,
            SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered,
            SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
            SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked,
            SUM(CASE WHEN bounced_at IS NOT NULL THEN 1 ELSE 0 END) AS bounced,
            SUM(CASE WHEN unsubscribed_at IS NOT NULL THEN 1 ELSE 0 END) AS unsubscribed
       FROM sequence_sends WHERE sequence_id=? GROUP BY step_position`,
  )
    .bind(seq.id)
    .all<any>();
  const byPos = new Map<number, any>();
  for (const r of rows.results ?? []) byPos.set(Number(r.step_position), r);

  const metrics: StepMetric[] = steps.map((s) => {
    const r = byPos.get(s.position);
    return {
      position: s.position,
      step_id: s.id,
      name: s.name,
      sent: Number(r?.sent ?? 0),
      delivered: Number(r?.delivered ?? 0),
      opened: Number(r?.opened ?? 0),
      clicked: Number(r?.clicked ?? 0),
      bounced: Number(r?.bounced ?? 0),
      unsubscribed: Number(r?.unsubscribed ?? 0),
    };
  });
  // A cross-step funnel: how many contacts were RELEASED each step. Derived from
  // the send records (which exist at release), not from `sent_at`, so it is
  // meaningful while a step is still queued.
  const funnel = steps.map((s) => ({
    position: s.position,
    reached: Number(byPos.get(s.position)?.total ?? 0),
  }));
  return { steps: metrics, funnel };
}

export interface EnrollmentViewRow {
  id: number;
  contact_id: number;
  email: string;
  name: string | null;
  status: string;
  stop_reason: string | null;
  last_sent_position: number;
  last_sent_at: number | null;
  next_step_position: number | null;
  next_due_at: number | null;
  timezone: string | null;
  history: { type: string; detail: string | null; at: number }[];
}

/** Per-recipient view: which step each enrolled contact is on, when the next is due, and history. */
export async function sequenceEnrollments(
  env: Env,
  seq: SequenceRow,
  opts: { limit?: number; offset?: number; status?: string } = {},
): Promise<{ rows: EnrollmentViewRow[]; total: number }> {
  const steps = await loadSteps(env, seq.id);
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const statusFilter = opts.status && opts.status !== "all" ? opts.status : null;

  const where = statusFilter ? "e.sequence_id = ? AND e.status = ?" : "e.sequence_id = ?";
  const binds: any[] = statusFilter ? [seq.id, statusFilter] : [seq.id];

  const rows = await env.DB.prepare(
    `SELECT e.id, e.contact_id, e.email, e.status, e.stop_reason, e.last_sent_position,
            e.last_sent_at, e.next_due_at, c.timezone,
            COALESCE(NULLIF(TRIM(c.practice_name),''), NULLIF(TRIM(c.first_name),''), NULLIF(TRIM(c.last_name),'')) AS contact_name
       FROM sequence_enrollments e LEFT JOIN contacts c ON c.id = e.contact_id
      WHERE ${where}
      ORDER BY e.next_due_at IS NULL, e.next_due_at, e.id
      LIMIT ${limit} OFFSET ${offset}`,
  )
    .bind(...binds)
    .all<any>();

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM sequence_enrollments e WHERE ${where}`,
  )
    .bind(...binds)
    .first<{ n: number }>();

  const out: EnrollmentViewRow[] = [];
  for (const r of rows.results ?? []) {
    const next = nextStepAfter(steps, Number(r.last_sent_position));
    const history = await env.DB.prepare(
      "SELECT type, detail, created_at FROM sequence_events WHERE enrollment_id=? ORDER BY created_at DESC, id DESC LIMIT 20",
    )
      .bind(r.id)
      .all<{ type: string; detail: string | null; created_at: number }>();
    out.push({
      id: r.id,
      contact_id: r.contact_id,
      email: r.email,
      name: r.contact_name ?? null,
      status: r.status,
      stop_reason: r.stop_reason ?? null,
      last_sent_position: Number(r.last_sent_position),
      last_sent_at: r.last_sent_at ?? null,
      next_step_position: r.status === "active" && next ? next.position : null,
      next_due_at: r.status === "active" ? (r.next_due_at ?? null) : null,
      timezone: r.timezone ?? null,
      history: (history.results ?? []).map((h) => ({ type: h.type, detail: h.detail, at: h.created_at })),
    });
  }
  return { rows: out, total: Number(totalRow?.n ?? 0) };
}

// ---------------------------------------------------------------------------
// TEST MODE - run a whole sequence to one address, waits compressed to minutes
// ---------------------------------------------------------------------------

export interface TestRunPlanStep {
  step_id: number;
  position: number;
  delay_seconds: number;
  subject_preview: string | null;
}

/**
 * Send the whole sequence to one address, with every wait compressed to at most
 * `compressMinutes`. No enrolment is created and nothing lands in sequence_sends
 * or the metrics - the sends are recorded in sequence_test_sends only, and the
 * consumer's test branch never touches the real tables.
 */
export async function runSequenceTest(
  env: Env,
  seq: SequenceRow,
  email: string,
  opts: { compressMinutes?: number } = {},
): Promise<{ queued: number; plan: TestRunPlanStep[] }> {
  const steps = await loadSteps(env, seq.id);
  const compress = Math.max(1, Math.floor(opts.compressMinutes ?? 1));
  const plan: TestRunPlanStep[] = [];
  let elapsed = 0;
  for (const s of steps) {
    const wait = Math.min(Math.max(0, Math.floor(s.wait_minutes)), compress);
    elapsed += wait * 60;
    plan.push({ step_id: s.id, position: s.position, delay_seconds: elapsed, subject_preview: s.subject });
  }
  for (const p of plan) {
    await env.DB.prepare(
      "INSERT INTO sequence_test_sends (sequence_id, step_position, email) VALUES (?,?,?)",
    )
      .bind(seq.id, p.position, email.toLowerCase())
      .run();
    const job: SendJob = {
      test: true,
      sequence_id: seq.id,
      step_position: p.position,
      contact_id: null,
      email: email.toLowerCase(),
    };
    await env.SEND_QUEUE.send(job, { delaySeconds: p.delay_seconds });
  }
  return { queued: plan.length, plan };
}

// ---------------------------------------------------------------------------
// Progress / detail
// ---------------------------------------------------------------------------

export async function sequenceProgress(env: Env, seq: SequenceRow, nowSeconds?: number) {
  const now = now2(nowSeconds);
  const steps = await loadSteps(env, seq.id);
  const timezone = sequenceTimeZone(env, seq);
  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status='stopped' THEN 1 ELSE 0 END) AS stopped,
            SUM(CASE WHEN status='removed' THEN 1 ELSE 0 END) AS removed
       FROM sequence_enrollments WHERE sequence_id=?`,
  )
    .bind(seq.id)
    .first<any>();
  const sent = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued
       FROM sequence_sends WHERE sequence_id=?`,
  )
    .bind(seq.id)
    .first<any>();
  const allowance = await sequenceAllowance(env, seq, timezone, now);
  const due = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM sequence_enrollments
      WHERE sequence_id=? AND status='active' AND (next_due_at IS NULL OR next_due_at <= ?)`,
  )
    .bind(seq.id, now)
    .first<{ n: number }>();

  return {
    timezone,
    step_count: steps.length,
    daily_cap: normalizeDailyCap(seq.daily_cap),
    ramp_start: normalizeRampStart(seq.ramp_start),
    ramp_days: normalizeRampDays(seq.ramp_days),
    spread_minutes: normalizeSpreadMinutes(seq.spread_minutes),
    send_days: parseSendDays(seq.send_days),
    send_time: normalizeSendTime(seq.send_time),
    released_today: allowance.releasedToday,
    today_ceiling: allowance.dayCeiling,
    due_now: due?.n ?? 0,
    enrollments: {
      total: Number(counts?.total ?? 0),
      active: Number(counts?.active ?? 0),
      completed: Number(counts?.completed ?? 0),
      stopped: Number(counts?.stopped ?? 0),
      removed: Number(counts?.removed ?? 0),
    },
    sends: { total: Number(sent?.total ?? 0), queued: Number(sent?.queued ?? 0) },
  };
}
