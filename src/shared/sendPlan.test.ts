// Pure send-plan arithmetic. Every instant here is written as an explicit UTC
// ISO string so the expectations do not depend on the machine's timezone. The
// working zone is Australia/Brisbane — the app's default — which has no daylight
// saving, so its UTC+10 offset and its local-day boundaries sit still all year;
// one test below still pins a DST-observing zone explicitly, because a campaign
// may override the default.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEND_TIMEZONE,
  evaluatePlanNow,
  formatSendDays,
  hasSendPlan,
  isValidTimeZone,
  localDayWindow,
  nextWindowStart,
  normalizeDailyCap,
  normalizeRampDays,
  normalizeRampStart,
  normalizeSendTime,
  normalizeSpreadMinutes,
  parseSendDays,
  parseSendTime,
  planCollapseSummary,
  planConfirmWords,
  planWords,
  projectFinish,
  rampAllowanceAt,
  rampScheduleWords,
  resolveTimeZone,
  sendDaysLabel,
  sendRamp,
  spreadFinishAt,
  spreadTarget,
  spreadWords,
  todayRampAllowance,
  zonedParts,
  zonedWallClockToEpoch,
} from "./sendPlan";

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// 2026-09-23 is a Wednesday. Brisbane is UTC+10 all year — it does not observe
// daylight saving, so no expected instant here moves with a DST transition.
const WED = "2026-09-23T00:00:00Z"; // Wed 10:00 Brisbane
const BNE = "Australia/Brisbane";

const plan = (over: Partial<Record<string, unknown>> = {}) => ({
  daily_cap: null as number | null,
  send_days: null as string | null,
  send_time: null as string | null,
  send_timezone: null as string | null,
  ...over,
});

describe("plan presence", () => {
  it("treats cap, days or time as a plan and timezone alone as not one", () => {
    expect(hasSendPlan(plan())).toBe(false);
    expect(hasSendPlan(plan({ send_timezone: "Australia/Brisbane" }))).toBe(false);
    expect(hasSendPlan(plan({ daily_cap: 200 }))).toBe(true);
    expect(hasSendPlan(plan({ send_days: "1,2,3,4,5" }))).toBe(true);
    expect(hasSendPlan(plan({ send_time: "10:00" }))).toBe(true);
  });
});

describe("parsing", () => {
  it("parses weekday lists from CSV or array, and drops junk", () => {
    expect(parseSendDays("1,2,3,4,5")).toEqual([1, 2, 3, 4, 5]);
    expect(parseSendDays([5, 1, 1, 9, 0, "3"])).toEqual([1, 3, 5]);
    expect(parseSendDays("")).toBeNull();
    expect(parseSendDays([])).toBeNull();
    expect(parseSendDays(null)).toBeNull();
  });

  it("formats weekdays back to CSV", () => {
    expect(formatSendDays([3, 1, 2])).toBe("1,2,3");
    expect(formatSendDays([])).toBeNull();
    expect(formatSendDays(null)).toBeNull();
  });

  it("accepts HH:MM only, and canonicalises single digits", () => {
    expect(parseSendTime("10:00")?.minutes).toBe(600);
    expect(parseSendTime("9:05")?.hhmm).toBe("09:05");
    expect(normalizeSendTime("09:05")).toBe("09:05");
    expect(parseSendTime("24:00")).toBeNull();
    expect(parseSendTime("10:60")).toBeNull();
    expect(parseSendTime("10")).toBeNull();
    expect(parseSendTime("")).toBeNull();
    expect(parseSendTime(null)).toBeNull();
  });

  it("normalises the cap and rejects nonsense", () => {
    expect(normalizeDailyCap("200")).toBe(200);
    expect(normalizeDailyCap(200.9)).toBe(200);
    expect(normalizeDailyCap(0)).toBeNull();
    expect(normalizeDailyCap(-5)).toBeNull();
    expect(normalizeDailyCap("")).toBeNull();
    expect(normalizeDailyCap("abc")).toBeNull();
  });

  it("validates IANA zones and falls back for unusable ones", () => {
    expect(isValidTimeZone("Australia/Brisbane")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(resolveTimeZone("Not/AZone", "Australia/Brisbane")).toBe("Australia/Brisbane");
    expect(resolveTimeZone(null, "Australia/Brisbane")).toBe("Australia/Brisbane");
    expect(resolveTimeZone(null, null)).toBe(DEFAULT_SEND_TIMEZONE);
  });
});

describe("local day boundary", () => {
  it("puts 23:59 Brisbane in that Brisbane day, not the UTC day", () => {
    // 23:59 Wed Brisbane == 13:59Z Wed; the Brisbane day ends at 14:00Z.
    const late = at("2026-09-23T13:59:00Z");
    const window = localDayWindow(late, BNE);
    expect(window.start).toBe(at("2026-09-22T14:00:00Z"));
    expect(window.end).toBe(at("2026-09-23T14:00:00Z"));
    expect(window.dayKey).toBe("2026-09-23");
    expect(window.weekday).toBe(3);
    expect(late).toBeLessThan(window.end);
  });

  it("puts 00:01 the next Brisbane day on the other side of the boundary", () => {
    const justAfter = at("2026-09-23T14:01:00Z"); // Thu 00:01 Brisbane
    const window = localDayWindow(justAfter, BNE);
    expect(window.dayKey).toBe("2026-09-24");
    expect(window.weekday).toBe(4);
    expect(window.start).toBe(at("2026-09-23T14:00:00Z"));
  });

  it("keeps every local day 24 hours and the boundary fixed (no DST in Brisbane)", () => {
    // 4 Oct 2026 is when the southern DST zones shift. Brisbane does not: its
    // offset is UTC+10 all year, so the day containing that date is a full 24
    // hours and the same wall clock maps to the same instant in September and
    // in mid-summer.
    const window = localDayWindow(at("2026-10-03T20:00:00Z"), BNE);
    expect(window.dayKey).toBe("2026-10-04");
    expect(window.end - window.start).toBe(24 * 3600);
    expect(window.start).toBe(at("2026-10-03T14:00:00Z"));
    expect(window.end).toBe(at("2026-10-04T14:00:00Z"));

    // 10:00 Brisbane is 00:00Z on both sides of the changeover.
    expect(zonedWallClockToEpoch(2026, 10, 4, 10, 0, 0, BNE)).toBe(at("2026-10-04T00:00:00Z"));
    expect(zonedWallClockToEpoch(2027, 1, 14, 10, 0, 0, BNE)).toBe(at("2027-01-14T00:00:00Z"));
    expect(zonedParts(at("2027-01-14T00:00:00Z"), BNE).hour).toBe(10);
  });

  it("still resolves a zone that does observe DST, whose day is 23 hours", () => {
    // Not the default any more, but a campaign may still set one — the
    // arithmetic must stay correct where the local day is not 24 hours long.
    const window = localDayWindow(at("2026-10-03T20:00:00Z"), "Australia/Sydney");
    expect(window.dayKey).toBe("2026-10-04");
    expect(window.end - window.start).toBe(23 * 3600);
  });

  it("reads the weekday and clock in the plan's zone", () => {
    const p = zonedParts(at("2026-09-23T13:59:00Z"), BNE);
    expect([p.year, p.month, p.day]).toEqual([2026, 9, 23]);
    expect([p.hour, p.minute]).toEqual([23, 59]);
    expect(p.weekday).toBe(3);
  });

  it("round-trips a wall clock through a zone", () => {
    expect(zonedWallClockToEpoch(2026, 9, 23, 10, 0, 0, BNE)).toBe(at(WED));
  });
});

describe("window eligibility", () => {
  const days = [1, 2, 3, 4, 5];
  const time = parseSendTime("10:00");

  it("is closed one minute before send_time and open at it", () => {
    const before = evaluatePlanNow({
      nowSeconds: at("2026-09-22T23:59:00Z"), // Wed 09:59 Brisbane
      timezone: BNE,
      sendDays: days,
      sendTime: time,
    });
    expect(before.dayAllowed).toBe(true);
    expect(before.windowOpen).toBe(false);

    const open = evaluatePlanNow({
      nowSeconds: at(WED), // Wed 10:00 Brisbane
      timezone: BNE,
      sendDays: days,
      sendTime: time,
    });
    expect(open.windowOpen).toBe(true);
  });

  it("closes the day on a weekday the plan excludes", () => {
    const sat = evaluatePlanNow({
      nowSeconds: at("2026-09-25T23:30:00Z"), // Sat 09:30 Brisbane
      timezone: BNE,
      sendDays: days,
      sendTime: time,
    });
    expect(sat.dayAllowed).toBe(false);
    expect(sat.windowOpen).toBe(false);
    expect(sat.weekday).toBe(6);
  });

  it("names the next window: later today, else the next allowed day", () => {
    expect(
      nextWindowStart({
        nowSeconds: at("2026-09-22T23:00:00Z"), // Wed 09:00 Brisbane
        timezone: BNE,
        sendDays: days,
        sendTime: time,
      }),
    ).toBe(at(WED));
    // 11:00 Wednesday -> Thursday 10:00
    expect(
      nextWindowStart({
        nowSeconds: at("2026-09-23T01:00:00Z"),
        timezone: BNE,
        sendDays: days,
        sendTime: time,
      }),
    ).toBe(at("2026-09-24T00:00:00Z"));
    // 11:00 Friday -> Monday 10:00 (the weekend is skipped)
    expect(
      nextWindowStart({
        nowSeconds: at("2026-09-25T01:00:00Z"),
        timezone: BNE,
        sendDays: days,
        sendTime: time,
      }),
    ).toBe(at("2026-09-28T00:00:00Z"));
    // Weekends-only plan on a Wednesday -> Saturday 10:00
    expect(
      nextWindowStart({
        nowSeconds: at(WED),
        timezone: BNE,
        sendDays: [6, 7],
        sendTime: time,
      }),
    ).toBe(at("2026-09-26T00:00:00Z"));
  });

  it("treats a missing send_time as an all-day window", () => {
    const ev = evaluatePlanNow({
      nowSeconds: at("2026-09-23T01:00:00Z"),
      timezone: BNE,
      sendDays: null,
      sendTime: null,
    });
    expect(ev.windowOpen).toBe(true);
    expect(
      nextWindowStart({
        nowSeconds: at("2026-09-23T01:00:00Z"),
        timezone: BNE,
        sendDays: null,
        sendTime: null,
      }),
    ).toBe(at("2026-09-23T01:00:00Z"));
  });
});

describe("projected finish", () => {
  const base = {
    dailyCap: 200,
    sendDays: [1, 2, 3, 4, 5],
    sendTime: parseSendTime("10:00"),
    timezone: BNE,
  };

  it("counts one release day per cap-sized batch, skipping the weekend", () => {
    // Wed 10:05 Brisbane, 1000 recipients, 200/day, nothing released yet.
    const p = projectFinish({
      ...base,
      remaining: 1000,
      nowSeconds: at("2026-09-23T00:05:00Z"),
      todayAllowance: 200,
    });
    expect(p).not.toBeNull();
    expect(p!.days).toBe(5); // Wed, Thu, Fri, Mon, Tue
    expect(p!.finishDayKey).toBe("2026-09-29");
    expect(p!.finishAt).toBe(at("2026-09-29T00:00:00Z")); // Tue 10:00 Brisbane
  });

  it("uses what is left of today's cap before counting whole days", () => {
    const p = projectFinish({
      ...base,
      remaining: 1000,
      nowSeconds: at("2026-09-23T00:05:00Z"),
      todayAllowance: 50,
    });
    expect(p!.days).toBe(6); // 50 today + 5 more days
    expect(p!.finishDayKey).toBe("2026-09-30");
  });

  it("starts at the next allowed day when today is not one", () => {
    // Sat 10:05 Brisbane, one batch left.
    const p = projectFinish({
      ...base,
      remaining: 200,
      nowSeconds: at("2026-09-26T00:05:00Z"),
      todayAllowance: 0,
    });
    expect(p!.days).toBe(1);
    expect(p!.finishDayKey).toBe("2026-09-28"); // Monday
  });

  it("treats no cap as everything on the next window", () => {
    const p = projectFinish({
      ...base,
      dailyCap: null,
      remaining: 5000,
      nowSeconds: at("2026-09-23T00:05:00Z"),
      todayAllowance: 5000,
    });
    expect(p!.days).toBe(1);
    expect(p!.finishDayKey).toBe("2026-09-23");
  });

  it("has nothing to project for an empty remainder", () => {
    expect(
      projectFinish({
        ...base,
        remaining: 0,
        nowSeconds: at("2026-09-23T00:05:00Z"),
        todayAllowance: 200,
      }),
    ).toBeNull();
  });

  it("lands exactly on the cap multiple without an extra day", () => {
    const p = projectFinish({
      ...base,
      remaining: 400,
      nowSeconds: at("2026-09-23T00:05:00Z"),
      todayAllowance: 200,
    });
    expect(p!.days).toBe(2); // Wed + Thu, not three
    expect(p!.finishDayKey).toBe("2026-09-24");
  });

  it("does not carry the window earlier than the time of day", () => {
    const p = projectFinish({
      ...base,
      remaining: 200,
      nowSeconds: at("2026-09-22T22:00:00Z"), // Wed 08:00 Brisbane, before 10:00
      todayAllowance: 200,
    });
    expect(p!.finishAt).toBe(at(WED)); // 10:00, not 08:00
  });
});

describe("wording", () => {
  it("describes weekday sets plainly", () => {
    expect(sendDaysLabel([1, 2, 3, 4, 5])).toBe("weekdays");
    expect(sendDaysLabel([6, 7])).toBe("weekends");
    expect(sendDaysLabel([1, 2, 3, 4, 5, 6, 7])).toBe("every day");
    expect(sendDaysLabel([1, 3, 5])).toBe("Mon, Wed, Fri");
    expect(sendDaysLabel(null)).toBe("any day");
  });

  it("spells out the plan the operator is about to start", () => {
    const p = plan({ daily_cap: 200, send_days: "1,2,3,4,5", send_time: "10:00" });
    expect(planWords(p, BNE)).toBe("up to 200 a day, weekdays, from 10:00 Australia/Brisbane");
    expect(planConfirmWords(p, BNE, 5)).toBe(
      "up to 200 a day, weekdays, from 10:00 Australia/Brisbane — about 5 days",
    );
    expect(planConfirmWords(p, BNE, 1)).toBe(
      "up to 200 a day, weekdays, from 10:00 Australia/Brisbane — about 1 day",
    );
  });

  it("summarises a plan-less campaign as sending all at once", () => {
    expect(planCollapseSummary(plan(), BNE)).toBe("send all at once");
    expect(planCollapseSummary(plan({ daily_cap: 50, send_time: "09:30" }), BNE)).toBe(
      "up to 50 a day, any day, from 09:30 Australia/Brisbane",
    );
  });
});

// ---------------------------------------------------------------------------
// The ramp: a daily cap that starts below the cap and steps up to it.
// ---------------------------------------------------------------------------

describe("ramp-up", () => {
  const rampPlan = (over: Partial<Record<string, unknown>> = {}) =>
    plan({
      daily_cap: 500,
      send_days: "1,2,3,4,5",
      send_time: "10:00",
      ramp_start: 300,
      ramp_days: 2,
      ...over,
    });

  it("normalises the ramp fields, and treats nonsense as no ramp", () => {
    expect(normalizeRampStart("300")).toBe(300);
    expect(normalizeRampStart(300.9)).toBe(300);
    expect(normalizeRampStart(0)).toBeNull();
    expect(normalizeRampStart(-5)).toBeNull();
    expect(normalizeRampStart("")).toBeNull();
    expect(normalizeRampDays(2)).toBe(2);
    // 1 is stored as given, and simply is not a ramp (see below).
    expect(normalizeRampDays(1)).toBe(1);
    expect(normalizeRampDays(0)).toBeNull();
    expect(normalizeRampDays(null)).toBeNull();
  });

  it("is a ramp only when a cap, a lower start and 2+ sending days line up", () => {
    expect(sendRamp(rampPlan())).toEqual({ start: 300, days: 2 });
    // Nothing to grow into, nothing to grow from, or nothing to grow across.
    expect(sendRamp(rampPlan({ daily_cap: null }))).toBeNull();
    expect(sendRamp(rampPlan({ ramp_start: null }))).toBeNull();
    expect(sendRamp(rampPlan({ ramp_days: null }))).toBeNull();
    expect(sendRamp(rampPlan({ ramp_start: 500 }))).toBeNull(); // at the cap
    expect(sendRamp(rampPlan({ ramp_start: 900 }))).toBeNull(); // above the cap
    expect(sendRamp(rampPlan({ ramp_days: 1 }))).toBeNull(); // no day to grow across
    expect(sendRamp(plan({ ramp_start: 300, ramp_days: 2 }))).toBeNull(); // no cap at all
  });

  it("grows the allowance evenly from the start to the cap, then holds it", () => {
    const ramp = sendRamp(rampPlan())!;
    expect(rampAllowanceAt(500, ramp, 1)).toBe(300);
    expect(rampAllowanceAt(500, ramp, 2)).toBe(500);
    expect(rampAllowanceAt(500, ramp, 9)).toBe(500);

    // 100 then +225 a day, landing exactly on the cap on day five.
    const five = sendRamp(rampPlan({ ramp_start: 100, ramp_days: 5 }))!;
    expect([1, 2, 3, 4, 5, 6].map((k) => rampAllowanceAt(1000, five, k))).toEqual([
      100, 325, 550, 775, 1000, 1000,
    ]);
    // Rounding never pushes a day below the start or above the cap, at any k.
    for (let k = 1; k <= 12; k++) {
      const a = rampAllowanceAt(1000, five, k);
      expect(a).toBeGreaterThanOrEqual(100);
      expect(a).toBeLessThanOrEqual(1000);
    }
    // No ramp is the flat cap, whatever the day.
    expect(rampAllowanceAt(500, null, 1)).toBe(500);
    expect(rampAllowanceAt(500, null, 4)).toBe(500);
  });

  it("sizes today's step from the sending days already used", () => {
    expect(todayRampAllowance(rampPlan(), 0)).toBe(300); // first sending day
    expect(todayRampAllowance(rampPlan(), 1)).toBe(500); // second and later
    expect(todayRampAllowance(rampPlan(), 7)).toBe(500);
    expect(todayRampAllowance(plan({ ramp_start: 300, ramp_days: 2 }), 0)).toBeNull(); // no cap
    expect(todayRampAllowance(plan({ daily_cap: 200 }), 3)).toBe(200); // no ramp
  });

  it("projects a finish from the ramp rather than the flat cap", () => {
    const base = {
      sendDays: [1, 2, 3, 4, 5],
      sendTime: parseSendTime("10:00"),
      timezone: BNE,
    };
    // Wed 10:05 Brisbane, 1000 recipients, 300 on day one then 500 a day.
    const ramped = projectFinish({
      ...base,
      remaining: 1000,
      dailyCap: 500,
      rampStart: 300,
      rampDays: 2,
      nowSeconds: at("2026-09-23T00:05:00Z"),
      todayAllowance: 300,
    });
    expect(ramped!.days).toBe(3); // Wed 300, Thu 500, Fri 200
    expect(ramped!.finishDayKey).toBe("2026-09-25");

    // The same campaign with no ramp finishes a day earlier: the projection is
    // computed, not estimated from the cap.
    const flat = projectFinish({
      ...base,
      remaining: 1000,
      dailyCap: 500,
      nowSeconds: at("2026-09-23T00:05:00Z"),
      todayAllowance: 500,
    });
    expect(flat!.days).toBe(2);
    expect(flat!.finishDayKey).toBe("2026-09-24");
  });

  it("does not spend an early, smaller step on a day that sends nothing", () => {
    // A Monday with only two sending days behind it: the ramp still owes it day
    // three (550), not day five (the cap), even though a week of calendar time
    // has passed. 5000 recipients then take six sending days, not five.
    const p = projectFinish({
      remaining: 5000,
      dailyCap: 1000,
      rampStart: 100,
      rampDays: 5,
      sendingDaysUsed: 2,
      sendDays: [1, 2, 3, 4, 5],
      sendTime: parseSendTime("10:00"),
      timezone: BNE,
      nowSeconds: at("2026-09-28T00:05:00Z"), // Mon 10:05 Brisbane
      todayAllowance: 550,
    });
    expect(p!.days).toBe(6);
    expect(p!.finishDayKey).toBe("2026-10-05");
  });

  it("spells the ramp out day by day, and leaves a flat plan alone", () => {
    expect(rampScheduleWords(rampPlan())).toBe("Day 1: 300, day 2 onward: 500");
    expect(rampScheduleWords(rampPlan({ ramp_start: 200, ramp_days: 4 }))).toBe(
      "Day 1: 200, day 2: 300, day 3: 400, day 4 onward: 500",
    );
    // A long ramp is summarised rather than recited day by day.
    expect(rampScheduleWords(rampPlan({ ramp_start: 100, ramp_days: 30 }))).toBe(
      "Day 1: 100, rising to 500 by day 30",
    );
    expect(rampScheduleWords(plan({ daily_cap: 500 }))).toBeNull();

    expect(planWords(rampPlan(), BNE)).toBe(
      "Day 1: 300, day 2 onward: 500, weekdays, from 10:00 Australia/Brisbane",
    );
    // A plan with no ramp reads exactly as it did before the ramp existed.
    expect(planWords(plan({ daily_cap: 200, send_time: "09:30" }), BNE)).toBe(
      "up to 200 a day, any day, from 09:30 Australia/Brisbane",
    );
    expect(planCollapseSummary(rampPlan(), BNE)).toBe(
      "Day 1: 300, day 2 onward: 500, weekdays, from 10:00 Australia/Brisbane",
    );
  });
});

// ---------------------------------------------------------------------------
// The spread: each day's batch released at a rate instead of in one burst.
// ---------------------------------------------------------------------------

describe("spread", () => {
  const WINDOW = at("2026-09-23T00:00:00Z"); // Wed 10:00 Brisbane
  const targetAt = (elapsedMinutes: number, allowance = 500, spread: number | null = 60) =>
    spreadTarget({
      dayAllowance: allowance,
      spreadMinutes: spread,
      windowStartAt: WINDOW,
      nowSeconds: WINDOW + elapsedMinutes * 60,
    });

  it("treats blank, 0 and junk as no spread, and caps a spread at a day", () => {
    expect(normalizeSpreadMinutes(60)).toBe(60);
    expect(normalizeSpreadMinutes("60")).toBe(60);
    expect(normalizeSpreadMinutes(0)).toBeNull();
    expect(normalizeSpreadMinutes("")).toBeNull();
    expect(normalizeSpreadMinutes(null)).toBeNull();
    expect(normalizeSpreadMinutes(-5)).toBeNull();
    expect(normalizeSpreadMinutes("abc")).toBeNull();
    expect(normalizeSpreadMinutes(5000)).toBe(1440);
  });

  it("hands the whole allowance over at the window when there is no spread", () => {
    expect(targetAt(0, 500, null)).toBe(500);
    expect(targetAt(30, 500, null)).toBe(500);
  });

  it("owes nothing before the window opens, whatever the spread says", () => {
    expect(
      spreadTarget({
        dayAllowance: 500,
        spreadMinutes: 60,
        windowStartAt: WINDOW,
        nowSeconds: WINDOW - 1,
      }),
    ).toBe(0);
    expect(
      spreadTarget({
        dayAllowance: 500,
        spreadMinutes: 60,
        windowStartAt: WINDOW,
        nowSeconds: at("2026-09-22T23:59:00Z"), // Wed 09:59 Brisbane
      }),
    ).toBe(0);
  });

  it("releases against the clock, reaching the full allowance by the end", () => {
    // 500 over the hour is one slice a minute from the window opening.
    expect(targetAt(0)).toBe(8);
    expect(targetAt(1)).toBe(16);
    expect(targetAt(29)).toBe(250);
    expect(targetAt(58)).toBe(491);
    expect(targetAt(59)).toBe(500);
    expect(targetAt(90)).toBe(500);
    // Monotonic, and never above the allowance, at every minute.
    let last = 0;
    for (let m = 0; m <= 70; m++) {
      const due = targetAt(m);
      expect(due).toBeGreaterThanOrEqual(last);
      expect(due).toBeLessThanOrEqual(500);
      last = due;
    }
  });

  it("turns a missed tick into a proportional slice, never a backlog", () => {
    // Ticks at minute 0 and minute 1, then a long gap to minute 30: the gap
    // releases the half hour the clock has earned, not the rest of the day.
    const dueAtGap = targetAt(30);
    expect(dueAtGap).toBe(258);
    expect(dueAtGap - targetAt(1)).toBe(242); // the gap's slice, of a 500 day
    expect(dueAtGap).toBeLessThan(500);
  });

  it("sizes a small allowance over a long spread a slice at a time", () => {
    expect(targetAt(0, 3, 60)).toBe(0);
    expect(targetAt(19, 3, 60)).toBe(1);
    expect(targetAt(39, 3, 60)).toBe(2);
    expect(targetAt(59, 3, 60)).toBe(3);
  });

  it("works out when the last slice of a day leaves", () => {
    const at60 = (need: number, allowance = 500) =>
      spreadFinishAt({
        windowStartAt: WINDOW,
        need,
        dayAllowance: allowance,
        spreadMinutes: 60,
      });
    expect(at60(500)).toBe(WINDOW + 59 * 60);
    expect(at60(250)).toBe(WINDOW + 29 * 60);
    // The first slice is due with the window, so a small need finishes at once.
    expect(at60(1)).toBe(WINDOW);
    expect(at60(8)).toBe(WINDOW);
    // No spread finishes at the window itself.
    expect(
      spreadFinishAt({
        windowStartAt: WINDOW,
        need: 500,
        dayAllowance: 500,
        spreadMinutes: null,
      }),
    ).toBe(WINDOW);
  });

  it("says the spread and its pace in words", () => {
    expect(spreadWords(60, 500)).toBe("spread across the hour (~9 a minute)");
    expect(spreadWords(60, 500, true)).toBe("spread across the hour (up to ~9 a minute)");
    expect(spreadWords(30, 300)).toBe("spread across 30 minutes (~10 a minute)");
    expect(spreadWords(120, 500)).toBe("spread across 2 hours (~5 a minute)");
    expect(spreadWords(45, 500)).toBe("spread across 45 minutes (~12 a minute)");
    expect(spreadWords(0, 500)).toBeNull();
    expect(spreadWords(null, 500)).toBeNull();
    expect(spreadWords(60)).toBe("spread across the hour");
  });

  it("adds the spread to the plan's words, and reads as a ceiling under a ramp", () => {
    expect(planWords(plan({ daily_cap: 500, spread_minutes: 60, send_time: "10:00" }), BNE)).toBe(
      "up to 500 a day, spread across the hour (~9 a minute), any day, from 10:00 Australia/Brisbane",
    );
    // A ramp moves the rate from day to day, so the clause is the cap's rate, at
    // most - never a promise for day one.
    const rampWithSpread = plan({
      daily_cap: 500,
      send_days: "1,2,3,4,5",
      send_time: "10:00",
      ramp_start: 300,
      ramp_days: 2,
      spread_minutes: 60,
    });
    expect(planWords(rampWithSpread, BNE)).toBe(
      "Day 1: 300, day 2 onward: 500, spread across the hour (up to ~9 a minute), weekdays, from 10:00 Australia/Brisbane",
    );
  });

  it("keeps the projected day count and moves the finish time under a ramp", () => {
    const base = {
      remaining: 1000,
      dailyCap: 500,
      rampStart: 300,
      rampDays: 2,
      sendDays: [1, 2, 3, 4, 5],
      sendTime: parseSendTime("10:00"),
      timezone: BNE,
      nowSeconds: at("2026-09-23T00:05:00Z"), // Wed 10:05 Brisbane
      todayAllowance: 300,
      sendingDaysUsed: 0,
    };
    const flat = projectFinish({ ...base });
    const spread = projectFinish({ ...base, spreadMinutes: 60 });

    // Same days, same last day: the spread meters each day, it does not shrink
    // it, so it cannot add or remove a sending day.
    expect(spread!.days).toBe(flat!.days);
    expect(spread!.finishDayKey).toBe(flat!.finishDayKey);
    expect(spread!.finishDayKey).toBe("2026-09-25");
    expect(flat!.finishAt).toBe(at("2026-09-25T00:00:00Z")); // Fri 10:00

    // Friday only needs 200 of its 500, so the last slice lands 23 minutes in.
    expect(spread!.finishAt).toBe(at("2026-09-25T00:23:00Z"));
  });
});
