// Single-flight lock + pause switch + headroom for the Bulk Email Checker pass.
//
// Bulk Email Checker allows ONE concurrent connection. verifyPendingContacts
// runs from the 1-minute cron and is sequential *within* a pass, but a pass that
// outlives its tick (slow responses / retries / a long queue) used to overlap
// the next tick and open a second connection. These tests pin the fix:
// the atomic lease (compare-and-set on `verify_lock`), the pause switch, the
// reduced batch constant, and stop-now on any limit/concurrency signal.
//
// The BEC HTTP call is stubbed at `fetch`; the DB is the real migration set on
// in-memory SQLite, so the lock is exercised against real SQL.

import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { Env } from "./types";
import {
  VERIFY_LOCK_STALE_SECONDS,
  VERIFY_PER_PASS,
  acquireVerifyLease,
  releaseVerifyLease,
  verifyPendingContacts,
} from "./emailVerify";
import { VERIFY_PAUSED_SETTING_KEY } from "../shared/emailStatus";

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
const NOW = 2_000_000_000;

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

const seed = (d1: TestD1, email: string, email_status: string | null = "pending") =>
  d1.exec(
    email_status === null
      ? `INSERT INTO contacts (email) VALUES ('${email}')`
      : `INSERT INTO contacts (email, email_status) VALUES ('${email}','${email_status}')`,
  );

const seedMany = (d1: TestD1, n: number) => {
  for (let i = 0; i < n; i++) seed(d1, `p${i}@example.com`);
};

/** Plant a lease row (simulating a pass already in flight, or a crashed one). */
const plantLease = (d1: TestD1, owner: string, startedAt: number) =>
  d1.exec(`INSERT INTO verify_lock (id, owner, started_at) VALUES (1, '${owner}', ${startedAt})`);

const lockRows = (d1: TestD1) =>
  d1.sql<{ owner: string; started_at: number }>("SELECT owner, started_at FROM verify_lock");

const setSetting = (d1: TestD1, key: string, value: unknown) =>
  d1.exec(`INSERT INTO settings (key, value) VALUES ('${key}', '${JSON.stringify(value)}')`);

afterEach(() => vi.unstubAllGlobals());

describe("single-flight lease (compare-and-set)", () => {
  it("claims a free lease, refuses a second claim, and reclaims only when stale", async () => {
    const d1 = freshDb();
    const env = makeEnv(d1);

    const first = await acquireVerifyLease(env, NOW);
    expect(first.acquired).toBe(true);

    // A second pass a moment later must NOT also acquire: exactly one wins.
    const second = await acquireVerifyLease(env, NOW + 1);
    expect(second.acquired).toBe(false);
    expect(second.heldBy).toBe(first.owner);

    // Still held just before the stale timeout.
    const justBefore = await acquireVerifyLease(env, NOW + VERIFY_LOCK_STALE_SECONDS - 1);
    expect(justBefore.acquired).toBe(false);

    // Past the stale timeout the abandoned lease may be reclaimed.
    const afterStale = await acquireVerifyLease(env, NOW + VERIFY_LOCK_STALE_SECONDS + 1);
    expect(afterStale.acquired).toBe(true);
    expect(afterStale.owner).not.toBe(first.owner);
  });

  it("releases only for the owner, so a late holder cannot drop a reclaimed lease", async () => {
    const d1 = freshDb();
    const env = makeEnv(d1);
    const a = await acquireVerifyLease(env, NOW);
    // b reclaims after a goes stale.
    const b = await acquireVerifyLease(env, NOW + VERIFY_LOCK_STALE_SECONDS + 1);
    expect(b.acquired).toBe(true);

    // a's cleanup must be a no-op now that b owns the lease.
    await releaseVerifyLease(env, a.owner);
    expect(lockRows(d1).map((r) => r.owner)).toEqual([b.owner]);

    await releaseVerifyLease(env, b.owner);
    expect(lockRows(d1)).toHaveLength(0);
  });
});

describe("a second pass cannot start while a lease is held", () => {
  it("skips the tick entirely and never touches the API", async () => {
    const d1 = freshDb();
    seedMany(d1, 5);
    plantLease(d1, "other-pass", NOW); // a live lease, younger than the timeout
    const calls = stubBec(() => passed());

    const result = await verifyPendingContacts(makeEnv(d1), { nowSeconds: NOW });

    expect(result.checked).toBe(0);
    expect(result.stopped).toBe("lease-held");
    expect(result.skipped).toBe(true);
    expect(calls).toHaveLength(0); // the core regression: no second connection
    // The other pass's lease is untouched.
    expect(lockRows(d1).map((r) => r.owner)).toEqual(["other-pass"]);
  });

  it("reclaims an expired lease and runs", async () => {
    const d1 = freshDb();
    seedMany(d1, 3);
    plantLease(d1, "crashed-pass", NOW - VERIFY_LOCK_STALE_SECONDS - 10);
    const calls = stubBec(() => passed());

    const result = await verifyPendingContacts(makeEnv(d1), { nowSeconds: NOW });

    expect(result.checked).toBe(3);
    expect(calls).toHaveLength(3);
    expect(result.skipped).toBeUndefined();
    expect(lockRows(d1)).toHaveLength(0); // released in finally
  });
});

describe("lease lifecycle", () => {
  it("releases the lease after a successful pass", async () => {
    const d1 = freshDb();
    seed(d1, "one@example.com");
    stubBec(() => passed());

    await verifyPendingContacts(makeEnv(d1), { nowSeconds: NOW });

    expect(lockRows(d1)).toHaveLength(0);
  });

  it("releases the lease when the pass body throws", async () => {
    const d1 = freshDb();
    seed(d1, "boom@example.com");
    stubBec(() => passed());

    // A DB that throws once the pass tries to write a result, i.e. mid-pass.
    const throwingDb = {
      prepare: (sql: string) => {
        if (sql.includes("UPDATE contacts")) throw new Error("boom");
        return d1.prepare(sql);
      },
    } as unknown as Env["DB"];

    await expect(
      verifyPendingContacts(makeEnv(d1, { DB: throwingDb }), { nowSeconds: NOW }),
    ).rejects.toThrow("boom");

    // finally must have run: a crash cannot wedge the lock forever.
    expect(lockRows(d1)).toHaveLength(0);
  });
});

describe("limit / concurrency signals stop the pass now", () => {
  it("aborts immediately on a 429 and releases the lease", async () => {
    const d1 = freshDb();
    seedMany(d1, 10);
    const calls = stubBec(() => ({ ok: false, status: 429, json: async () => ({}) }));

    const result = await verifyPendingContacts(makeEnv(d1), { nowSeconds: NOW });

    expect(result.checked).toBe(0);
    expect(result.stopped).toBe("rate-limit");
    expect(calls).toHaveLength(1); // no retry inside the pass
    expect(lockRows(d1)).toHaveLength(0);
  });

  it("aborts immediately on a 5xx and releases the lease", async () => {
    const d1 = freshDb();
    seedMany(d1, 10);
    const calls = stubBec(() => ({ ok: false, status: 503, json: async () => ({}) }));

    const result = await verifyPendingContacts(makeEnv(d1), { nowSeconds: NOW });

    expect(result.checked).toBe(0);
    expect(result.stopped).toBe("error");
    expect(calls).toHaveLength(1);
    expect(lockRows(d1)).toHaveLength(0);
  });

  it("treats a 200 body naming a concurrency problem as stop-now", async () => {
    const d1 = freshDb();
    seedMany(d1, 10);
    const calls = stubBec(() => ({
      ok: true,
      status: 200,
      json: async () => ({ error: "Only one concurrent connection is allowed" }),
    }));

    const result = await verifyPendingContacts(makeEnv(d1), { nowSeconds: NOW });

    expect(result.checked).toBe(0);
    expect(result.stopped).toBe("concurrency");
    expect(calls).toHaveLength(1);
    expect(lockRows(d1)).toHaveLength(0);
  });
});

describe("pause switch", () => {
  it("is a no-op when the VERIFY_PAUSED env flag is on", async () => {
    const d1 = freshDb();
    seedMany(d1, 5);
    const calls = stubBec(() => passed());

    const result = await verifyPendingContacts(makeEnv(d1, { VERIFY_PAUSED: "true" }), {
      nowSeconds: NOW,
    });

    expect(result.checked).toBe(0);
    expect(result.stopped).toBe("paused");
    expect(result.skipped).toBe(true);
    expect(calls).toHaveLength(0);
    expect(lockRows(d1)).toHaveLength(0); // a paused pass takes nothing
  });

  it("is a no-op when the email_verify_paused settings key is on", async () => {
    const d1 = freshDb();
    seedMany(d1, 5);
    setSetting(d1, VERIFY_PAUSED_SETTING_KEY, true);
    const calls = stubBec(() => passed());

    const result = await verifyPendingContacts(makeEnv(d1), { nowSeconds: NOW });

    expect(result.stopped).toBe("paused");
    expect(calls).toHaveLength(0);
  });

  it("runs normally when the flag is off or unset", async () => {
    const d1 = freshDb();
    seed(d1, "run@example.com");
    setSetting(d1, VERIFY_PAUSED_SETTING_KEY, false);
    const calls = stubBec(() => passed());

    const result = await verifyPendingContacts(makeEnv(d1, { VERIFY_PAUSED: "false" }), {
      nowSeconds: NOW,
    });

    expect(result.checked).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe("headroom", () => {
  it("checks at most VERIFY_PER_PASS (20) by default", async () => {
    expect(VERIFY_PER_PASS).toBe(20);
    const d1 = freshDb();
    seedMany(d1, 30);
    const calls = stubBec(() => passed());

    const result = await verifyPendingContacts(makeEnv(d1), { nowSeconds: NOW });

    expect(result.checked).toBe(20);
    expect(calls).toHaveLength(20);
    expect(result.remaining).toBe(10);
  });
});
