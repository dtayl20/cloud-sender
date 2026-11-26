// Shared send-plan helpers for daily-batch ("drip") sending.
//
// A campaign may carry a plan:
//   daily_cap      - most recipients released per day (null = no cap)
//   send_days      - allowed ISO weekdays as a CSV list, Mon=1 … Sun=7 (null = any day)
//   send_time      - "HH:MM" local, when the day's batch goes out (null = any time)
//   send_timezone  - IANA zone the window is measured in (null = the Worker var)
//   ramp_start     - allowance on the FIRST sending day (null = no ramp)
//   ramp_days      - sending days until the full daily_cap is reached
//   spread_minutes - minutes to spread each day's batch across (null = all at
//                    the window, today's behaviour)
//
// Everything here is pure — no DB, no fetch, no Date.now() — so the cron
// dispatcher, the API and the React editor all agree on what a plan means, and
// the calendar arithmetic can be unit-tested against fixed instants.
//
// Timezone note: the local day boundary is computed with Intl, never by adding a
// fixed offset to UTC. A send at 23:59 Sydney has to count to that Sydney day,
// and the day is not always 24 hours long (DST).

export const DEFAULT_SEND_TIMEZONE = "Australia/Brisbane";

/** ISO weekday numbers, Monday = 1 … Sunday = 7. */
export const WEEKDAY_LABELS: { value: number; short: string; long: string }[] = [
  { value: 1, short: "Mon", long: "Monday" },
  { value: 2, short: "Tue", long: "Tuesday" },
  { value: 3, short: "Wed", long: "Wednesday" },
  { value: 4, short: "Thu", long: "Thursday" },
  { value: 5, short: "Fri", long: "Friday" },
  { value: 6, short: "Sat", long: "Saturday" },
  { value: 7, short: "Sun", long: "Sunday" },
];

/** The seven plan columns as they sit on a campaign row (all nullable). */
export interface SendPlan {
  daily_cap: number | null;
  send_days: string | null;
  send_time: string | null;
  send_timezone: string | null;
  ramp_start: number | null;
  ramp_days: number | null;
  spread_minutes: number | null;
}

/** A plan is present when any of cap / days / time is set. Timezone alone is not a plan. */
export function hasSendPlan(camp: Partial<SendPlan> | null | undefined): boolean {
  if (!camp) return false;
  return camp.daily_cap != null || camp.send_days != null || camp.send_time != null;
}

/** True when `tz` is an IANA zone this runtime can resolve. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

/**
 * A usable zone: the campaign's, else the caller's fallback, else the built-in
 * default, else UTC. Never throws and never returns something unusable, so a
 * typo in a campaign or in SEND_TIMEZONE cannot stop the dispatcher.
 */
export function resolveTimeZone(
  tz: unknown,
  fallback: unknown = DEFAULT_SEND_TIMEZONE,
): string {
  if (isValidTimeZone(tz)) return tz.trim();
  if (isValidTimeZone(fallback)) return fallback.trim();
  if (isValidTimeZone(DEFAULT_SEND_TIMEZONE)) return DEFAULT_SEND_TIMEZONE;
  return "UTC";
}

export interface TimeOfDay {
  hour: number;
  minute: number;
  /** Canonical "HH:MM". */
  hhmm: string;
  /** Minutes since local midnight — what the window comparison uses. */
  minutes: number;
}

/** Parse "HH:MM" (or "H:MM"). Anything else — including 24:00 — is null. */
export function parseSendTime(raw: unknown): TimeOfDay | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour > 23 || minute > 59) return null;
  return {
    hour,
    minute,
    hhmm: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    minutes: hour * 60 + minute,
  };
}

/** Canonical "HH:MM" for storage, or null for blank/invalid. */
export function normalizeSendTime(raw: unknown): string | null {
  return parseSendTime(raw)?.hhmm ?? null;
}

/** ISO weekday list from a CSV string or an array of numbers/strings. */
export function parseSendDays(raw: unknown): number[] | null {
  let parts: string[];
  if (Array.isArray(raw)) parts = raw.map((v) => String(v));
  else if (typeof raw === "string") parts = raw.split(",");
  else return null;
  const out: number[] = [];
  for (const part of parts) {
    const n = Number(String(part).trim());
    if (!Number.isInteger(n) || n < 1 || n > 7) continue;
    if (!out.includes(n)) out.push(n);
  }
  if (!out.length) return null;
  return out.sort((a, b) => a - b);
}

/** CSV form for storage, or null when no day is selected. */
export function formatSendDays(days: number[] | null | undefined): string | null {
  const parsed = parseSendDays(days ?? null);
  return parsed ? parsed.join(",") : null;
}

/** Positive whole-day cap, or null (= no cap). */
export function normalizeDailyCap(raw: unknown): number | null {
  if (raw === "" || raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i > 0 ? i : null;
}

/** Positive whole-recipient first-day allowance, or null (= no ramp). */
export function normalizeRampStart(raw: unknown): number | null {
  return normalizeDailyCap(raw);
}

/**
 * How many sending days the ramp takes to reach the cap: a positive whole
 * number, or null. `1` is accepted and stored, and simply means "no ramp" (there
 * is no day to grow across) - the same thing a null means, without a surprise.
 */
export function normalizeRampDays(raw: unknown): number | null {
  return normalizeDailyCap(raw);
}

// ---------------------------------------------------------------------------
// The ramp (a rising daily cap)
// ---------------------------------------------------------------------------

/** A ramp that is actually in effect: a start below the cap and >= 2 days. */
export interface SendRamp {
  start: number;
  days: number;
}

/**
 * The ramp a plan really uses, or null for "no ramp" (= the flat daily cap).
 *
 * A ramp needs all four of: a daily cap to grow into, both fields set, a
 * `ramp_start` below that cap, and at least two sending days. Anything else -
 * a start at/above the cap, `ramp_days = 1`, a lone start or a cap-less plan -
 * is not a ramp, so the plan behaves exactly as a flat cap does. That is
 * deliberate: a malformed ramp must fall back to predictable, never to a
 * surprising first day.
 */
export function sendRamp(plan: Partial<SendPlan> | null | undefined): SendRamp | null {
  if (!plan) return null;
  const cap = normalizeDailyCap(plan.daily_cap);
  const start = normalizeRampStart(plan.ramp_start);
  const days = normalizeRampDays(plan.ramp_days);
  if (cap == null || start == null || days == null) return null;
  if (days < 2 || start >= cap) return null;
  return { start, days };
}

/**
 * The allowance for the k-th sending day (k = 1, 2, 3 …): the ramp_start
 * growing evenly to the cap by day `ramp_days`, then the cap forever.
 *
 *   round(start + (cap - start) * (k - 1) / (days - 1))   for k <  days
 *   cap                                                    for k >= days
 *
 * Rounded to a whole recipient and monotonic non-decreasing, so day 1 is
 * exactly `start` and day `ramp_days` is exactly the cap - never above it.
 * With no ramp this is the flat cap, whatever k is.
 */
export function rampAllowanceAt(cap: number, ramp: SendRamp | null, sendingDay: number): number {
  if (!ramp) return cap;
  const k = Math.max(1, Math.floor(sendingDay));
  if (k >= ramp.days) return cap;
  const step = (cap - ramp.start) / (ramp.days - 1);
  return Math.round(ramp.start + step * (k - 1));
}

/**
 * The total allowance for TODAY's sending day, given how many sending days the
 * campaign has already used strictly before today.
 *
 * `priorSendingDays` comes from the sends table (distinct local days with
 * sends), never from a stored counter. Today is sending day `prior + 1` - the
 * same today that has already released something included, because a day that
 * already sent is already on its own step. Null means "no cap", and then the
 * whole remaining audience goes out at the first window.
 */
export function todayRampAllowance(
  plan: Partial<SendPlan> | null | undefined,
  priorSendingDays: number,
): number | null {
  const cap = normalizeDailyCap(plan?.daily_cap ?? null);
  if (cap == null) return null;
  return rampAllowanceAt(cap, sendRamp(plan), priorSendingDays + 1);
}

// ---------------------------------------------------------------------------
// Timezone / calendar arithmetic
// ---------------------------------------------------------------------------

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  /** ISO weekday in that zone: Mon=1 … Sun=7. */
  weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(tz, f);
  }
  return f;
}

/** Wall-clock fields for an instant, in `tz`. */
export function zonedParts(epochSeconds: number, tz: string): ZonedParts {
  const parts = zonedFormatter(tz).formatToParts(new Date(epochSeconds * 1000));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  let hour = get("hour");
  // Some ICU builds report midnight as 24 under hour12:false.
  if (hour === 24) hour = 0;
  const year = get("year");
  const month = get("month");
  const day = get("day");
  return {
    year,
    month,
    day,
    hour,
    minute: get("minute"),
    second: get("second"),
    weekday: isoWeekday(year, month, day),
  };
}

export function isoWeekday(year: number, month: number, day: number): number {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
  return dow === 0 ? 7 : dow;
}

/** Seconds to ADD to an instant to get the local wall clock in `tz`. */
function zoneOffsetSeconds(epochSeconds: number, tz: string): number {
  const p = zonedParts(epochSeconds, tz);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
  return asUTC - epochSeconds;
}

/**
 * Epoch seconds of a local wall-clock time in `tz`.
 * Iterated so a DST transition resolves to the same instant the zone really
 * uses (the offset at the guessed instant, re-checked once it moves).
 */
export function zonedWallClockToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const next = wall - zoneOffsetSeconds(guess, tz);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

export function addLocalDays(
  year: number,
  month: number,
  day: number,
  delta: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + delta);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function localDayKey(p: { year: number; month: number; day: number }): string {
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The local calendar day containing `epochSeconds`: [start, end) in epoch seconds. */
export function localDayWindow(
  epochSeconds: number,
  tz: string,
): { start: number; end: number; dayKey: string; weekday: number } {
  const p = zonedParts(epochSeconds, tz);
  const start = zonedWallClockToEpoch(p.year, p.month, p.day, 0, 0, 0, tz);
  const next = addLocalDays(p.year, p.month, p.day, 1);
  const end = zonedWallClockToEpoch(next.year, next.month, next.day, 0, 0, 0, tz);
  return { start, end, dayKey: localDayKey(p), weekday: p.weekday };
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

export interface PlanEvaluation {
  timezone: string;
  dayKey: string;
  weekday: number;
  /** The weekday is allowed by send_days. */
  dayAllowed: boolean;
  /** The day is allowed AND the local clock is at/after send_time. */
  windowOpen: boolean;
  minutesNow: number;
  /** Next instant at/after now when a release could happen. */
  nextWindowAt: number;
}

/**
 * Where "now" sits in a plan's window. A null send_days allows every day; a
 * null send_time opens the window at local midnight.
 */
export function evaluatePlanNow(opts: {
  nowSeconds: number;
  timezone: string;
  sendDays: number[] | null;
  sendTime: TimeOfDay | null;
}): PlanEvaluation {
  const { nowSeconds, timezone, sendDays, sendTime } = opts;
  const p = zonedParts(nowSeconds, timezone);
  const dayAllowed = !sendDays || sendDays.includes(p.weekday);
  const minutesNow = p.hour * 60 + p.minute;
  const atOrAfter = !sendTime || minutesNow >= sendTime.minutes;
  return {
    timezone,
    dayKey: localDayKey(p),
    weekday: p.weekday,
    dayAllowed,
    windowOpen: dayAllowed && atOrAfter,
    minutesNow,
    nextWindowAt: nextWindowStart({ nowSeconds, timezone, sendDays, sendTime }),
  };
}

/**
 * The next instant at/after `nowSeconds` at which a batch could be released:
 * today's send_time when it is still ahead and today is allowed, otherwise the
 * send_time of the next allowed day. Null send_time means the window is open all
 * day, so an allowed day returns `nowSeconds` itself.
 */
export function nextWindowStart(opts: {
  nowSeconds: number;
  timezone: string;
  sendDays: number[] | null;
  sendTime: TimeOfDay | null;
}): number {
  const { nowSeconds, timezone, sendDays, sendTime } = opts;
  let cursor = nowSeconds;
  for (let i = 0; i < 15; i++) {
    const window = localDayWindow(cursor, timezone);
    const allowed = !sendDays || sendDays.includes(window.weekday);
    if (allowed) {
      if (!sendTime) return Math.max(cursor, window.start);
      const p = zonedParts(cursor, timezone);
      const at = zonedWallClockToEpoch(
        p.year,
        p.month,
        p.day,
        sendTime.hour,
        sendTime.minute,
        0,
        timezone,
      );
      if (at >= cursor) return at;
    }
    cursor = window.end; // midnight, start of the next local day
  }
  return nowSeconds;
}

// ---------------------------------------------------------------------------
// Spread (a leaky bucket for each day's batch)
// ---------------------------------------------------------------------------

/** A spread longer than a day could never finish inside its own window. */
export const SPREAD_MAX_MINUTES = 1440;

/**
 * Minutes to spread a day's batch across: a positive whole number, or null.
 * Null (and 0, blank, junk, or anything negative) means "no spread": the whole
 * day's allowance is released at the window, exactly as before.
 */
export function normalizeSpreadMinutes(raw: unknown): number | null {
  const n = normalizeDailyCap(raw);
  if (n == null) return null;
  return Math.min(n, SPREAD_MAX_MINUTES);
}

/**
 * The instant today's batch window opens: today's `send_time` local, or the
 * local day start when the plan has no time of day. Unlike `nextWindowStart`
 * this stays on today even once that opening has passed, which is what the
 * spread measures its elapsed minutes from.
 */
export function currentWindowStart(opts: {
  nowSeconds: number;
  timezone: string;
  sendTime: TimeOfDay | null;
}): number {
  const window = localDayWindow(opts.nowSeconds, opts.timezone);
  if (!opts.sendTime) return window.start;
  const p = zonedParts(opts.nowSeconds, opts.timezone);
  return zonedWallClockToEpoch(
    p.year,
    p.month,
    p.day,
    opts.sendTime.hour,
    opts.sendTime.minute,
    0,
    opts.timezone,
  );
}

/**
 * How much of the day's allowance should have left by `nowSeconds` - what the
 * spread releases against.
 *
 * It is `elapsed x rate` (the day's allowance over the spread), recomputed from
 * the clock every tick, so a tick that never happened costs nothing: the next
 * tick releases the slice the clock says is due, never a backlog of whole
 * batches. With no spread the whole allowance is due the moment the window
 * opens (today's behaviour), and before the window opens nothing is due.
 */
export function spreadTarget(opts: {
  dayAllowance: number;
  spreadMinutes: number | null;
  windowStartAt: number;
  nowSeconds: number;
}): number {
  const allowance = Math.max(0, Math.floor(opts.dayAllowance));
  const spread = normalizeSpreadMinutes(opts.spreadMinutes);
  if (spread == null || allowance <= 0) return allowance;
  if (opts.nowSeconds < opts.windowStartAt) return 0;
  const elapsedMinutes = Math.floor((opts.nowSeconds - opts.windowStartAt) / 60);
  if (elapsedMinutes >= spread) return allowance;
  // The first minute's slice leaves with the window opening, then one slice a
  // minute, so the whole allowance is out by the end of the spread.
  return Math.min(allowance, Math.floor(((elapsedMinutes + 1) * allowance) / spread));
}

/**
 * When the last of `need` recipients leaves a spread day: the window opening
 * plus the minutes that many slices take. The inverse of `spreadTarget`, so a
 * final day that needs only part of its allowance finishes early instead of
 * waiting out the whole spread. No spread means the window opening itself.
 */
export function spreadFinishAt(opts: {
  windowStartAt: number;
  need: number;
  dayAllowance: number;
  spreadMinutes: number | null;
}): number {
  const spread = normalizeSpreadMinutes(opts.spreadMinutes);
  if (spread == null) return opts.windowStartAt;
  const allowance = Math.max(1, Math.floor(opts.dayAllowance));
  const need = Math.max(1, Math.floor(opts.need));
  if (need >= allowance) return opts.windowStartAt + (spread - 1) * 60;
  const minutes = Math.max(0, Math.ceil((need * spread) / allowance) - 1);
  return opts.windowStartAt + minutes * 60;
}

export interface ProjectedFinish {
  /** Instant of the final batch's window. */
  finishAt: number;
  /** Local day key of the final batch. */
  finishDayKey: string;
  /** Number of release days the remaining recipients need. */
  days: number;
}

/**
 * How many release days `remaining` recipients still need, and when the last
 * batch goes out. `todayAllowance` is what is left of today's cap (null/0 when
 * today is not an eligible release day or its window has closed/been used up).
 *
 * Walks real local days, so weekends and send_days are skipped rather than
 * divided away, and a DST day is still one day.
 *
 * A ramp changes the arithmetic and is walked properly rather than reused as a
 * flat cap: pass `rampStart` / `rampDays` and how many sending days the
 * campaign has already used (`sendingDaysUsed`, counting today when it has
 * already released). Only days that actually release consume a ramp step, so a
 * skipped weekend neither sends nor uses up an early (smaller) day.
 *
 * A spread does not change how many days the audience needs - the day still
 * releases its whole allowance, just metered - so it only moves the time of the
 * last batch: pass `spreadMinutes` and the final day finishes when its final
 * slice is due, not at the window opening.
 */
export function projectFinish(opts: {
  remaining: number;
  dailyCap: number | null;
  sendDays: number[] | null;
  sendTime: TimeOfDay | null;
  timezone: string;
  nowSeconds: number;
  todayAllowance: number | null;
  /** Sending days already used, counting today when today has already sent. */
  sendingDaysUsed?: number;
  rampStart?: number | null;
  rampDays?: number | null;
  spreadMinutes?: number | null;
}): ProjectedFinish | null {
  const remaining0 = Math.floor(opts.remaining);
  if (!(remaining0 > 0)) return null;
  const cap =
    opts.dailyCap != null && opts.dailyCap > 0 ? Math.floor(opts.dailyCap) : null;
  const ramp = sendRamp({
    daily_cap: cap,
    ramp_start: opts.rampStart ?? null,
    ramp_days: opts.rampDays ?? null,
  });
  const spread = normalizeSpreadMinutes(opts.spreadMinutes ?? null);

  let used = Math.max(0, Math.floor(opts.sendingDaysUsed ?? 0));
  let cursor = opts.nowSeconds;
  let remaining = remaining0;
  let days = 0;
  let first = true;

  for (let guard = 0; guard < 400 && remaining > 0; guard++) {
    const window = localDayWindow(cursor, opts.timezone);
    const p = zonedParts(cursor, opts.timezone);
    const allowed = !opts.sendDays || opts.sendDays.includes(window.weekday);
    // Today's step is already sized by the caller (against the ramp); later
    // steps are the next sending day's allowance, so the ramp's smaller days
    // land on the early batches, not on the tail.
    const allowance = first
      ? allowed
        ? Math.max(0, opts.todayAllowance ?? 0)
        : 0
      : cap == null
        ? remaining
        : rampAllowanceAt(cap, ramp, used + 1);

    const batchAt = opts.sendTime
      ? zonedWallClockToEpoch(
          p.year,
          p.month,
          p.day,
          opts.sendTime.hour,
          opts.sendTime.minute,
          0,
          opts.timezone,
        )
      : window.start;

    first = false;
    cursor = window.end;

    if (!allowed || allowance <= 0) continue;
    used += 1;
    // The last slice of a spread day lands after the window opens, not at it;
    // a final day that needs only part of its allowance finishes early.
    const finishAt =
      spread == null
        ? batchAt
        : spreadFinishAt({
            windowStartAt: first ? Math.max(batchAt, opts.nowSeconds) : batchAt,
            need: Math.min(remaining, allowance),
            dayAllowance: allowance,
            spreadMinutes: spread,
          });
    remaining -= allowance;
    days += 1;
    if (remaining <= 0) {
      return { finishAt, finishDayKey: window.dayKey, days };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Wording (shared by the confirm dialogs and the collapsed summaries)
// ---------------------------------------------------------------------------

export function sendDaysLabel(days: number[] | null): string {
  if (!days || !days.length) return "any day";
  if (days.length === 7) return "every day";
  const set = [...days].sort((a, b) => a - b);
  const same = (want: number[]) =>
    set.length === want.length && want.every((d) => set.includes(d));
  if (same([1, 2, 3, 4, 5])) return "weekdays";
  if (same([6, 7])) return "weekends";
  return set.map((d) => WEEKDAY_LABELS.find((w) => w.value === d)?.short ?? String(d)).join(", ");
}

/**
 * The ramp spelled out per sending day, so there is nothing to infer:
 *   "Day 1: 300, day 2 onward: 500"
 *   "Day 1: 200, day 2: 300, day 3: 400, day 4 onward: 500"
 * A long ramp is summarised ("Day 1: 100, rising to 500 by day 30") rather than
 * recited day by day, which would be a wall of numbers. Null when there is no
 * ramp to describe.
 */
export function rampScheduleWords(plan: Partial<SendPlan> | null | undefined): string | null {
  const cap = normalizeDailyCap(plan?.daily_cap ?? null);
  const ramp = sendRamp(plan);
  if (cap == null || !ramp) return null;
  const lastGrowingDay = ramp.days - 1;
  if (lastGrowingDay > 6) {
    return `Day 1: ${rampAllowanceAt(cap, ramp, 1)}, rising to ${cap} by day ${ramp.days}`;
  }
  const parts = [`Day 1: ${rampAllowanceAt(cap, ramp, 1)}`];
  for (let k = 2; k <= lastGrowingDay; k++) {
    parts.push(`day ${k}: ${rampAllowanceAt(cap, ramp, k)}`);
  }
  parts.push(`day ${ramp.days} onward: ${cap}`);
  return parts.join(", ");
}

/**
 * The spread in words: "spread across the hour (~9 a minute)".
 * `perDayAllowance` is the figure the rate is derived from (the campaign's cap).
 * With `atMost`, the clause reads as a ceiling - a ramp moves the rate from day
 * to day, so the cap's rate is the most it ever reaches.
 */
export function spreadWords(
  spreadMinutes: unknown,
  perDayAllowance: number | null = null,
  atMost = false,
): string | null {
  const spread = normalizeSpreadMinutes(spreadMinutes);
  if (spread == null) return null;
  const window =
    spread === 60
      ? "the hour"
      : spread % 60 === 0
        ? `${spread / 60} hours`
        : `${spread} minutes`;
  const rate =
    perDayAllowance != null && perDayAllowance > 0
      ? Math.max(1, Math.ceil(perDayAllowance / spread))
      : null;
  const pace = rate == null ? "" : ` (${atMost ? "up to " : ""}~${rate} a minute)`;
  return `spread across ${window}${pace}`;
}

/**
 * "up to 200 a day, weekdays, from 10:00 Sydney" (or the ramp spelled out,
 * or the spread added to it).
 */
export function planWords(
  plan: Partial<SendPlan>,
  timezone: string,
): string {
  const cap = normalizeDailyCap(plan.daily_cap);
  const ramp = rampScheduleWords(plan);
  const time = parseSendTime(plan.send_time);
  const spread = spreadWords(plan.spread_minutes, cap, !!sendRamp(plan));
  return [
    ramp ?? (cap ? `up to ${cap} a day` : "no daily cap"),
    spread,
    sendDaysLabel(parseSendDays(plan.send_days)),
    `from ${time ? time.hhmm : "any time"} ${timezone}`,
  ]
    .filter((part): part is string => !!part)
    .join(", ");
}

/** "up to 200 a day, weekdays, from 10:00 Sydney — about 4 days" */
export function planConfirmWords(
  plan: Partial<SendPlan>,
  timezone: string,
  projectedDays: number | null,
): string {
  const base = planWords(plan, timezone);
  if (projectedDays == null) return base;
  return `${base} — about ${projectedDays} day${projectedDays === 1 ? "" : "s"}`;
}

/** One-line summary for the collapsed Sending schedule section. */
export function planCollapseSummary(
  plan: Partial<SendPlan> | null | undefined,
  timezone: string,
): string {
  if (!hasSendPlan(plan)) return "send all at once";
  return planWords(plan ?? {}, timezone);
}
