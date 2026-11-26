// Daily-batch ("drip") sending: the dispatcher, the cap, the send window and
// the local-day boundary.
//
// These run the real routes and the real dispatcher against an in-memory SQLite
// database built from the real migration files, so the SQL is what gets checked.
// Every instant is an explicit UTC ISO string and every tick is given its own
// `now`, so nothing depends on the machine clock or its timezone.
//
// Calendar facts used below: 2026-09-23 is a Wednesday; Brisbane is UTC+10 all
// year — it does not observe daylight saving, so no expectation here moves with
// a DST transition, and the 4 Oct changeover is covered as a stability check.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { Env, SendJob } from "./types";
import {
  campaignProgress,
  campaignsRoutes,
  dispatchDueCampaigns,
  releasedTodayCount,
  runPlanTick,
} from "./routes/campaigns";
import { DEFAULT_SEND_TIMEZONE } from "../shared/sendPlan";

const MIGRATIONS = [
  "0001_init.sql",
  "0002_segments.sql",
  "0003_campaign_var_mapping.sql",
  "0004_source_sync.sql",
  "0005_campaign_body.sql",
  "0006_campaign_tags.sql",
  "0007_campaign_subject.sql",
  "0008_campaign_sending_domain.sql",
  "0009_campaign_send_plan.sql",
  "0010_campaign_send_ramp.sql",
  "0011_campaign_send_spread.sql",
  "0016_email_verification.sql",
  "0017_email_verification_backfill.sql",
  "0018_email_verify_queue.sql",
];

const BNE = "Australia/Brisbane";
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// Wednesday, Thursday, Friday, Saturday and Monday around 10:00 Brisbane.
const WED_1000 = at("2026-09-23T00:00:00Z");
const THU_1000 = at("2026-09-24T00:00:00Z");
const FRI_1000 = at("2026-09-25T00:00:00Z");
const SAT_1000 = at("2026-09-26T00:00:00Z");
const MON_1000 = at("2026-09-28T00:00:00Z");
const TUE_1000 = at("2026-09-29T00:00:00Z");
// Wednesday 11:32 and 11:33 Brisbane — past the end of an hour-long spread, so
// the whole day's allowance is due, and one minute apart, which is how the live
// double release arrived (01:32:49Z and 01:33:49Z on 23 Sep 2026).
const WED_1132 = WED_1000 + 92 * 60;
const WED_1133 = WED_1000 + 93 * 60;

function freshDb(): TestD1 {
  const d1 = createTestD1();
  applyMigrations(d1, MIGRATIONS);
  return d1;
}

function seedContacts(d1: TestD1, n: number): void {
  // A running counter, so a second seeding call in the same test never collides
  // with an address already inserted (contacts.email is UNIQUE).
  for (let i = 0; i < n; i++) {
    emailSeq += 1;
    d1.exec(`INSERT INTO contacts (email, email_status) VALUES ('c${emailSeq}@example.com', 'valid')`);
  }
}

let emailSeq = 0;

/** An in-app template, because the one-shot send path requires one. */
function makeTemplate(d1: TestD1): number {
  d1.exec(
    `INSERT INTO templates (source, name, subject, html)
     VALUES ('local', 'Base', 'Hello', '<p>Hi</p>{{content}}')`,
  );
  return Number(d1.sql<{ id: number }>("SELECT id FROM templates ORDER BY id DESC LIMIT 1")[0].id);
}

function makeApp(d1: TestD1) {
  const queued: SendJob[] = [];
  const env = {
    DB: d1,
    SEND_QUEUE: {
      sendBatch: async (msgs: { body: SendJob }[]) => {
        for (const m of msgs) queued.push(m.body);
      },
    },
    SEND_TIMEZONE: BNE,
    DEFAULT_FROM_EMAIL: "listing@localdentists.au",
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/campaigns", campaignsRoutes);
  const call = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://test${path}`, init), env);
  const json = async (path: string, init?: RequestInit) => (await call(path, init)).json() as any;
  return {
    env,
    queued,
    call,
    json,
    get: (p: string) => json(p),
    post: (p: string, b?: unknown) => json(p, { method: "POST", body: JSON.stringify(b ?? {}) }),
    patch: (p: string, b: unknown) => json(p, { method: "PATCH", body: JSON.stringify(b) }),
  };
}

const statusOf = (d1: TestD1, id: number) =>
  d1.sql<{ status: string; started_at: number | null; finished_at: number | null }>(
    "SELECT status, started_at, finished_at FROM campaigns WHERE id=?",
    id,
  )[0];

const sendsOf = (d1: TestD1, id: number) =>
  d1.sql<{ id: number; status: string; email: string }>(
    "SELECT id, status, email FROM sends WHERE campaign_id=? ORDER BY id",
    id,
  );

const campaignRow = (d1: TestD1, id: number) =>
  d1.sql<any>("SELECT * FROM campaigns WHERE id=?", id)[0];

/** Simulate the queue consumer actually delivering the waiting rows. */
function deliverQueued(d1: TestD1, id: number, whenIso: string): number {
  const when = at(whenIso);
  const before = sendsOf(d1, id).filter((s) => s.status === "queued").length;
  d1.exec(`UPDATE sends SET status='sent', sent_at=${when} WHERE campaign_id=${id} AND status='queued'`);
  return before;
}

/** Create a campaign with a plan, ready to be scheduled. */
async function plannedCampaign(
  app: ReturnType<typeof makeApp>,
  d1: TestD1,
  contacts: number,
  plan: {
    cap?: number | null;
    days?: string | null;
    time?: string | null;
    tz?: string | null;
    rampStart?: number | null;
    rampDays?: number | null;
    spread?: number | null;
  },
) {
  seedContacts(d1, contacts);
  const created = await app.post("/api/campaigns", {
    name: "Clinic outreach",
    from_email: "a@b.com",
    template_id: makeTemplate(d1),
  });
  const patched = await app.patch(`/api/campaigns/${created.id}`, {
    daily_cap: plan.cap ?? null,
    send_days: plan.days ? plan.days.split(",").map(Number) : null,
    send_time: plan.time ?? null,
    send_timezone: plan.tz ?? null,
    ramp_start: plan.rampStart ?? null,
    ramp_days: plan.rampDays ?? null,
    spread_minutes: plan.spread ?? null,
  });
  expect(patched.ok).toBe(true);
  d1.exec(`UPDATE campaigns SET status='scheduled' WHERE id=${created.id}`);
  return created.id as number;
}

describe("daily cap", () => {
  it("releases at most the cap per local day, however often the cron fires", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 5, { cap: 2, days: "1,2,3,4,5", time: "10:00" });

    // The cron fires every minute for an hour inside the same local day.
    for (let i = 0; i < 60; i++) await dispatchDueCampaigns(app.env, WED_1000 + 300 + i);
    expect(app.queued).toHaveLength(2);
    expect(sendsOf(d1, id).filter((s) => s.status === "queued")).toHaveLength(2);

    // First open window also starts the campaign.
    expect(statusOf(d1, id).status).toBe("sending");
    expect(statusOf(d1, id).started_at).not.toBeNull();

    // Same local day, an hour later: re-entry must not release a second batch.
    for (let i = 0; i < 60; i++) await dispatchDueCampaigns(app.env, WED_1000 + 3600 + i);
    expect(app.queued).toHaveLength(2);
    expect(sendsOf(d1, id)).toHaveLength(2);

    // Day two releases the next cap-sized batch, and no more.
    deliverQueued(d1, id, "2026-09-23T01:00:00Z");
    for (let i = 0; i < 60; i++) await dispatchDueCampaigns(app.env, THU_1000 + i);
    expect(app.queued).toHaveLength(4);
    // ...and the campaign stays sending while recipients remain.
    expect(statusOf(d1, id).status).toBe("sending");

    // Day three has one recipient left: the cap is never exceeded.
    deliverQueued(d1, id, "2026-09-24T01:00:00Z");
    for (let i = 0; i < 30; i++) await dispatchDueCampaigns(app.env, FRI_1000 + i);
    expect(app.queued).toHaveLength(5);
    expect(sendsOf(d1, id)).toHaveLength(5);

    // Every queued job belongs to a distinct send row, and none was queued twice.
    expect(new Set(app.queued.map((j) => j.send_id)).size).toBe(5);
  });

  it("keeps a campaign sending while batches wait for later windows", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 4, { cap: 1, days: "1,2,3,4,5", time: "10:00" });
    await dispatchDueCampaigns(app.env, WED_1000);
    deliverQueued(d1, id, "2026-09-23T01:00:00Z");

    // The consumer finishes each batch; with recipients left it must not mark
    // the campaign sent, or the drip would stop after day one.
    const res = await app.post(`/api/campaigns/${id}/refresh-status`);
    expect(res.row.status).toBe("sending");
  });
});

describe("send window", () => {
  it("does not release a minute before send_time", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 3, { cap: 2, days: "1,2,3,4,5", time: "10:00" });

    await dispatchDueCampaigns(app.env, at("2026-09-22T23:59:00Z")); // Wed 09:59 Brisbane
    expect(app.queued).toHaveLength(0);
    expect(statusOf(d1, id).status).toBe("scheduled");

    await dispatchDueCampaigns(app.env, WED_1000); // Wed 10:00 Brisbane
    expect(app.queued).toHaveLength(2);
    expect(statusOf(d1, id).status).toBe("sending");
  });

  it("skips a weekday the plan excludes", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 3, { cap: 10, days: "1,2,3,4,5", time: "10:00" });

    // Saturday: nothing goes out, and the campaign has not started.
    for (let i = 0; i < 120; i++) await dispatchDueCampaigns(app.env, SAT_1000 + i);
    expect(app.queued).toHaveLength(0);
    expect(statusOf(d1, id).status).toBe("scheduled");

    // Monday releases the whole (uncapped-by-audience-size) batch.
    await dispatchDueCampaigns(app.env, MON_1000);
    expect(app.queued).toHaveLength(3);
    expect(statusOf(d1, id).status).toBe("sending");
  });

  it("can be restricted to weekends", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 2, { cap: 5, days: "6,7", time: "10:00" });

    await dispatchDueCampaigns(app.env, WED_1000);
    expect(app.queued).toHaveLength(0);
    await dispatchDueCampaigns(app.env, SAT_1000);
    expect(app.queued).toHaveLength(2);
    expect(statusOf(d1, id).status).toBe("sending");
  });
});

describe("pause and resume", () => {
  it("stops the drip while paused and continues after resume", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 4, { cap: 2, days: "1,2,3,4,5", time: "10:00" });

    await dispatchDueCampaigns(app.env, WED_1000);
    expect(app.queued).toHaveLength(2);
    deliverQueued(d1, id, "2026-09-23T01:00:00Z");

    expect((await app.post(`/api/campaigns/${id}/pause`)).ok).toBe(true);
    expect(statusOf(d1, id).status).toBe("paused");

    // A full day of ticks over Thursday's open window releases nothing.
    for (let i = 0; i < 120; i++) await dispatchDueCampaigns(app.env, THU_1000 + i);
    expect(app.queued).toHaveLength(2);
    expect(statusOf(d1, id).status).toBe("paused");

    expect((await app.post(`/api/campaigns/${id}/resume`)).ok).toBe(true);
    await dispatchDueCampaigns(app.env, THU_1000 + 120);
    expect(app.queued).toHaveLength(4);
  });
});

describe("audience exhausted", () => {
  it("marks the campaign sent once every recipient has been released", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 2, { cap: 10, days: "1,2,3,4,5", time: "10:00" });

    await dispatchDueCampaigns(app.env, WED_1000);
    expect(app.queued).toHaveLength(2);
    deliverQueued(d1, id, "2026-09-23T01:00:00Z");

    // The UI's self-heal path is the same settler the queue consumer uses.
    const res = await app.post(`/api/campaigns/${id}/refresh-status`);
    expect(res.row.status).toBe("sent");
    expect(statusOf(d1, id).finished_at).not.toBeNull();

    // Later ticks leave it alone.
    await dispatchDueCampaigns(app.env, THU_1000);
    expect(app.queued).toHaveLength(2);
    expect(statusOf(d1, id).status).toBe("sent");
  });
});

describe("local day boundary", () => {
  it("counts a 23:59 local send to that local day, and 00:01 to the next", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    // A midnight window, so both instants below are inside the day's window and
    // the only thing under test is which day the released rows count to.
    const id = await plannedCampaign(app, d1, 4, { cap: 2, days: "1,2,3,4,5", time: "00:00" });

    // Wed 23:59 Brisbane — well after the 10:00 window, still Wednesday.
    const wedLate = at("2026-09-23T13:59:00Z");
    await dispatchDueCampaigns(app.env, wedLate);
    expect(app.queued).toHaveLength(2);

    // The two rows belong to Wednesday, not to the UTC day or to Thursday.
    expect(await releasedTodayCount(app.env, id, BNE, wedLate + 30)).toBe(2);
    expect(await releasedTodayCount(app.env, id, BNE, at("2026-09-23T14:00:30Z"))).toBe(0);

    // 23:59:45 on the same local day: the cap is spent, nothing more goes out.
    await dispatchDueCampaigns(app.env, wedLate + 45);
    expect(app.queued).toHaveLength(2);

    // 00:01 the next local day — only 2 minutes later in UTC — is a new day, so
    // the cap is fresh again. A UTC-based boundary would release nothing here.
    await dispatchDueCampaigns(app.env, at("2026-09-23T14:01:00Z"));
    expect(app.queued).toHaveLength(4);

    // And those are Thursday's, not Wednesday's.
    expect(await releasedTodayCount(app.env, id, BNE, wedLate + 30)).toBe(2);
    expect(await releasedTodayCount(app.env, id, BNE, at("2026-09-23T14:01:30Z"))).toBe(2);
  });

  it("uses the campaign's own timezone when it has one", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    // Perth is UTC+8 (and also has no DST), so a 10:00 Perth window is 02:00Z —
    // clearly different from the Brisbane default it overrides.
    const id = await plannedCampaign(app, d1, 2, {
      cap: 2,
      days: "1,2,3,4,5",
      time: "10:00",
      tz: "Australia/Perth",
    });
    // 10:00 Brisbane (00:00Z) is not this campaign's window.
    await dispatchDueCampaigns(app.env, at("2026-09-23T00:00:00Z"));
    expect(app.queued).toHaveLength(0);
    await dispatchDueCampaigns(app.env, at("2026-09-23T01:59:00Z"));
    expect(app.queued).toHaveLength(0);
    await dispatchDueCampaigns(app.env, at("2026-09-23T02:00:00Z"));
    expect(app.queued).toHaveLength(2);
    expect(campaignRow(d1, id).send_timezone).toBe("Australia/Perth");
  });

  it("keeps the day boundary fixed across the southern DST changeover", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 4, { cap: 2, days: "1,2,3,4,5", time: "10:00" });

    // Monday 5 Oct 2026, the first weekday after the southern states moved to
    // daylight saving on 4 Oct. Brisbane did not, so 10:00 local is still 00:00Z
    // and nothing about the window has shifted.
    await dispatchDueCampaigns(app.env, at("2026-10-04T23:59:00Z")); // Mon 09:59 Brisbane
    expect(app.queued).toHaveLength(0);
    await dispatchDueCampaigns(app.env, at("2026-10-05T00:00:00Z")); // Mon 10:00 Brisbane
    expect(app.queued).toHaveLength(2);

    // The local day is 24 hours, and a 23:59 local send still belongs to it.
    deliverQueued(d1, id, "2026-10-05T01:00:00Z");
    expect(await releasedTodayCount(app.env, id, BNE, at("2026-10-05T13:59:00Z"))).toBe(2);
    expect(await releasedTodayCount(app.env, id, BNE, at("2026-10-05T14:00:00Z"))).toBe(0);
  });

  it("runs a DST zone correctly when a campaign sets one", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    // Sydney moves to UTC+11 on 4 Oct 2026, so its 10:00 window is 23:00Z the
    // day before. Only the campaign's own zone can be trusted for that.
    const id = await plannedCampaign(app, d1, 2, {
      cap: 2,
      days: "1,2,3,4,5",
      time: "10:00",
      tz: "Australia/Sydney",
    });
    await dispatchDueCampaigns(app.env, at("2026-10-04T22:59:00Z")); // Mon 09:59 Sydney
    expect(app.queued).toHaveLength(0);
    await dispatchDueCampaigns(app.env, at("2026-10-04T23:00:00Z")); // Mon 10:00 Sydney (AEDT)
    expect(app.queued).toHaveLength(2);
  });

  it("follows the Worker default when the campaign has no timezone", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 2, { cap: 2, days: "1,2,3,4,5", time: "10:00" });
    expect(campaignRow(d1, id).send_timezone).toBeNull();
    const progress = await campaignProgress(app.env, campaignRow(d1, id), WED_1000);
    expect(progress.timezone).toBe(BNE);
    // ...and that default is the app default, not just this test's env var.
    expect(BNE).toBe(DEFAULT_SEND_TIMEZONE);
  });
});

describe("no plan means today's behaviour", () => {
  it("releases the whole audience in one shot", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    seedContacts(d1, 5);
    const created = await app.post("/api/campaigns", {
      name: "One shot",
      from_email: "a@b.com",
      template_id: makeTemplate(d1),
    });
    const id = created.id as number;
    d1.exec(
      `UPDATE campaigns SET status='scheduled', scheduled_at=${WED_1000 - 60} WHERE id=${id}`,
    );

    const res = await dispatchDueCampaigns(app.env, WED_1000);
    expect(res.plans).toHaveLength(0);
    expect(app.queued).toHaveLength(5);
    expect(statusOf(d1, id).status).toBe("sending");
    expect(sendsOf(d1, id)).toHaveLength(5);
  });

  it("still refuses to release a planned campaign through the one-shot path", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 4, { cap: 2, days: "1,2,3,4,5", time: "10:00" });

    await dispatchDueCampaigns(app.env, WED_1000);
    deliverQueued(d1, id, "2026-09-23T01:00:00Z");
    // Nothing left today, so a second pass releases nothing rather than falling
    // back to a full release.
    for (let i = 0; i < 10; i++) await dispatchDueCampaigns(app.env, WED_1000 + 1800 + i);
    expect(sendsOf(d1, id)).toHaveLength(2);
  });
});

describe("plan editing guard", () => {
  it("refuses to change the plan once the campaign is running", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 4, { cap: 2, days: "1,2,3,4,5", time: "10:00" });
    await dispatchDueCampaigns(app.env, WED_1000); // -> sending

    const res = await app.call(`/api/campaigns/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ daily_cap: 500 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain("cannot change the sending schedule");
    expect(campaignRow(d1, id).daily_cap).toBe(2);

    // Pausing does not unlock it either — the plan stays as configured.
    await app.post(`/api/campaigns/${id}/pause`);
    const paused = await app.call(`/api/campaigns/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ send_time: "11:00" }),
    });
    expect(paused.status).toBe(400);

    // A draft campaign can still be configured.
    const draftId = await plannedCampaign(app, d1, 1, { cap: 1, days: "1,2,3,4,5", time: "10:00" });
    d1.exec(`UPDATE campaigns SET status='draft' WHERE id=${draftId}`);
    const ok = await app.call(`/api/campaigns/${draftId}`, {
      method: "PATCH",
      body: JSON.stringify({ daily_cap: 250 }),
    });
    expect(ok.status).toBe(200);
    expect(campaignRow(d1, draftId).daily_cap).toBe(250);
  });

  it("rejects a malformed time or zone instead of storing it", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const created = await app.post("/api/campaigns", { name: "Bad plan", from_email: "a@b.com" });
    const bad = await app.call(`/api/campaigns/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ send_time: "25:00" }),
    });
    expect(bad.status).toBe(400);
    const badZone = await app.call(`/api/campaigns/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ send_timezone: "Mars/Olympus" }),
    });
    expect(badZone.status).toBe(400);
    expect(campaignRow(d1, created.id).send_time).toBeNull();
  });

  it("clears the plan when every field is switched off", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const created = await app.post("/api/campaigns", {
      name: "Cleared",
      from_email: "a@b.com",
      daily_cap: 200,
      send_days: [1, 2, 3, 4, 5],
      send_time: "10:00",
      send_timezone: BNE,
    });
    const row = campaignRow(d1, created.id);
    expect(row.daily_cap).toBe(200);
    expect(row.send_days).toBe("1,2,3,4,5");

    await app.patch(`/api/campaigns/${created.id}`, {
      daily_cap: null,
      send_days: null,
      send_time: null,
      send_timezone: null,
    });
    const cleared = campaignRow(d1, created.id);
    expect(cleared.daily_cap).toBeNull();
    expect(cleared.send_days).toBeNull();
    expect(cleared.send_time).toBeNull();
    expect(cleared.send_timezone).toBeNull();
  });
});

describe("progress", () => {
  it("reports today's batch, what is left and the projected finish", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 5, { cap: 2, days: "1,2,3,4,5", time: "10:00" });

    await dispatchDueCampaigns(app.env, WED_1000);
    deliverQueued(d1, id, "2026-09-23T01:00:00Z");

    const p = await campaignProgress(app.env, campaignRow(d1, id), WED_1000 + 3600);
    expect(p.planned).toBe(true);
    expect(p.timezone).toBe(BNE);
    expect(p.daily_cap).toBe(2);
    expect(p.released_today).toBe(2);
    expect(p.sent_today).toBe(2);
    expect(p.total).toBe(2);
    expect(p.sent).toBe(2);
    expect(p.remaining).toBe(3);
    // Today's cap is spent, so the projection starts on Thursday: Thu(2) + Fri(1).
    expect(p.projected_days).toBe(2);
    expect(p.projected_finish_day).toBe("2026-09-25");
    expect(p.plan_words).toBe("up to 2 a day, weekdays, from 10:00 Australia/Brisbane");
  });

  it("reports no plan for a campaign that sends all at once", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const created = await app.post("/api/campaigns", { name: "Plain", from_email: "a@b.com" });
    const p = await campaignProgress(app.env, campaignRow(d1, created.id), WED_1000);
    expect(p.planned).toBe(false);
    expect(p.plan_words).toBeNull();
    expect(p.remaining).toBe(0);
  });

  it("reflects a schedule endpoint call that only had a plan to go on", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    seedContacts(d1, 3);
    const created = await app.post("/api/campaigns", {
      name: "Plan-only",
      from_email: "a@b.com",
      template_id: makeTemplate(d1),
    });
    await app.patch(`/api/campaigns/${created.id}`, {
      daily_cap: 2,
      send_days: [1, 2, 3, 4, 5],
      send_time: "10:00",
      send_timezone: BNE,
    });
    // No scheduled_at supplied: with a plan the window decides, so the server
    // stores the next opening rather than refusing the request.
    const res = await app.post(`/api/campaigns/${created.id}/schedule`);
    expect(res.ok).toBe(true);
    expect(res.planned).toBe(true);
    expect(typeof res.scheduled_at).toBe("number");
    expect(res.scheduled_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

// A ramp starts the drip below its daily cap and steps up to it. The step is
// derived from the sends table (distinct local days that actually sent), never
// from a stored day counter, so the same re-entry rules the flat cap relies on
// have to hold here too: a second tick inside a day does not advance it, a
// skipped weekend does not consume a step, and a resumed campaign continues
// from where its sends say it is.
describe("ramp-up", () => {
  it("starts at the ramp allowance and steps up to the full cap", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    // Day 1: 2, day 2 onward: 5.
    const id = await plannedCampaign(app, d1, 12, {
      cap: 5,
      days: "1,2,3,4,5",
      time: "10:00",
      rampStart: 2,
      rampDays: 2,
    });
    expect(campaignRow(d1, id).ramp_start).toBe(2);
    expect(campaignRow(d1, id).ramp_days).toBe(2);

    // Day one (Wednesday) releases the start figure, not the cap.
    await dispatchDueCampaigns(app.env, WED_1000);
    expect(app.queued).toHaveLength(2);
    deliverQueued(d1, id, "2026-09-23T01:00:00Z");

    // Day two is at the full cap, and stays there.
    await dispatchDueCampaigns(app.env, THU_1000);
    expect(app.queued).toHaveLength(7);
    deliverQueued(d1, id, "2026-09-24T01:00:00Z");

    await dispatchDueCampaigns(app.env, FRI_1000);
    expect(app.queued).toHaveLength(12);
    // The last batch leaves the campaign 'sending' until the queue has drained
    // and the settling pass runs (the consumer's, or the editor's
    // refresh-status), exactly as a flat drip does.
    deliverQueued(d1, id, "2026-09-25T01:00:00Z");
    const settled = await app.post(`/api/campaigns/${id}/refresh-status`);
    expect(settled.row.status).toBe("sent");
    // Every job is a distinct send row: nothing was released or queued twice.
    expect(new Set(app.queued.map((j) => j.send_id)).size).toBe(12);
  });

  it("does not let a skipped weekend spend an early, smaller step", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    // Day 1: 2, day 2: 4, day 3: 6, day 4: 8, day 5 onward: 10.
    const id = await plannedCampaign(app, d1, 30, {
      cap: 10,
      days: "1,2,3,4,5",
      time: "10:00",
      rampStart: 2,
      rampDays: 5,
    });

    await dispatchDueCampaigns(app.env, WED_1000); // day 1
    expect(app.queued).toHaveLength(2);
    deliverQueued(d1, id, "2026-09-23T01:00:00Z");
    await dispatchDueCampaigns(app.env, THU_1000); // day 2
    expect(app.queued).toHaveLength(6);
    deliverQueued(d1, id, "2026-09-24T01:00:00Z");

    // Friday, Saturday and Sunday pass with no ticks at all. Monday is still
    // only sending day 3, so its batch is 6 - not the 10 a ramp measured in
    // calendar days would have handed it.
    await dispatchDueCampaigns(app.env, MON_1000);
    expect(app.queued).toHaveLength(12);
    deliverQueued(d1, id, "2026-09-28T01:00:00Z");

    // ...and Tuesday is day 4, so the ramp is still climbing, not finished.
    await dispatchDueCampaigns(app.env, TUE_1000);
    expect(app.queued).toHaveLength(20);
  });

  it("resumes the ramp where the sends say it is, not where the calendar is", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 30, {
      cap: 10,
      days: "1,2,3,4,5",
      time: "10:00",
      rampStart: 2,
      rampDays: 5,
    });
    await dispatchDueCampaigns(app.env, WED_1000); // day 1 -> 2
    expect(app.queued).toHaveLength(2);
    deliverQueued(d1, id, "2026-09-23T01:00:00Z");

    expect((await app.post(`/api/campaigns/${id}/pause`)).ok).toBe(true);
    for (let i = 0; i < 60; i++) await dispatchDueCampaigns(app.env, THU_1000 + i);
    for (let i = 0; i < 60; i++) await dispatchDueCampaigns(app.env, FRI_1000 + i);
    expect(app.queued).toHaveLength(2); // paused days are not sending days

    expect((await app.post(`/api/campaigns/${id}/resume`)).ok).toBe(true);
    // Only Wednesday has sends, so Monday is sending day 2: 4, not day 5's 10.
    await dispatchDueCampaigns(app.env, MON_1000);
    expect(app.queued).toHaveLength(6);
  });

  it("does not advance the ramp however often the cron re-enters within a day", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 50, {
      cap: 10,
      days: "1,2,3,4,5",
      time: "10:00",
      rampStart: 2,
      rampDays: 5,
    });
    for (let i = 0; i < 60; i++) await dispatchDueCampaigns(app.env, WED_1000 + 300 + i);
    expect(app.queued).toHaveLength(2); // day one's step, once
    expect(sendsOf(d1, id)).toHaveLength(2);
  });

  it("is today's behaviour when there is no ramp", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 12, { cap: 5, days: "1,2,3,4,5", time: "10:00" });
    expect(campaignRow(d1, id).ramp_start).toBeNull();
    expect(campaignRow(d1, id).ramp_days).toBeNull();
    await dispatchDueCampaigns(app.env, WED_1000);
    expect(app.queued).toHaveLength(5); // the full cap from day one
  });

  it("falls back to the flat cap when the ramp cannot apply", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    // A start above the cap is stored as given and does nothing surprising.
    const highStart = await plannedCampaign(app, d1, 12, {
      cap: 5,
      days: "1,2,3,4,5",
      time: "10:00",
      rampStart: 9,
      rampDays: 2,
    });
    expect(campaignRow(d1, highStart).ramp_start).toBe(9);
    await dispatchDueCampaigns(app.env, WED_1000);
    expect(app.queued).toHaveLength(5);

    // ramp_days = 1 has no day to grow across, so it is a flat cap too.
    await plannedCampaign(app, d1, 12, {
      cap: 5,
      days: "1,2,3,4,5",
      time: "10:00",
      rampStart: 1,
      rampDays: 1,
    });
    await dispatchDueCampaigns(app.env, WED_1000);
    expect(app.queued).toHaveLength(10);
  });

  it("projects the finish from the ramp, not from a flat cap", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 10, {
      cap: 5,
      days: "1,2,3,4,5",
      time: "10:00",
      rampStart: 3,
      rampDays: 2,
    });
    // Wed 10:05 Brisbane, nothing released yet: sending day 1 is 3, not 5, so
    // the tail is a day longer than the flat cap would claim.
    const p = await campaignProgress(app.env, campaignRow(d1, id), WED_1000 + 300);
    expect(p.ramp_active).toBe(true);
    expect(p.ramp_words).toBe("Day 1: 3, day 2 onward: 5");
    expect(p.sending_day).toBe(1);
    expect(p.day_allowance).toBe(3);
    expect(p.today_allowance).toBe(3);
    expect(p.projected_days).toBe(3); // Wed 3, Thu 5, Fri 2
    expect(p.projected_finish_day).toBe("2026-09-25");
    expect(p.plan_words).toBe(
      "Day 1: 3, day 2 onward: 5, weekdays, from 10:00 Australia/Brisbane",
    );

    // The same 10 recipients with no ramp finish a day earlier: seed nobody new,
    // or the flat campaign would be measuring a bigger audience than the ramped
    // one.
    const flatId = await plannedCampaign(app, d1, 0, {
      cap: 5,
      days: "1,2,3,4,5",
      time: "10:00",
    });
    const f = await campaignProgress(app.env, campaignRow(d1, flatId), WED_1000 + 300);
    expect(f.ramp_active).toBe(false);
    expect(f.ramp_words).toBeNull();
    expect(f.projected_days).toBe(2);
    expect(f.projected_finish_day).toBe("2026-09-24");
  });

  it("reports the ramp already used, so a running drip shows its real step", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 30, {
      cap: 10,
      days: "1,2,3,4,5",
      time: "10:00",
      rampStart: 2,
      rampDays: 5,
    });
    await dispatchDueCampaigns(app.env, WED_1000); // day 1 -> 2
    deliverQueued(d1, id, "2026-09-23T01:00:00Z");

    // Thursday, with Wednesday's sends behind it: day 2, allowance 4.
    const p = await campaignProgress(app.env, campaignRow(d1, id), THU_1000 + 300);
    expect(p.sending_day).toBe(2);
    expect(p.day_allowance).toBe(4);
    expect(p.today_allowance).toBe(4);

    // Later that same day, the projection must not call it day 3.
    await dispatchDueCampaigns(app.env, THU_1000 + 600);
    const after = await campaignProgress(app.env, campaignRow(d1, id), THU_1000 + 900);
    expect(after.sending_day).toBe(2); // it still *is* day 2...
    expect(after.today_allowance).toBe(0); // ...and its step is spent
  });

  it("carries the ramp onto a duplicate, which can then be re-tuned", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 6, {
      cap: 5,
      days: "1,2,3,4,5",
      time: "10:00",
      rampStart: 2,
      rampDays: 3,
    });
    const dup = await app.post(`/api/campaigns/${id}/duplicate`, { name: "Copy" });
    const row = campaignRow(d1, dup.id);
    expect(row.daily_cap).toBe(5);
    expect(row.ramp_start).toBe(2);
    expect(row.ramp_days).toBe(3);
    // The clone is a draft, so its ramp is editable again.
    const patched = await app.patch(`/api/campaigns/${dup.id}`, { ramp_start: 4, ramp_days: 2 });
    expect(patched.ok).toBe(true);
    expect(campaignRow(d1, dup.id).ramp_start).toBe(4);
  });

  it("locks the ramp with the rest of the plan once the campaign is running", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 12, {
      cap: 5,
      days: "1,2,3,4,5",
      time: "10:00",
      rampStart: 2,
      rampDays: 2,
    });
    await dispatchDueCampaigns(app.env, WED_1000); // -> sending
    const res = await app.call(`/api/campaigns/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ ramp_start: 5 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain("cannot change the sending schedule");
    expect(campaignRow(d1, id).ramp_start).toBe(2);
  });
});

// A spread meters each day's batch across its spread window instead of dumping
// the day's allowance at the window. The release is measured against the clock
// (`elapsed x rate`), not against the tick count, so a missed tick releases the
// slices time has earned - never a backlog - and the day still totals its
// allowance by the end of the spread.
describe("spread", () => {
  it("spreads the day's batch across ticks instead of releasing it at the window", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    // 10 a day spread over 10 minutes: one recipient a minute.
    const id = await plannedCampaign(app, d1, 30, {
      cap: 10,
      days: "1,2,3,4,5",
      time: "10:00",
      spread: 10,
    });
    expect(campaignRow(d1, id).spread_minutes).toBe(10);

    // The window tick releases the first slice only - not the whole day.
    await dispatchDueCampaigns(app.env, WED_1000);
    expect(app.queued).toHaveLength(1);
    expect(statusOf(d1, id).status).toBe("sending");
    // A second tick inside the same minute releases nothing extra.
    await dispatchDueCampaigns(app.env, WED_1000 + 30);
    expect(app.queued).toHaveLength(1);

    // ...one slice a minute after that.
    for (let m = 1; m <= 9; m++) {
      await dispatchDueCampaigns(app.env, WED_1000 + m * 60);
      expect(app.queued).toHaveLength(1 + m);
    }
    // The day totalled its allowance, and every job is a distinct send row.
    expect(app.queued).toHaveLength(10);
    expect(new Set(app.queued.map((j) => j.send_id)).size).toBe(10);
    // 20 recipients are still waiting for later windows.
    expect(statusOf(d1, id).status).toBe("sending");
  });

  it("never lets a missed tick become a catch-up burst", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    // 10 a day over 10 minutes, but the cron misses the first five minutes.
    const id = await plannedCampaign(app, d1, 30, {
      cap: 10,
      days: "1,2,3,4,5",
      time: "10:00",
      spread: 10,
    });
    await dispatchDueCampaigns(app.env, WED_1000 + 300); // minute 5, first tick
    // The clock owes six slices - not the rest of the day.
    expect(app.queued).toHaveLength(6);
    expect(app.queued.length).toBeLessThan(10);

    // The day still finishes on time, and still totals exactly its allowance.
    await dispatchDueCampaigns(app.env, WED_1000 + 540); // minute 9
    expect(app.queued).toHaveLength(10);
  });

  it("holds the release back until the window, and never past the cap", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 30, {
      cap: 10,
      days: "1,2,3,4,5",
      time: "10:00",
      spread: 60,
    });
    // A minute before the window: nothing is due, and the campaign has not started.
    await dispatchDueCampaigns(app.env, at("2026-09-22T23:59:00Z")); // Wed 09:59 Brisbane
    expect(app.queued).toHaveLength(0);
    expect(statusOf(d1, id).status).toBe("scheduled");

    // Long after the spread has elapsed: still only the day's cap, never more.
    for (let m = 0; m <= 90; m++) await dispatchDueCampaigns(app.env, WED_1000 + m * 60);
    expect(app.queued).toHaveLength(10);
    expect(await releasedTodayCount(app.env, id, BNE, WED_1000 + 6000)).toBe(10);
  });

  it("keeps today's single-burst behaviour when the spread is 0", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 30, {
      cap: 10,
      days: "1,2,3,4,5",
      time: "10:00",
      spread: 0,
    });
    // 0 is stored as NULL: no spread at all.
    expect(campaignRow(d1, id).spread_minutes).toBeNull();
    await dispatchDueCampaigns(app.env, WED_1000);
    expect(app.queued).toHaveLength(10); // the whole day, at the window
  });

  it("meters the ramp's step for the day, not the cap", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    // Day 1 is 2 (the ramp), spread over 10 minutes; the cap is 10.
    const id = await plannedCampaign(app, d1, 30, {
      cap: 10,
      days: "1,2,3,4,5",
      time: "10:00",
      rampStart: 2,
      rampDays: 2,
      spread: 10,
    });
    for (let m = 0; m <= 9; m++) await dispatchDueCampaigns(app.env, WED_1000 + m * 60);
    // The whole day was metered out, and it totalled the ramp's step - never the cap.
    expect(app.queued).toHaveLength(2);
    deliverQueued(d1, id, "2026-09-23T02:00:00Z");

    // Day two is the full cap, still metered a slice at a time.
    for (let m = 0; m <= 9; m++) await dispatchDueCampaigns(app.env, THU_1000 + m * 60);
    expect(app.queued).toHaveLength(12);
  });

  it("projects the finish with the ramp and the spread together", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 100, {
      cap: 50,
      days: "1,2,3,4,5",
      time: "10:00",
      rampStart: 30,
      rampDays: 2,
      spread: 10,
    });
    const p = await campaignProgress(app.env, campaignRow(d1, id), WED_1000 + 300); // Wed 10:05
    expect(p.spread_minutes).toBe(10);
    expect(p.spread_words).toBe("spread across 10 minutes (up to ~5 a minute)");
    expect(p.plan_words).toBe(
      "Day 1: 30, day 2 onward: 50, spread across 10 minutes (up to ~5 a minute), weekdays, from 10:00 Australia/Brisbane",
    );
    // Wed 30, Thu 50, Fri 20 - the spread meters those days, it does not shrink
    // them, so the day count is the ramp's, not a flat cap's.
    expect(p.projected_days).toBe(3);
    expect(p.projected_finish_day).toBe("2026-09-25");
    // Friday needs 20 of its 50, which is 4 of the ten one-minute slices.
    expect(p.projected_finish_at).toBe(at("2026-09-25T00:03:00Z"));
  });
});

// On 23 Sep 2026 campaign 23 was released twice in one day: 600 rows for a day
// whose allowance was the ramp's first step of 300. The dispatcher's allowance is
// a number read from `sends`, and the release is a write that happens later —
// with an audience resolve of a few thousand rows in between. The 11:32:49Z pass
// read the day's count while the table was empty and then spent its time
// resolving; the 11:33:49Z pass read the same zero, released the head of the
// audience, and the 11:32:49Z pass came back and released the *next* slice — it
// selected recipients after the first pass had written (so it skipped them) but
// it was still spending an allowance figure from before them. Two passes, two
// full allowances, one day.
//
// The count is the design and it stays the design. What these tests pin is that
// the day's ceiling is enforced at the write, in the same statement, so an
// overlap cannot spend the day's allowance twice - and that nothing else about
// the plan (the ramp's next day, a mid-window entry) changed.

describe("overlapping dispatcher passes", () => {
  /** The slice of D1 these tests need: the shim and the real binding both fit. */
  type AnyD1 = {
    prepare: (sql: string) => any;
    batch: (stmts: any[]) => Promise<any>;
    exec: (sql: string) => unknown;
  };

  /**
   * A test D1 whose first read matching `only` waits for `release()` before it
   * answers. That is how a dispatcher pass that outlives its minute is
   * reproduced: the held pass has read the day's count but has not written, so
   * the next pass runs end to end while it is still in flight.
   */
  function holdRead(d1: AnyD1, only: RegExp) {
    let armed = true;
    let reached!: () => void;
    const atRead = new Promise<void>((r) => (reached = r));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));

    const wrap = (stmt: any): any =>
      new Proxy(stmt, {
        get(target: any, prop: string | symbol) {
          const value = Reflect.get(target, prop);
          if (typeof value !== "function") return value;
          if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
          if (prop === "run" || prop === "all" || prop === "first") {
            return async (...args: unknown[]) => {
              if (armed) {
                armed = false;
                reached();
                await gate;
              }
              return value.apply(target, args);
            };
          }
          return value.bind(target);
        },
      });

    const db = {
      prepare: (sql: string) => (only.test(sql) ? wrap(d1.prepare(sql)) : d1.prepare(sql)),
      batch: (stmts: any[]) => d1.batch(stmts),
      exec: (sql: string) => d1.exec(sql),
    } as unknown as TestD1;

    return { db, atRead, release: () => open() };
  }

  /** The app's env with a different D1 and its own queue, for the held pass. */
  function envWith(env: Env, db: unknown, queued: SendJob[]): Env {
    return {
      ...env,
      DB: db,
      SEND_QUEUE: {
        sendBatch: async (msgs: { body: SendJob }[]) => {
          for (const m of msgs) queued.push(m.body);
        },
      },
    } as unknown as Env;
  }

  it("releases the day's allowance once when a slow pass is still in flight", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    // The live shape in miniature: day 1 of a 3 -> 5 ramp, spread across the
    // hour, so by 11:32 the whole step is due and 12 recipients are waiting.
    const id = await plannedCampaign(app, d1, 12, {
      cap: 5,
      days: "1,2,3,4,5",
      time: "10:00",
      rampStart: 3,
      rampDays: 2,
      spread: 60,
    });

    // The 11:32 pass: it reads the day's count (still zero), then stalls before
    // writing anything - where a real tick sits while it resolves its audience.
    const held = holdRead(app.env.DB, /contact_id FROM sends/);
    const slowQueued: SendJob[] = [];
    const slow = runPlanTick(envWith(app.env, held.db, slowQueued), campaignRow(d1, id), {
      nowSeconds: WED_1132,
    });
    await held.atRead;

    // The 11:33 pass runs end to end while the first one is still in flight.
    const next = await dispatchDueCampaigns(app.env, WED_1133);
    expect(next.plans[0]).toMatchObject({ action: "released", released: 3 });
    expect(sendsOf(d1, id)).toHaveLength(3);
    expect(sendsOf(d1, id).every((s) => s.status === "queued")).toBe(true);

    // Now the stalled pass finishes. The day is already spent: it must release
    // nothing, and it must not hand anything to the queue.
    held.release();
    const late = await slow;
    expect(late.released).toBe(0);
    expect(late.action).toBe("cap-reached");
    expect(slowQueued).toHaveLength(0);

    // The day's allowance, once: the ramp's day 1 is 3, not 6, and never 5.
    expect(sendsOf(d1, id)).toHaveLength(3);
    expect(new Set(sendsOf(d1, id).map((s) => s.id)).size).toBe(3);
    expect(await releasedTodayCount(app.env, id, BNE, WED_1133)).toBe(3);
  });

  it("releases nothing on a second pass the same day, batch still queued", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 8, { cap: 3, days: "1,2,3,4,5", time: "10:00" });

    const first = await dispatchDueCampaigns(app.env, WED_1000);
    expect(first.plans[0]).toMatchObject({ action: "released", released: 3 });
    // Every released row is still in flight: sent_at NULL for all of them.
    expect(sendsOf(d1, id).every((s) => s.status === "queued")).toBe(true);

    for (const offset of [60, 1800, 3600]) {
      const again = await dispatchDueCampaigns(app.env, WED_1000 + offset);
      expect(again.plans[0]).toMatchObject({ action: "cap-reached", released: 0 });
    }
    expect(app.queued).toHaveLength(3);
    expect(sendsOf(d1, id)).toHaveLength(3);
  });

  it("releases nothing when the next pass lands inside the same minute", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 6, { cap: 2, days: "1,2,3,4,5", time: "10:00" });

    await dispatchDueCampaigns(app.env, WED_1000);
    expect(app.queued).toHaveLength(2);
    // The same instant, then five and forty seconds later: spent either way.
    for (const offset of [0, 5, 40]) await dispatchDueCampaigns(app.env, WED_1000 + offset);
    expect(app.queued).toHaveLength(2);
    expect(sendsOf(d1, id)).toHaveLength(2);
  });

  it("still gives the ramp's next day its own allowance", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    // Day 1: 3, day 2 onward: 5.
    const id = await plannedCampaign(app, d1, 12, {
      cap: 5,
      days: "1,2,3,4,5",
      time: "10:00",
      rampStart: 3,
      rampDays: 2,
    });
    await dispatchDueCampaigns(app.env, WED_1000);
    expect(app.queued).toHaveLength(3);
    deliverQueued(d1, id, "2026-09-23T01:00:00Z");

    await dispatchDueCampaigns(app.env, THU_1000);
    expect(app.queued).toHaveLength(8); // the ramp's day 2 is the full cap: +5
    for (const offset of [60, 600]) await dispatchDueCampaigns(app.env, THU_1000 + offset);
    expect(app.queued).toHaveLength(8);
    expect(sendsOf(d1, id)).toHaveLength(8);
  });

  it("enters the plan mid-window and releases the day once, even while overlapping", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const id = await plannedCampaign(app, d1, 12, {
      cap: 5,
      days: "1,2,3,4,5",
      time: "10:00",
      rampStart: 3,
      rampDays: 2,
    });
    // The Schedule dialog's next-occurrence default: tomorrow's window, while
    // today's 10:00 window has been open for well over an hour.
    d1.exec(`UPDATE campaigns SET scheduled_at=${THU_1000} WHERE id=${id}`);
    const early = await dispatchDueCampaigns(app.env, WED_1132);
    expect(early.plans[0]).toMatchObject({ action: "not-due", released: 0 });
    expect(statusOf(d1, id).status).toBe("scheduled");

    // Cleared at 11:32, so today's open window decides - the exact sequence that
    // produced the first live release. Entering mid-window is not special: the
    // day's allowance is the ramp's first step, and two overlapping passes still
    // share it.
    d1.exec(`UPDATE campaigns SET scheduled_at=NULL WHERE id=${id}`);
    const held = holdRead(app.env.DB, /contact_id FROM sends/);
    const slowQueued: SendJob[] = [];
    const slow = runPlanTick(envWith(app.env, held.db, slowQueued), campaignRow(d1, id), {
      nowSeconds: WED_1132,
    });
    await held.atRead;

    const next = await dispatchDueCampaigns(app.env, WED_1133);
    expect(next.plans[0]).toMatchObject({ action: "released", released: 3 });

    held.release();
    const late = await slow;
    expect(late.released).toBe(0);
    expect(slowQueued).toHaveLength(0);

    expect(sendsOf(d1, id)).toHaveLength(3);
    // The pass that entered mid-window still started the campaign properly.
    expect(statusOf(d1, id).status).toBe("sending");
    expect(statusOf(d1, id).started_at).not.toBeNull();
  });
});
