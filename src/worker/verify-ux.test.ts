// Verification UX: the explicit bulk-verify action, the last-verified date /
// counts, and the re-verify cadence (stale "valid" addresses).
//
// Same harness as email-verification.test.ts: the real routes and the real pass
// against an in-memory SQLite database built from the real migration files, with
// the Bulk Email Checker HTTP call stubbed at `fetch` so assertions are on what
// the code decided - and, crucially, on whether it called the API at all.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { Env } from "./types";
import { contactsRoutes } from "./routes/contacts";
import { VERIFY_PER_PASS, VERIFY_STALE_PER_PASS, verifyPendingContacts } from "./emailVerify";
import {
  DEFAULT_STALE_DAYS,
  SEND_BLOCKED_EMAIL_STATUSES,
  SENDABLE_EMAIL_STATUSES,
  STALE_DAYS_SETTING_KEY,
  isSendBlocked,
  normalizeStaleDays,
  staleBeforeSeconds,
} from "../shared/emailStatus";

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
];

const KEY = "k".repeat(32);
const NOW = 2_000_000_000; // fixed "now" so staleness is deterministic
const DAY = 86_400;

function freshDb(): TestD1 {
  const d1 = createTestD1();
  applyMigrations(d1, MIGRATIONS);
  return d1;
}

function makeEnv(d1: TestD1, overrides: Partial<Env> = {}): Env {
  return {
    DB: d1,
    BULK_EMAIL_CHECKER_API: KEY,
    DEFAULT_FROM_EMAIL: "listing@localdentists.au",
    SEND_QUEUE: { sendBatch: async () => {} },
    ...overrides,
  } as unknown as Env;
}

function app(d1: TestD1): Hono<{ Bindings: Env }> {
  const a = new Hono<{ Bindings: Env }>();
  a.route("/api/contacts", contactsRoutes);
  return a;
}

/** Stub `fetch` to record BEC calls and answer with `respond()`. */
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

function seed(d1: TestD1, email: string, email_status: string | null = "pending") {
  d1.exec(
    email_status === null
      ? `INSERT INTO contacts (email) VALUES ('${email}')`
      : `INSERT INTO contacts (email, email_status) VALUES ('${email}','${email_status}')`,
  );
}

/** `email_verified_at` is unix seconds; `agoDays` before NOW. */
function setVerifiedAt(d1: TestD1, email: string, agoDays: number) {
  d1.exec(
    `UPDATE contacts SET email_verified_at = ${NOW - agoDays * DAY} WHERE email='${email}'`,
  );
}

// Route handlers (bulk verify, stats) use the real clock, not the test's NOW, so
// staleness for those tests has to be aged off Date.now().
function setVerifiedDaysAgoReal(d1: TestD1, email: string, days: number) {
  const at = Math.floor(Date.now() / 1000) - days * DAY;
  d1.exec(`UPDATE contacts SET email_verified_at = ${at} WHERE email='${email}'`);
}

function setSetting(d1: TestD1, key: string, value: unknown) {
  d1.exec(`INSERT INTO settings (key, value) VALUES ('${key}', '${JSON.stringify(value)}')`);
}

const statusOf = (d1: TestD1, email: string) =>
  d1.sql<{ email_status: string | null }>("SELECT email_status FROM contacts WHERE email=?", email)[0]
    ?.email_status ?? null;

const queuedOf = (d1: TestD1, email: string) =>
  Number(
    d1.sql<{ email_verify_queued: number }>(
      "SELECT email_verify_queued FROM contacts WHERE email=?",
      email,
    )[0]?.email_verify_queued ?? 0,
  );

async function postVerify(d1: TestD1, body: unknown) {
  return app(d1).fetch(
    new Request("http://test/api/contacts/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    makeEnv(d1),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("bulk verify queues without calling the API", () => {
  it("flags every pending row and makes zero API calls", async () => {
    const d1 = freshDb();
    seed(d1, "a@example.com");
    seed(d1, "b@example.com");
    seed(d1, "valid@example.com", "valid");
    const calls = stubBec(() => passed());

    const res = await postVerify(d1, { scope: "pending" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.queued).toBe(2);
    expect(calls).toHaveLength(0);

    expect(queuedOf(d1, "a@example.com")).toBe(1);
    expect(queuedOf(d1, "b@example.com")).toBe(1);
    expect(queuedOf(d1, "valid@example.com")).toBe(0);
    // The status is untouched until the pass has a fresh answer.
    expect(statusOf(d1, "a@example.com")).toBe("pending");
  });

  it("dry_run reports the counts and queues nothing", async () => {
    const d1 = freshDb();
    seed(d1, "a@example.com");
    seed(d1, "b@example.com");
    const calls = stubBec(() => passed());

    const body = (await (await postVerify(d1, { scope: "pending", dry_run: true })).json()) as any;
    expect(body.dry_run).toBe(true);
    expect(body.matched).toBe(2);
    expect(body.eligible).toBe(2);
    expect(body.queued).toBe(0);
    expect(calls).toHaveLength(0);
    expect(queuedOf(d1, "a@example.com")).toBe(0);
  });

  it("skips a fresh valid in a filter/selection, so it is never re-checked", async () => {
    const d1 = freshDb();
    seed(d1, "fresh@example.com", "valid");
    setVerifiedDaysAgoReal(d1, "fresh@example.com", 1);
    seed(d1, "stale@example.com", "valid");
    setVerifiedDaysAgoReal(d1, "stale@example.com", 200);
    const calls = stubBec(() => passed());

    const body = (await (
      await postVerify(d1, { scope: "filter", filter_query: "email_status=valid" })
    ).json()) as any;
    expect(calls).toHaveLength(0);
    expect(body.matched).toBe(2);
    expect(body.eligible).toBe(1);
    expect(body.skipped).toBe(1);
    expect(queuedOf(d1, "fresh@example.com")).toBe(0);
    expect(queuedOf(d1, "stale@example.com")).toBe(1);
  });

  it("stale scope queues only the stale valids", async () => {
    const d1 = freshDb();
    seed(d1, "fresh@example.com", "valid");
    setVerifiedDaysAgoReal(d1, "fresh@example.com", 1);
    seed(d1, "stale@example.com", "valid");
    setVerifiedDaysAgoReal(d1, "stale@example.com", 200);
    stubBec(() => passed());

    const body = (await (await postVerify(d1, { scope: "stale" })).json()) as any;
    expect(body.matched).toBe(1);
    expect(body.queued).toBe(1);
    expect(queuedOf(d1, "fresh@example.com")).toBe(0);
    expect(queuedOf(d1, "stale@example.com")).toBe(1);
  });

  it("ids scope queues an explicit selection", async () => {
    const d1 = freshDb();
    seed(d1, "one@example.com");
    seed(d1, "two@example.com");
    stubBec(() => passed());
    const id = d1.sql<{ id: number }>("SELECT id FROM contacts WHERE email='two@example.com'")[0].id;

    const body = (await (await postVerify(d1, { scope: "ids", ids: [id] })).json()) as any;
    expect(body.queued).toBe(1);
    expect(queuedOf(d1, "one@example.com")).toBe(0);
    expect(queuedOf(d1, "two@example.com")).toBe(1);
  });
});

describe("the pass honours the queue, the cap and the quota", () => {
  it("checks at most VERIFY_PER_PASS rows and leaves the rest", async () => {
    const d1 = freshDb();
    for (let i = 0; i < 30; i++) seed(d1, `p${i}@example.com`);
    const calls = stubBec(() => passed());

    const result = await verifyPendingContacts(makeEnv(d1), { limit: VERIFY_PER_PASS, nowSeconds: NOW });

    expect(result.checked).toBe(20);
    expect(calls).toHaveLength(20);
    expect(result.remaining).toBe(10);
    expect(result.stopped).toBeNull();
  });

  it("checks explicitly-queued rows first", async () => {
    const d1 = freshDb();
    for (let i = 0; i < 30; i++) seed(d1, `p${i}@example.com`);
    seed(d1, "queued@example.com", "valid");
    setVerifiedAt(d1, "queued@example.com", 400);
    d1.exec("UPDATE contacts SET email_verify_queued = 1 WHERE email='queued@example.com'");
    const calls = stubBec(() => passed());

    await verifyPendingContacts(makeEnv(d1), { limit: VERIFY_PER_PASS, nowSeconds: NOW });

    const firstEmail = new URLSearchParams(calls[0].body).get("email");
    expect(firstEmail).toBe("queued@example.com");
    expect(queuedOf(d1, "queued@example.com")).toBe(0); // cleared once checked
  });

  it("stops the pass when the API's hourly quota is spent", async () => {
    const d1 = freshDb();
    for (let i = 0; i < 10; i++) seed(d1, `q${i}@example.com`);
    const calls = stubBec(() => passed({ hourlyQuotaRemaining: 0 }));

    const result = await verifyPendingContacts(makeEnv(d1), { limit: 25, nowSeconds: NOW });

    expect(result.checked).toBe(1);
    expect(result.stopped).toBe("quota");
    expect(calls).toHaveLength(1);
    expect(result.remaining).toBe(9);
  });

  it("remembers the credits the API reported", async () => {
    const d1 = freshDb();
    seed(d1, "one@example.com");
    stubBec(() => passed({ creditsRemaining: 12_345 }));

    const result = await verifyPendingContacts(makeEnv(d1), { limit: 25, nowSeconds: NOW });

    expect(result.creditsRemaining).toBe(12_345);
    const stored = d1.sql<{ value: string }>(
      "SELECT value FROM settings WHERE key='email_verify_credits_remaining'",
    )[0]?.value;
    expect(JSON.parse(stored)).toBe(12_345);
  });
});

describe("re-verify cadence", () => {
  it("defaults to 180 days and never selects a fresh valid", async () => {
    const d1 = freshDb();
    seed(d1, "fresh@example.com", "valid");
    setVerifiedAt(d1, "fresh@example.com", 30); // well inside the cadence
    const calls = stubBec(() => passed());

    const result = await verifyPendingContacts(makeEnv(d1), { limit: 25, nowSeconds: NOW });

    expect(result.staleDays).toBe(DEFAULT_STALE_DAYS);
    expect(result.checked).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("picks up a stale valid, at the low stale rate, only when nothing is pending", async () => {
    const d1 = freshDb();
    seed(d1, "stale@example.com", "valid");
    setVerifiedAt(d1, "stale@example.com", 200);
    const calls = stubBec(() => passed());

    const result = await verifyPendingContacts(makeEnv(d1), { limit: 25, nowSeconds: NOW });

    expect(result.checked).toBe(1);
    expect(calls).toHaveLength(1);
    expect(new URLSearchParams(calls[0].body).get("email")).toBe("stale@example.com");
    expect(statusOf(d1, "stale@example.com")).toBe("valid");
  });

  it("never sweeps stale while a pending backlog larger than the cap remains", async () => {
    const d1 = freshDb();
    for (let i = 0; i < 30; i++) seed(d1, `p${i}@example.com`);
    seed(d1, "stale@example.com", "valid");
    setVerifiedAt(d1, "stale@example.com", 400);
    const calls = stubBec(() => passed());

    const result = await verifyPendingContacts(makeEnv(d1), { limit: 25, nowSeconds: NOW });

    // The 25/min budget went to the never-checked backlog; the stale valid -
    // which is not urgent - was never selected.
    expect(result.checked).toBe(25);
    expect(calls).toHaveLength(25);
    const emails = calls.map((c) => new URLSearchParams(c.body).get("email"));
    expect(emails).not.toContain("stale@example.com");
    expect(statusOf(d1, "stale@example.com")).toBe("valid");
  });

  it("honours the age setting: a 40-day-old valid is stale at 30 days, fresh at 180", async () => {
    const d1 = freshDb();
    seed(d1, "old@example.com", "valid");
    setVerifiedAt(d1, "old@example.com", 40);
    stubBec(() => passed());

    // Default 180 days: 40 days is fresh -> not selected.
    const fresh = await verifyPendingContacts(makeEnv(d1), { limit: 25, nowSeconds: NOW });
    expect(fresh.checked).toBe(0);

    // Cadence shortened to 30 days via settings: now it is stale.
    setSetting(d1, STALE_DAYS_SETTING_KEY, 30);
    const calls = stubBec(() => passed());
    const stale = await verifyPendingContacts(makeEnv(d1), { limit: 25, nowSeconds: NOW });
    expect(stale.staleDays).toBe(30);
    expect(stale.checked).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("caps the automatic stale sweep at VERIFY_STALE_PER_PASS", async () => {
    const d1 = freshDb();
    for (let i = 0; i < 5; i++) {
      seed(d1, `s${i}@example.com`, "valid");
      setVerifiedAt(d1, `s${i}@example.com`, 400);
    }
    const calls = stubBec(() => passed());

    const result = await verifyPendingContacts(makeEnv(d1), { limit: 25, nowSeconds: NOW });

    expect(result.checked).toBe(VERIFY_STALE_PER_PASS);
    expect(calls).toHaveLength(VERIFY_STALE_PER_PASS);
  });
});

describe("counts", () => {
  it("reports pending / valid / invalid / stale / queued and the cadence", async () => {
    const d1 = freshDb();
    seed(d1, "p@example.com", "pending");
    seed(d1, "v@example.com", "valid");
    setVerifiedDaysAgoReal(d1, "v@example.com", 1);
    seed(d1, "i@example.com", "invalid");
    seed(d1, "s@example.com", "valid");
    setVerifiedDaysAgoReal(d1, "s@example.com", 400);
    d1.exec("UPDATE contacts SET email_verify_queued = 1 WHERE email='p@example.com'");

    const res = await app(d1).fetch(new Request("http://test/api/contacts/stats"), makeEnv(d1));
    const body = (await res.json()) as any;

    expect(body.pending ?? 0).toBe(0); // not a top-level field
    const byStatus = Object.fromEntries(
      (body.verification as any[]).map((r) => [r.email_status, Number(r.n)]),
    );
    expect(byStatus.pending).toBe(1);
    expect(byStatus.valid).toBe(2);
    expect(byStatus.invalid).toBe(1);
    expect(body.stale).toBe(1);
    expect(body.queued).toBe(1);
    expect(body.stale_days).toBe(DEFAULT_STALE_DAYS);
  });
});

describe("blocklist behaviour after the 2026-10-08 unknown change", () => {
  it("keeps the allowlist/blocklist constant as the source of truth", () => {
    expect(SENDABLE_EMAIL_STATUSES).toEqual(["valid", "unknown"]);
    expect(SEND_BLOCKED_EMAIL_STATUSES).toEqual(["pending", "risky", "invalid"]);
    expect(isSendBlocked("valid")).toBe(false);
    expect(isSendBlocked("risky")).toBe(true);
    expect(isSendBlocked("pending")).toBe(true);
    expect(isSendBlocked("unknown")).toBe(false); // now sendable
    expect(isSendBlocked("invalid")).toBe(true);
    expect(isSendBlocked(null)).toBe(true);
  });

  it("keeps a freshly-queued stale valid sendable while it waits its turn", () => {
    const d1 = freshDb();
    seed(d1, "stale@example.com", "valid");
    setVerifiedAt(d1, "stale@example.com", 400);
    d1.exec("UPDATE contacts SET email_verify_queued = 1 WHERE email='stale@example.com'");
    // Queueing does not change the status, so the send rule still sees 'valid'.
    expect(statusOf(d1, "stale@example.com")).toBe("valid");
    expect(isSendBlocked(statusOf(d1, "stale@example.com"))).toBe(false);
  });

  it("normalises a bad cadence back to a sane value", () => {
    expect(normalizeStaleDays(undefined)).toBe(DEFAULT_STALE_DAYS);
    expect(normalizeStaleDays("abc")).toBe(DEFAULT_STALE_DAYS);
    expect(normalizeStaleDays(0)).toBe(1);
    expect(normalizeStaleDays(99999)).toBe(3650);
    expect(staleBeforeSeconds(NOW, 180)).toBe(NOW - 180 * DAY);
  });
});
