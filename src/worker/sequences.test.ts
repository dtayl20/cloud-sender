// Sequenced email campaigns: wait timing, step-due-by-position, the append
// preview/confirm gate, mid-insertion skip, both re-enrol modes, stopping on
// unsubscribe / hard bounce, duplicate-send prevention, local-time windowing and
// test-mode isolation.
//
// These exercise the real engine and the real migration files against in-memory
// SQLite, so the SQL is what is checked. Every instant is explicit, so nothing
// depends on the machine clock or its timezone.

import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { Env, SendJob } from "./types";
import {
  acquireSequenceLease,
  confirmRelease,
  dispatchSequences,
  enrollContacts,
  loadSteps,
  nextDueAt,
  nextStepAfter,
  releasePreview,
  reenroll,
  removeEnrollment,
  runSequenceTest,
  runSequenceTick,
  sequenceMetrics,
  stopContactSequences,
  type SequenceRow,
} from "./sequences";
import { sequencesRoutes } from "./routes/sequences";
import { webhooksRoutes } from "./webhooks";
import { processSendBatch } from "./consumer";

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
  "0012_contact_rate.sql",
  "0013_ghl_send_template.sql",
  "0014_ghl_engagement_writeback.sql",
  "0015_ghl_tag_trigger_campaign.sql",
  "0016_email_verification.sql",
  "0017_email_verification_backfill.sql",
  "0018_email_verify_queue.sql",
  "0019_verify_lock.sql",
  "0020_sequences.sql",
  "0021_sequence_timezone_backfill.sql",
];

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const T0 = at("2026-10-07T23:00:00Z");
const DAY = 86400;

function freshDb(): TestD1 {
  const d1 = createTestD1();
  applyMigrations(d1, MIGRATIONS);
  return d1;
}

function makeEnv(d1: TestD1) {
  const jobs: { body: SendJob; opts?: { delaySeconds?: number } }[] = [];
  const env = {
    DB: d1,
    SEND_QUEUE: {
      send: async (body: SendJob, opts?: { delaySeconds?: number }) => {
        jobs.push({ body, opts });
      },
      sendBatch: async (msgs: { body: SendJob }[]) => {
        for (const m of msgs) jobs.push({ body: m.body });
      },
    },
    SEND_TIMEZONE: "Australia/Brisbane",
    DEFAULT_FROM_EMAIL: "from@localdentists.au",
    DEFAULT_FROM_NAME: "LocalDentists.au",
    WEBHOOK_TOKEN: "tok",
  } as unknown as Env;
  return { env, jobs };
}

function insertContact(
  d1: TestD1,
  email: string,
  opts: { status?: string; email_status?: string | null; timezone?: string | null } = {},
): number {
  d1.sql(
    `INSERT INTO contacts (email, status, email_status, attributes, timezone) VALUES (?,?,?,?,?)`,
    email,
    opts.status ?? "active",
    opts.email_status === undefined ? "valid" : opts.email_status,
    "{}",
    opts.timezone ?? null,
  );
  return Number(d1.sql<{ id: number }>("SELECT id FROM contacts WHERE email=?", email)[0].id);
}

function makeSequence(
  d1: TestD1,
  opts: {
    name?: string;
    status?: string;
    steps?: { wait_minutes?: number; name?: string }[];
    send_time?: string | null;
    send_days?: string | null;
    send_timezone?: string | null;
    daily_cap?: number | null;
    from_email?: string | null;
  } = {},
): number {
  d1.sql(
    `INSERT INTO sequences (name, status, from_email, send_time, send_days, send_timezone, daily_cap)
     VALUES (?,?,?,?,?,?,?)`,
    opts.name ?? "Seq",
    opts.status ?? "active",
    opts.from_email === undefined ? "from@localdentists.au" : opts.from_email,
    opts.send_time ?? null,
    opts.send_days ?? null,
    opts.send_timezone ?? null,
    opts.daily_cap ?? null,
  );
  const id = Number(d1.sql<{ id: number }>("SELECT id FROM sequences ORDER BY id DESC LIMIT 1")[0].id);
  let pos = 0;
  for (const s of opts.steps ?? [{ wait_minutes: 0 }]) {
    pos += 1000;
    d1.sql(
      `INSERT INTO sequence_steps (sequence_id, position, name, wait_minutes) VALUES (?,?,?,?)`,
      id,
      pos,
      s.name ?? null,
      s.wait_minutes ?? 0,
    );
  }
  return id;
}

function getSeq(d1: TestD1, id: number): SequenceRow {
  return d1.sql<SequenceRow>("SELECT * FROM sequences WHERE id=?", id)[0];
}

function sendPositions(d1: TestD1, seqId: number): number[] {
  return d1
    .sql<{ step_position: number }>(
      "SELECT step_position FROM sequence_sends WHERE sequence_id=? ORDER BY step_position",
      seqId,
    )
    .map((r) => Number(r.step_position));
}

function enrollment(d1: TestD1, seqId: number, contactId: number) {
  return d1.sql<any>(
    "SELECT * FROM sequence_enrollments WHERE sequence_id=? AND contact_id=?",
    seqId,
    contactId,
  )[0];
}

function events(d1: TestD1, seqId: number, type?: string) {
  return type
    ? d1.sql<{ type: string; detail: string | null }>(
        "SELECT type, detail FROM sequence_events WHERE sequence_id=? AND type=? ORDER BY id",
        seqId,
        type,
      )
    : d1.sql<{ type: string; detail: string | null }>(
        "SELECT type, detail FROM sequence_events WHERE sequence_id=? ORDER BY id",
        seqId,
      );
}

function makeApp(d1: TestD1, env: Env) {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/sequences", sequencesRoutes);
  app.route("/api/webhooks", webhooksRoutes);
  const call = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://test${path}`, init), env);
  const json = async (path: string, init?: RequestInit) => (await call(path, init)).json() as any;
  return {
    call,
    get: (p: string) => json(p),
    post: (p: string, b?: unknown) => json(p, { method: "POST", body: JSON.stringify(b ?? {}) }),
  };
}

// ---------------------------------------------------------------------------

describe("wait timing (relative to the previous send)", () => {
  it("sends step 1 at enrolment, then each step's wait after the previous send", async () => {
    const d1 = freshDb();
    const { env, jobs } = makeEnv(d1);
    const c = insertContact(d1, "a@example.com");
    // step 1 immediate, step 2 after 3 days, step 3 after 1 day.
    const seqId = makeSequence(d1, {
      steps: [{ wait_minutes: 0 }, { wait_minutes: 4320 }, { wait_minutes: 1440 }],
    });
    const seq = getSeq(d1, seqId);
    await enrollContacts(env, seq, [{ id: c, email: "a@example.com" }], "restart", T0);

    expect((await runSequenceTick(env, seq, { nowSeconds: T0 })).released).toBe(1);
    expect(sendPositions(d1, seqId)).toEqual([1000]);

    // Two days later: step 2 is not due yet (3-day wait from the first send).
    expect((await runSequenceTick(env, seq, { nowSeconds: T0 + 2 * DAY })).released).toBe(0);
    expect(sendPositions(d1, seqId)).toEqual([1000]);

    // Exactly three days: due.
    expect((await runSequenceTick(env, seq, { nowSeconds: T0 + 3 * DAY })).released).toBe(1);
    expect(sendPositions(d1, seqId)).toEqual([1000, 2000]);

    // One more day: step 3.
    expect((await runSequenceTick(env, seq, { nowSeconds: T0 + 4 * DAY })).released).toBe(1);
    expect(sendPositions(d1, seqId)).toEqual([1000, 2000, 3000]);
    expect(enrollment(d1, seqId, c).status).toBe("completed");
  });

  it("measures step 1 from enrolment, not from the sequence start", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const c = insertContact(d1, "b@example.com");
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 60 }] });
    const seq = getSeq(d1, seqId);
    await enrollContacts(env, seq, [{ id: c, email: "b@example.com" }], "restart", T0);

    expect((await runSequenceTick(env, seq, { nowSeconds: T0 + 59 * 60 })).released).toBe(0);
    expect((await runSequenceTick(env, seq, { nowSeconds: T0 + 60 * 60 })).released).toBe(1);
  });
});

describe("step due by position, not index", () => {
  it("stops at the last step and never restarts", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const c = insertContact(d1, "c@example.com");
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }, { wait_minutes: 0 }] });
    const seq = getSeq(d1, seqId);
    await enrollContacts(env, seq, [{ id: c, email: "c@example.com" }], "restart", T0);

    await runSequenceTick(env, seq, { nowSeconds: T0 });
    await runSequenceTick(env, seq, { nowSeconds: T0 + 1 });
    expect(sendPositions(d1, seqId)).toEqual([1000, 2000]);
    expect(enrollment(d1, seqId, c).status).toBe("completed");

    // Many later ticks do nothing: there is no step after the last position.
    for (let i = 0; i < 5; i++) await runSequenceTick(env, seq, { nowSeconds: T0 + 100 + i });
    expect(sendPositions(d1, seqId)).toEqual([1000, 2000]);
  });
});

describe("duplicate-send prevention", () => {
  it("never sends the same step twice, even when the position is rewound", async () => {
    const d1 = freshDb();
    const { env, jobs } = makeEnv(d1);
    const c = insertContact(d1, "d@example.com");
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }, { wait_minutes: 4320 }] });
    const seq = getSeq(d1, seqId);
    await enrollContacts(env, seq, [{ id: c, email: "d@example.com" }], "restart", T0);

    await runSequenceTick(env, seq, { nowSeconds: T0 });
    expect(jobs.length).toBe(1);
    await runSequenceTick(env, seq, { nowSeconds: T0 }); // same instant, re-entered tick
    expect(jobs.length).toBe(1); // no second release
    expect(sendPositions(d1, seqId)).toEqual([1000]);

    // Force a release attempt for an already-sent position: the UNIQUE key wins.
    d1.sql("UPDATE sequence_enrollments SET last_sent_position=0 WHERE sequence_id=? AND contact_id=?", seqId, c);
    const tick = await runSequenceTick(env, seq, { nowSeconds: T0 });
    expect(tick.released).toBe(0);
    expect(jobs.length).toBe(1);
    expect(sendPositions(d1, seqId)).toEqual([1000]);
  });

  it("only one dispatcher claims the single-flight lease", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const first = await acquireSequenceLease(env, 1000, "a");
    expect(first.acquired).toBe(true);
    const second = await acquireSequenceLease(env, 1001, "b");
    expect(second.acquired).toBe(false);
    // A held lease makes the cron pass a no-op.
    const r = await dispatchSequences(env, 1002);
    expect(r.skipped).toBe(true);
  });
});

describe("append -> release preview -> confirm", () => {
  it("does not release an appended step to completed contacts until confirmed", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const c = insertContact(d1, "e@example.com");
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }, { wait_minutes: 0 }] });
    let seq = getSeq(d1, seqId);
    await enrollContacts(env, seq, [{ id: c, email: "e@example.com" }], "restart", T0);

    await runSequenceTick(env, seq, { nowSeconds: T0 });
    await runSequenceTick(env, seq, { nowSeconds: T0 });
    expect(enrollment(d1, seqId, c).status).toBe("completed");

    // Append step 3 (unreleased to completed contacts).
    d1.sql(
      "INSERT INTO sequence_steps (sequence_id, position, wait_minutes) VALUES (?, 3000, 0)",
      seqId,
    );
    seq = getSeq(d1, seqId);

    // A tick does nothing: the completed contact is not active.
    expect((await runSequenceTick(env, seq, { nowSeconds: T0 + 10 })).released).toBe(0);
    expect(sendPositions(d1, seqId)).toEqual([1000, 2000]);

    const preview = await releasePreview(env, seq);
    expect(preview.would_qualify).toBe(1);
    expect(preview.remain_active).toBe(0);
    expect(preview.pending_steps.map((s) => s.position)).toEqual([3000]);

    const confirmed = await confirmRelease(env, seq, { nowSeconds: T0 + 10 });
    expect(confirmed.released_steps).toBe(1);
    expect(confirmed.reactivated).toBe(1);
    expect(enrollment(d1, seqId, c).status).toBe("active");

    // Now the appended step is due and goes out; nothing before it does.
    expect((await runSequenceTick(env, getSeq(d1, seqId), { nowSeconds: T0 + 10 })).released).toBe(1);
    expect(sendPositions(d1, seqId)).toEqual([1000, 2000, 3000]);
  });

  it("leaves mid-sequence contacts advancing without a release", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const c = insertContact(d1, "f@example.com");
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }, { wait_minutes: 0 }] });
    let seq = getSeq(d1, seqId);
    await enrollContacts(env, seq, [{ id: c, email: "f@example.com" }], "restart", T0);
    await runSequenceTick(env, seq, { nowSeconds: T0 }); // step 1, now mid-sequence

    // Append step 3, never released to completed contacts.
    d1.sql("INSERT INTO sequence_steps (sequence_id, position, wait_minutes) VALUES (?, 3000, 0)", seqId);
    seq = getSeq(d1, seqId);

    // The mid-sequence contact proceeds automatically: step 2, then the appended
    // step 3 - with no release confirmation anywhere.
    expect((await runSequenceTick(env, seq, { nowSeconds: T0 + 1 })).released).toBe(1);
    expect((await runSequenceTick(env, seq, { nowSeconds: T0 + 1 })).released).toBe(1);
    expect(sendPositions(d1, seqId)).toEqual([1000, 2000, 3000]);
    expect(enrollment(d1, seqId, c).status).toBe("completed");
  });
});

describe("mid-sequence insertion skips already-passed positions", () => {
  it("skips the inserted step for a contact who already passed it", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const app = makeApp(d1, env);
    const c = insertContact(d1, "g@example.com");
    const seqId = makeSequence(d1, {
      steps: [{ wait_minutes: 0 }, { wait_minutes: 0 }, { wait_minutes: 0 }],
    });
    let seq = getSeq(d1, seqId);
    await enrollContacts(env, seq, [{ id: c, email: "g@example.com" }], "restart", T0);
    await runSequenceTick(env, seq, { nowSeconds: T0 }); // pos 1000
    await runSequenceTick(env, seq, { nowSeconds: T0 }); // pos 2000
    expect(enrollment(d1, seqId, c).last_sent_position).toBe(2000);

    // Insert a new step between 1000 and 2000 (gap 1000 -> midpoint 1500).
    const r = await app.post(`/api/sequences/${seqId}/steps`, {
      after_position: 1000,
      name: "inserted",
      wait_minutes: 0,
    });
    expect(r.position).toBe(1500);

    seq = getSeq(d1, seqId);
    expect((await runSequenceTick(env, seq, { nowSeconds: T0 + 1 })).released).toBe(1);
    // The contact passed 1500, so only the final original step goes out.
    expect(sendPositions(d1, seqId)).toEqual([1000, 2000, 3000]);
  });

  it("renumbers (shifting sends and positions) when there is no gap", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const app = makeApp(d1, env);
    const c = insertContact(d1, "h@example.com");
    // Adjacent positions force the renumber fallback.
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }, { wait_minutes: 0 }, { wait_minutes: 0 }] });
    d1.sql("UPDATE sequence_steps SET position = 1 WHERE sequence_id=? AND position = 1000", seqId);
    d1.sql("UPDATE sequence_steps SET position = 2 WHERE sequence_id=? AND position = 2000", seqId);
    d1.sql("UPDATE sequence_steps SET position = 3 WHERE sequence_id=? AND position = 3000", seqId);

    let seq = getSeq(d1, seqId);
    await enrollContacts(env, seq, [{ id: c, email: "h@example.com" }], "restart", T0);
    await runSequenceTick(env, seq, { nowSeconds: T0 }); // position 1
    await runSequenceTick(env, seq, { nowSeconds: T0 }); // position 2
    expect(enrollment(d1, seqId, c).last_sent_position).toBe(2);

    const r = await app.post(`/api/sequences/${seqId}/steps`, { after_position: 1, wait_minutes: 0 });
    expect(r.inserted_mid).toBe(true); // 2..3 has a gap of 1 -> renumber fallback
    expect(r.position).toBe(2);
    // Nothing was lost: the passed step's send row and the enrolment's position
    // both shifted with the step, so the contact still "already passed" it.
    expect(sendPositions(d1, seqId)).toEqual([1, 3]);
    expect(enrollment(d1, seqId, c).last_sent_position).toBe(3);

    seq = getSeq(d1, seqId);
    await runSequenceTick(env, seq, { nowSeconds: T0 + 1 });
    // Position 4 (the old third step); the new position-2 step is skipped.
    expect(sendPositions(d1, seqId)).toEqual([1, 3, 4]);
  });
});

describe("re-enrolment: restart and resume", () => {
  it("restart clears progress and re-sends step 1, recorded in the events table", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const c = insertContact(d1, "i@example.com");
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }, { wait_minutes: 0 }] });
    const seq = getSeq(d1, seqId);
    await enrollContacts(env, seq, [{ id: c, email: "i@example.com" }], "restart", T0);
    await runSequenceTick(env, seq, { nowSeconds: T0 });
    expect(sendPositions(d1, seqId)).toEqual([1000]);

    const e = enrollment(d1, seqId, c);
    await reenroll(env, seq, e.id, "restart", T0 + DAY);
    const after = enrollment(d1, seqId, c);
    expect(after.last_sent_position).toBe(0);
    expect(after.restarts).toBe(1);
    expect(sendPositions(d1, seqId)).toEqual([]); // prior run's records cleared

    await runSequenceTick(env, seq, { nowSeconds: T0 + DAY });
    expect(sendPositions(d1, seqId)).toEqual([1000]);
    const ev = events(d1, seqId, "re-enrolled");
    expect(ev.length).toBe(1);
    expect(ev[0].detail).toContain("mode:restart");
  });

  it("resume keeps progress and continues at the next step", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const c = insertContact(d1, "j@example.com");
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }, { wait_minutes: 0 }] });
    const seq = getSeq(d1, seqId);
    await enrollContacts(env, seq, [{ id: c, email: "j@example.com" }], "restart", T0);
    await runSequenceTick(env, seq, { nowSeconds: T0 });

    // Stop the contact, then resume.
    d1.sql("UPDATE sequence_enrollments SET status='stopped', stop_reason='manual' WHERE sequence_id=? AND contact_id=?", seqId, c);
    const e = enrollment(d1, seqId, c);
    await reenroll(env, seq, e.id, "resume", T0 + DAY);
    const after = enrollment(d1, seqId, c);
    expect(after.status).toBe("active");
    expect(after.last_sent_position).toBe(1000); // progress kept

    await runSequenceTick(env, seq, { nowSeconds: T0 + DAY });
    expect(sendPositions(d1, seqId)).toEqual([1000, 2000]);
    expect(events(d1, seqId, "re-enrolled")[0].detail).toContain("mode:resume");
  });

  it("enrols a new contact once and supports removal", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const c = insertContact(d1, "k@example.com");
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }] });
    const seq = getSeq(d1, seqId);
    const first = await enrollContacts(env, seq, [{ id: c, email: "k@example.com" }], "restart", T0);
    expect(first.enrolled).toBe(1);
    const again = await enrollContacts(env, seq, [{ id: c, email: "k@example.com" }], "resume", T0);
    expect(again.reenrolled).toBe(1);

    const e = enrollment(d1, seqId, c);
    expect(await removeEnrollment(env, seqId, e.id)).toBe(true);
    expect(enrollment(d1, seqId, c).status).toBe("removed");
  });
});

describe("stop the whole sequence on unsubscribe and hard bounce", () => {
  it("stops on an unsubscribe webhook", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const app = makeApp(d1, env);
    const c = insertContact(d1, "u@example.com");
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }, { wait_minutes: 0 }] });
    const seq = getSeq(d1, seqId);
    await enrollContacts(env, seq, [{ id: c, email: "u@example.com" }], "restart", T0);
    await runSequenceTick(env, seq, { nowSeconds: T0 });

    const r = await app.post("/api/webhooks/smtp2go?token=tok", {
      event: "unsubscribe",
      email: "u@example.com",
    });
    expect(r.ok).toBe(true);
    const e = enrollment(d1, seqId, c);
    expect(e.status).toBe("stopped");
    expect(e.stop_reason).toBe("unsubscribe");
    expect(events(d1, seqId, "stopped").length).toBe(1);

    // No further steps go out.
    expect((await runSequenceTick(env, seq, { nowSeconds: T0 + DAY })).released).toBe(0);
  });

  it("stops on a hard bounce webhook (and only a hard one)", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const app = makeApp(d1, env);
    const c = insertContact(d1, "hb@example.com");
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }, { wait_minutes: 4320 }] });
    const seq = getSeq(d1, seqId);
    await enrollContacts(env, seq, [{ id: c, email: "hb@example.com" }], "restart", T0);
    await runSequenceTick(env, seq, { nowSeconds: T0 });

    // A soft bounce must NOT stop the sequence.
    await app.post("/api/webhooks/smtp2go?token=tok", {
      event: "bounce",
      bounce_type: "soft",
      email: "hb@example.com",
      email_id: "x1",
    });
    expect(enrollment(d1, seqId, c).status).toBe("active");

    await app.post("/api/webhooks/smtp2go?token=tok", {
      event: "bounce",
      bounce_type: "hard",
      email: "hb@example.com",
      email_id: "x2",
    });
    const e = enrollment(d1, seqId, c);
    expect(e.status).toBe("stopped");
    expect(e.stop_reason).toBe("bounce");
  });

  it("stopContactSequences halts every active sequence for a contact", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const c = insertContact(d1, "multi@example.com");
    const a = makeSequence(d1, { name: "A", steps: [{ wait_minutes: 0 }] });
    const b = makeSequence(d1, { name: "B", steps: [{ wait_minutes: 0 }] });
    await enrollContacts(env, getSeq(d1, a), [{ id: c, email: "multi@example.com" }], "restart", T0);
    await enrollContacts(env, getSeq(d1, b), [{ id: c, email: "multi@example.com" }], "restart", T0);

    expect(await stopContactSequences(env, { email: "multi@example.com" }, "unsubscribe", T0)).toBe(2);
    expect(enrollment(d1, a, c).status).toBe("stopped");
    expect(enrollment(d1, b, c).status).toBe("stopped");
  });
});

describe("local-time windowing", () => {
  it("uses the contact's own zone, falling back to the sequence zone", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const perth = insertContact(d1, "perth@example.com", { timezone: "Australia/Perth" });
    const sydney = insertContact(d1, "sydney@example.com", { timezone: "Australia/Sydney" });
    const fallback = insertContact(d1, "bne@example.com", { timezone: null });
    const seqId = makeSequence(d1, {
      steps: [{ wait_minutes: 0 }],
      send_time: "09:00",
      send_timezone: "Australia/Brisbane",
    });
    const seq = getSeq(d1, seqId);
    await enrollContacts(
      env,
      seq,
      [
        { id: perth, email: "perth@example.com" },
        { id: sydney, email: "sydney@example.com" },
        { id: fallback, email: "bne@example.com" },
      ],
      "restart",
      T0,
    );

    // 2026-10-07T23:10Z: Brisbane 09:10 (open), Perth 07:10 (closed),
    // Sydney 10:10 (open, DST).
    await runSequenceTick(env, getSeq(d1, seqId), { nowSeconds: at("2026-10-07T23:10:00Z") });
    const sent = d1
      .sql<{ email: string }>("SELECT email FROM sequence_sends WHERE sequence_id=? ORDER BY email", seqId)
      .map((r) => r.email);
    expect(sent).toEqual(["bne@example.com", "sydney@example.com"]);
    // The Perth contact is still waiting, not stopped.
    expect(enrollment(d1, seqId, perth).status).toBe("active");

    // At 01:10Z Perth is 09:10: now it goes out.
    await runSequenceTick(env, getSeq(d1, seqId), { nowSeconds: at("2026-10-08T01:10:00Z") });
    const sent2 = d1
      .sql<{ email: string }>("SELECT email FROM sequence_sends WHERE sequence_id=? ORDER BY email", seqId)
      .map((r) => r.email);
    expect(sent2).toEqual(["bne@example.com", "perth@example.com", "sydney@example.com"]);
  });
});

describe("sendable per the new blocklist", () => {
  it("sends to valid and unknown; pending/invalid/never-checked are skipped, not stopped", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const valid = insertContact(d1, "valid@example.com", { email_status: "valid" });
    const unknown = insertContact(d1, "unknown@example.com", { email_status: "unknown" });
    const pending = insertContact(d1, "pending@example.com", { email_status: "pending" });
    const invalid = insertContact(d1, "invalid@example.com", { email_status: "invalid" });
    const never = insertContact(d1, "never@example.com", { email_status: null });
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }] });
    const seq = getSeq(d1, seqId);
    await enrollContacts(
      env,
      seq,
      [valid, unknown, pending, invalid, never].map((id, i) => ({
        id,
        email: ["valid@example.com", "unknown@example.com", "pending@example.com", "invalid@example.com", "never@example.com"][i],
      })),
      "restart",
      T0,
    );

    await runSequenceTick(env, seq, { nowSeconds: T0 });
    const sent = d1
      .sql<{ email: string }>("SELECT email FROM sequence_sends WHERE sequence_id=? ORDER BY email", seqId)
      .map((r) => r.email);
    expect(sent).toEqual(["unknown@example.com", "valid@example.com"]);
    // Blocked-by-verification contacts are held, not stopped.
    expect(enrollment(d1, seqId, pending).status).toBe("active");
    expect(enrollment(d1, seqId, invalid).status).toBe("active");
  });

  it("stops a suppressed contact at dispatch time", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const c = insertContact(d1, "sup@example.com");
    d1.sql("INSERT INTO suppressions (email, reason) VALUES ('sup@example.com','manual')");
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }] });
    const seq = getSeq(d1, seqId);
    await enrollContacts(env, seq, [{ id: c, email: "sup@example.com" }], "restart", T0);
    expect((await runSequenceTick(env, seq, { nowSeconds: T0 })).released).toBe(0);
    expect(enrollment(d1, seqId, c).status).toBe("stopped");
    expect(enrollment(d1, seqId, c).stop_reason).toBe("suppressed");
  });
});

describe("caps and metrics", () => {
  it("respects the daily cap and resumes the next local day", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const a = insertContact(d1, "cap1@example.com");
    const b = insertContact(d1, "cap2@example.com");
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }], daily_cap: 1 });
    const seq = getSeq(d1, seqId);
    await enrollContacts(
      env,
      seq,
      [
        { id: a, email: "cap1@example.com" },
        { id: b, email: "cap2@example.com" },
      ],
      "restart",
      T0,
    );
    expect((await runSequenceTick(env, seq, { nowSeconds: T0 })).released).toBe(1);
    expect((await runSequenceTick(env, seq, { nowSeconds: T0 })).released).toBe(0); // cap spent
    expect((await runSequenceTick(env, seq, { nowSeconds: T0 + DAY })).released).toBe(1);
    expect(sendPositions(d1, seqId)).toEqual([1000, 1000]);
  });

  it("reports per-step metrics and a funnel across steps", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const c = insertContact(d1, "m@example.com");
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }, { wait_minutes: 0 }] });
    const seq = getSeq(d1, seqId);
    await enrollContacts(env, seq, [{ id: c, email: "m@example.com" }], "restart", T0);
    await runSequenceTick(env, seq, { nowSeconds: T0 });
    await runSequenceTick(env, seq, { nowSeconds: T0 + 1 });
    // Mark step 1 delivered/opened/clicked as the webhook would.
    d1.sql(
      "UPDATE sequence_sends SET delivered_at=1, opened_at=2, clicked_at=3 WHERE sequence_id=? AND step_position=1000",
      seqId,
    );
    const m = await sequenceMetrics(env, seq);
    expect(m.steps.map((s) => s.position)).toEqual([1000, 2000]);
    expect(m.steps[0].delivered).toBe(1);
    expect(m.steps[0].opened).toBe(1);
    expect(m.steps[0].clicked).toBe(1);
    expect(m.funnel).toEqual([
      { position: 1000, reached: 1 },
      { position: 2000, reached: 1 },
    ]);
  });
});

describe("test mode is isolated", () => {
  it("runs a whole sequence to one address without enrolments or metrics", async () => {
    const d1 = freshDb();
    const { env, jobs } = makeEnv(d1);
    d1.sql("INSERT INTO templates (source, name, subject, html) VALUES ('local','T','Hello','<p>Hi</p>')");
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }, { wait_minutes: 4320 }] });
    d1.sql("UPDATE sequence_steps SET template_id=1 WHERE sequence_id=?", seqId);
    const seq = getSeq(d1, seqId);

    const r = await runSequenceTest(env, seq, "owner@example.com", { compressMinutes: 1 });
    expect(r.queued).toBe(2);
    // Waits compressed to minutes: step 1 now, step 2 one minute later.
    expect(r.plan.map((p) => p.delay_seconds)).toEqual([0, 60]);
    expect(jobs.length).toBe(2);
    expect(jobs[0].opts?.delaySeconds).toBe(0);
    expect(jobs[1].opts?.delaySeconds).toBe(60);

    // Isolation: nothing in the real tables, only sequence_test_sends.
    expect(d1.sql("SELECT COUNT(*) AS n FROM sequence_enrollments")[0]).toMatchObject({ n: 0 });
    expect(d1.sql("SELECT COUNT(*) AS n FROM sequence_sends")[0]).toMatchObject({ n: 0 });
    expect(d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM sequence_test_sends")[0].n).toBe(2);

    // Consume the test jobs with a stubbed SMTP2GO: still no real rows.
    vi.stubGlobal(
      "fetch",
      (async () => new Response(JSON.stringify({ data: { email_id: "test-1" } }), { status: 200 })) as any,
    );
    const messages = jobs.map((j) => {
      const m: any = { body: j.body };
      m.ack = () => {};
      m.retry = () => {};
      return m;
    });
    await processSendBatch({ messages } as any, env);
    vi.unstubAllGlobals();

    expect(d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM sequence_sends")[0].n).toBe(0);
    expect(d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM sequence_enrollments")[0].n).toBe(0);
    const testSends = d1.sql<any>("SELECT * FROM sequence_test_sends ORDER BY step_position");
    expect(testSends.every((t) => t.smtp2go_id === "test-1")).toBe(true);
  });
});

describe("engine details", () => {
  it("computes next due from the previous send", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }, { wait_minutes: 90 }] });
    const steps = await loadSteps(env, seqId);
    expect(steps.map((s) => s.position)).toEqual([1000, 2000]);
    const next = nextStepAfter(steps, 1000)!;
    expect(nextDueAt(next, 1000, 0)).toBe(1000 + 90 * 60);
    // No previous send: measured from enrolment.
    expect(nextDueAt(steps[0], null, 500)).toBe(500);
  });

  it("records lifecycle events for enrol and complete", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const c = insertContact(d1, "ev@example.com");
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }] });
    const seq = getSeq(d1, seqId);
    await enrollContacts(env, seq, [{ id: c, email: "ev@example.com" }], "restart", T0);
    await runSequenceTick(env, seq, { nowSeconds: T0 });
    expect(events(d1, seqId, "enrolled").length).toBe(1);
    expect(events(d1, seqId, "completed").length).toBe(1);
  });
});
