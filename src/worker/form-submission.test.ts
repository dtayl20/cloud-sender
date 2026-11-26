// Form-submission webhook: token auth, idempotency, verify-on-submit (success
// and API-failure fallback), suppressed addresses, the form_slug -> sequence
// mapping, restart on a repeat submit, and capture-and-hold with release on
// activation.
//
// Runs the real route + handler against an in-memory SQLite database built from
// the real migration files. The Bulk Email Checker HTTP call is stubbed at
// `fetch`; every instant is explicit where timing is asserted.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { Env, SendJob } from "./types";
import { webhooksRoutes } from "./webhooks";
import { sequencesRoutes } from "./routes/sequences";
import { dispatchSequences, enrollContacts, releaseHeldEnrollments, runSequenceTick, type SequenceRow } from "./sequences";
import { handleFormSubmission, loadFormSequenceMap, normalizeFormSequenceMap, validateFormSubmission } from "./formSubmission";

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
  "0022_form_submission.sql",
];

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const T0 = at("2026-10-08T00:00:00Z");
const HOUR = 3600;

function freshDb(): TestD1 {
  const d1 = createTestD1();
  applyMigrations(d1, MIGRATIONS);
  return d1;
}

function makeEnv(d1: TestD1): { env: Env; jobs: { body: SendJob }[] } {
  const jobs: { body: SendJob }[] = [];
  const env = {
    DB: d1,
    BULK_EMAIL_CHECKER_API: "k".repeat(32),
    SEND_QUEUE: {
      send: async (body: SendJob) => jobs.push({ body }),
      sendBatch: async () => {},
    },
    SEND_TIMEZONE: "Australia/Brisbane",
    DEFAULT_FROM_EMAIL: "from@localdentists.au",
    DEFAULT_FROM_NAME: "LocalDentists.au",
    WEBHOOK_TOKEN: "tok",
  } as unknown as Env;
  return { env, jobs };
}

function stubBec(respond: () => any) {
  const calls: { url: string; body: string }[] = [];
  vi.stubGlobal("fetch", (async (url: unknown, init: any) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return respond();
  }) as any);
  return calls;
}

const passed = (over: Record<string, unknown> = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    status: "passed",
    event: "mailbox_exists",
    isDisposable: false,
    isGibberish: false,
    creditsRemaining: 19_999,
    hourlyQuotaRemaining: 1475,
    ...over,
  }),
});

const invalidPayload = () => ({
  ok: true,
  status: 200,
  json: async () => ({ status: "failed", event: "invalid", isDisposable: true }),
});

function makeApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/webhooks", webhooksRoutes);
  app.route("/api/sequences", sequencesRoutes);
  return {
    post: (path: string, b?: unknown) =>
      app.fetch(new Request(`http://test${path}`, { method: "POST", body: JSON.stringify(b ?? {}) }), env),
    postJson: async (path: string, b?: unknown) =>
      (await app.fetch(new Request(`http://test${path}`, { method: "POST", body: JSON.stringify(b ?? {}) }), env)).json() as any,
  };
}

function submission(over: Partial<Record<string, unknown>> = {}) {
  return {
    form_slug: "contact-us",
    submission_id: "sub-1",
    email: "lead@example.com",
    first_name: "Ada",
    last_name: "Lovelace",
    phone: "0400 000 000",
    consent: { accepted: true, text: "I agree to be contacted.", at: "2026-10-08T00:00:00Z" },
    fields: { state: "VIC" },
    ...over,
  };
}

function makeSequence(
  d1: TestD1,
  opts: { status?: string; steps?: { wait_minutes?: number }[]; name?: string } = {},
): number {
  d1.sql(
    "INSERT INTO sequences (name, status, from_email) VALUES (?,?,?)",
    opts.name ?? "Seq",
    opts.status ?? "active",
    "from@localdentists.au",
  );
  const id = Number(d1.sql<{ id: number }>("SELECT id FROM sequences ORDER BY id DESC LIMIT 1")[0].id);
  let pos = 0;
  for (const s of opts.steps ?? [{ wait_minutes: 0 }]) {
    pos += 1000;
    d1.sql("INSERT INTO sequence_steps (sequence_id, position, wait_minutes) VALUES (?,?,?)", id, pos, s.wait_minutes ?? 0);
  }
  return id;
}

function setMapping(d1: TestD1, map: Record<string, number>): void {
  d1.sql(
    "INSERT INTO settings (key, value) VALUES ('form_sequence_map', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    JSON.stringify(map),
  );
}

const contactRow = (d1: TestD1, email: string) =>
  d1.sql<any>("SELECT * FROM contacts WHERE email=?", email)[0];
const enrollmentRow = (d1: TestD1, seqId: number, contactId: number) =>
  d1.sql<any>("SELECT * FROM sequence_enrollments WHERE sequence_id=? AND contact_id=?", seqId, contactId)[0];
const seqRow = (d1: TestD1, id: number): SequenceRow => d1.sql<SequenceRow>("SELECT * FROM sequences WHERE id=?", id)[0];

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------

describe("token auth", () => {
  it("rejects a submission with no/incorrect token", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const app = makeApp(env);
    const res = await app.post("/api/webhooks/form-submission", submission());
    expect(res.status).toBe(403);
    // Nothing was recorded.
    expect(d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM form_submissions")[0].n).toBe(0);
  });
});

describe("idempotency (same submission_id twice)", () => {
  it("verifies and enrols once and returns ok on the repeat", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const calls = stubBec(() => passed());
    const app = makeApp(env);
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }] });
    setMapping(d1, { "contact-us": seqId });

    const first = await app.postJson("/api/webhooks/form-submission?token=tok", submission());
    expect(first.ok).toBe(true);
    expect(first.duplicate).toBe(false);
    expect(first.enrolled).toBe(true);
    expect(first.verify_credits_spent).toBe(1);

    const second = await app.postJson("/api/webhooks/form-submission?token=tok", submission());
    expect(second.ok).toBe(true);
    expect(second.duplicate).toBe(true);

    // Exactly one verify, one submission row, one enrolment, one contact.
    expect(calls.length).toBe(1);
    expect(d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM form_submissions")[0].n).toBe(1);
    expect(d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM sequence_enrollments")[0].n).toBe(1);
    expect(d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM contacts")[0].n).toBe(1);
  });
});

describe("verify on submit", () => {
  it("checks the address inline and records the result + one credit", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const calls = stubBec(() => passed());
    const app = makeApp(env);
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }] });
    setMapping(d1, { "contact-us": seqId });

    const r = await app.postJson("/api/webhooks/form-submission?token=tok", submission());
    expect(r.email_status).toBe("valid");
    expect(r.verify_credits_spent).toBe(1);
    expect(calls.length).toBe(1);
    const c = contactRow(d1, "lead@example.com");
    expect(c.email_status).toBe("valid");
    expect(c.email_verified_at).toBeTruthy();
    expect(c.source).toBe("form");
    expect(c.first_name).toBe("Ada");
    expect(c.last_name).toBe("Lovelace");
    // phone + consent live in the attributes JSON.
    const attrs = JSON.parse(c.attributes);
    expect(attrs.phone).toBe("0400 000 000");
    expect(attrs.consent.text).toBe("I agree to be contacted.");
    // timezone derived from fields.state = VIC.
    expect(c.timezone).toBe("Australia/Melbourne");
  });

  it("derives the timezone from a postcode when no state is present", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    stubBec(() => passed());
    const app = makeApp(env);
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }] });
    setMapping(d1, { "contact-us": seqId });

    await app.postJson(
      "/api/webhooks/form-submission?token=tok",
      submission({ email: "qld@example.com", submission_id: "pc-1", fields: { postcode: "4000" } }),
    );
    expect(contactRow(d1, "qld@example.com").timezone).toBe("Australia/Brisbane");
  });

  it("falls back to a queued 'pending' address when the API errors, keeping the lead", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    stubBec(() => ({ ok: false, status: 503, json: async () => ({}) }));
    const app = makeApp(env);
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }] });
    setMapping(d1, { "contact-us": seqId });

    const r = await app.postJson("/api/webhooks/form-submission?token=tok", submission());
    expect(r.ok).toBe(true);
    expect(r.enrolled).toBe(true); // captured, not lost
    expect(r.reason).toContain("verify_api_error");
    const c = contactRow(d1, "lead@example.com");
    expect(c.email_status).toBe("pending");
    expect(Number(c.email_verify_queued)).toBe(1);
  });
});

describe("suppressed addresses", () => {
  it("refuses to verify or enrol a suppressed address", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const calls = stubBec(() => passed());
    const app = makeApp(env);
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }] });
    setMapping(d1, { "contact-us": seqId });
    d1.sql("INSERT INTO suppressions (email, reason) VALUES ('lead@example.com','unsubscribe')");

    const r = await app.postJson("/api/webhooks/form-submission?token=tok", submission());
    expect(r.status).toBe("suppressed");
    expect(r.reason).toContain("suppressed");
    expect(r.enrolled).toBe(false);
    expect(calls.length).toBe(0); // never spent a credit
    expect(d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM sequence_enrollments")[0].n).toBe(0);
    expect(d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM form_submissions")[0].n).toBe(1);
  });
});

describe("unmapped form_slug", () => {
  it("records the submission but does not enrol", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    stubBec(() => passed());
    const app = makeApp(env);
    // No mapping set at all.

    const r = await app.postJson("/api/webhooks/form-submission?token=tok", submission());
    expect(r.status).toBe("unmapped");
    expect(r.reason).toContain("no sequence mapped");
    expect(r.enrolled).toBe(false);
    expect(d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM contacts")[0].n).toBe(1); // contact still captured
    expect(d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM sequence_enrollments")[0].n).toBe(0);
  });
});

describe("verification failure is captured but not enrolled", () => {
  it("records an invalid address without enrolling it", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    stubBec(() => invalidPayload());
    const app = makeApp(env);
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }] });
    setMapping(d1, { "contact-us": seqId });

    const r = await app.postJson("/api/webhooks/form-submission?token=tok", submission());
    expect(r.status).toBe("not_enrolled");
    expect(r.reason).toContain("verification:invalid");
    expect(r.enrolled).toBe(false);
    expect(contactRow(d1, "lead@example.com").email_status).toBe("invalid");
    expect(d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM sequence_enrollments")[0].n).toBe(0);
  });
});

describe("restart on a repeat submit", () => {
  it("restarts the sequence for the same address under a new submission_id", async () => {
    const d1 = freshDb();
    const { env, jobs } = makeEnv(d1);
    stubBec(() => passed());
    const app = makeApp(env);
    const seqId = makeSequence(d1, { steps: [{ wait_minutes: 0 }, { wait_minutes: 0 }] });
    setMapping(d1, { "contact-us": seqId });

    await app.postJson("/api/webhooks/form-submission?token=tok", submission({ submission_id: "a" }));
    const seq = seqRow(d1, seqId);
    const contactId = Number(contactRow(d1, "lead@example.com").id);
    // The enrolment anchors on the real clock; tick at that instant so step 1
    // (wait 0) is due regardless of when the test runs.
    const enrolledAt = Number(enrollmentRow(d1, seqId, contactId).enrolled_at);
    await runSequenceTick(env, seq, { nowSeconds: enrolledAt }); // step 1 goes out
    expect(d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM sequence_sends")[0].n).toBe(1);

    const again = await app.postJson("/api/webhooks/form-submission?token=tok", submission({ submission_id: "b" }));
    expect(again.enrolled).toBe(true);
    const e = enrollmentRow(d1, seqId, contactId);
    expect(Number(e.restarts)).toBe(1);
    expect(Number(e.last_sent_position)).toBe(0); // progress reset
    // The prior run's send rows were cleared so step 1 can go out again.
    expect(d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM sequence_sends")[0].n).toBe(0);
    expect(jobs.length).toBe(1);
    const ev = d1.sql<{ detail: string }>("SELECT detail FROM sequence_events WHERE type='re-enrolled'");
    expect(ev[0].detail).toContain("mode:restart");
  });
});

describe("capture and hold, then release on activation", () => {
  it("holds a draft enrolment with no clock and sends nothing while held", async () => {
    const d1 = freshDb();
    const { env, jobs } = makeEnv(d1);
    stubBec(() => passed());
    const app = makeApp(env);
    const seqId = makeSequence(d1, { status: "draft", steps: [{ wait_minutes: 60 }] });
    setMapping(d1, { "contact-us": seqId });

    const r = await app.postJson("/api/webhooks/form-submission?token=tok", submission());
    expect(r.status).toBe("held");
    expect(r.held).toBe(true);
    expect(r.reason).toContain("captured_and_held");

    const contactId = Number(contactRow(d1, "lead@example.com").id);
    const e = enrollmentRow(d1, seqId, contactId);
    expect(e.status).toBe("active");
    expect(e.next_due_at).toBeNull(); // captured, clock not started

    // The dispatcher never runs a draft, and even a direct tick releases nothing
    // while the due time is NULL.
    expect((await runSequenceTick(env, seqRow(d1, seqId), { nowSeconds: T0 })).released).toBe(0);
    await dispatchSequences(env, T0);
    expect(jobs.length).toBe(0);
    expect(d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM sequence_sends")[0].n).toBe(0);
  });

  it("starts the clock on activation and releases the held contact", async () => {
    const d1 = freshDb();
    const { env, jobs } = makeEnv(d1);
    stubBec(() => passed());
    const app = makeApp(env);
    const seqId = makeSequence(d1, { status: "draft", steps: [{ wait_minutes: 60 }] });
    setMapping(d1, { "contact-us": seqId });

    await app.postJson("/api/webhooks/form-submission?token=tok", submission());
    const contactId = Number(contactRow(d1, "lead@example.com").id);

    // Activate through the real route: the held enrolment is released.
    const res = await app.postJson(`/api/sequences/${seqId}/status`, { status: "active" });
    expect(res.ok).toBe(true);
    expect(res.released_held).toBe(1);

    const e = enrollmentRow(d1, seqId, contactId);
    expect(e.next_due_at).not.toBeNull();
    // The wait begins at activation: due - enrolled == step 1's wait (60 min).
    expect(Number(e.next_due_at) - Number(e.enrolled_at)).toBe(60 * 60);

    // At the activation instant nothing is due yet...
    expect((await runSequenceTick(env, seqRow(d1, seqId), { nowSeconds: Number(e.enrolled_at) })).released).toBe(0);
    // ...and exactly one wait later, step 1 goes out.
    expect(
      (await runSequenceTick(env, seqRow(d1, seqId), { nowSeconds: Number(e.next_due_at) })).released,
    ).toBe(1);
    expect(jobs.length).toBe(1);
  });

  it("leaves a mid-sequence contact's clock untouched on activation", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const seqId = makeSequence(d1, { status: "draft", steps: [{ wait_minutes: 0 }, { wait_minutes: 60 }] });
    // Seed an ACTIVE, non-held enrolment (a non-NULL due) as if it were already
    // mid-sequence; activation must not reset it.
    d1.sql("INSERT INTO contacts (email, status, email_status) VALUES ('mid@example.com','active','valid')");
    const contactId = Number(d1.sql<{ id: number }>("SELECT id FROM contacts WHERE email='mid@example.com'")[0].id);
    d1.sql(
      "INSERT INTO sequence_enrollments (sequence_id, contact_id, email, status, enrolled_at, last_sent_position, last_sent_at, next_due_at) VALUES (?,?,?,'active',?,1000,?,?)",
      seqId,
      contactId,
      "mid@example.com",
      T0,
      T0,
      T0 + 60 * 60,
    );

    const released = await releaseHeldEnrollments(env, seqRow(d1, seqId), T0 + 9999);
    expect(released).toBe(0);
    const e = enrollmentRow(d1, seqId, contactId);
    expect(Number(e.enrolled_at)).toBe(T0); // unchanged
    expect(Number(e.next_due_at)).toBe(T0 + 60 * 60); // unchanged
  });
});

describe("mapping helpers", () => {
  it("normalises an object or an array mapping, ignoring junk", () => {
    expect(normalizeFormSequenceMap('{"a":3,"b":"4","c":0,"d":null}')).toEqual({ a: 3, b: 4 });
    expect(normalizeFormSequenceMap([{ form_slug: "x", sequence_id: 7 }, { slug: "y", sequenceId: "8" }])).toEqual({ x: 7, y: 8 });
    expect(normalizeFormSequenceMap("not json")).toEqual({});
  });

  it("rejects a payload missing the required keys", () => {
    expect(validateFormSubmission({ email: "x@y.com" }).ok).toBe(false);
    expect(validateFormSubmission(submission()).ok).toBe(true);
  });
});
