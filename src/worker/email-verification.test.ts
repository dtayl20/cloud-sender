// Email verification (Bulk Email Checker): imports are marked pending without
// an inline API call, the 1-minute cron pass is capped and quota-aware, bad
// addresses are held back from sending, and repeat runs never re-check terminal
// statuses.
//
// Runs the real routes / pass against an in-memory SQLite database built from
// the real migration files (node:sqlite via the shared test shim). The BEC HTTP
// call is stubbed at `fetch`, so assertions are on what the code decided.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { Env } from "./types";
import { importsRoutes } from "./routes/imports";
import { enqueueCampaign } from "./routes/campaigns";
import { mapVerifyStatus, parseSignals, verifyPendingContacts } from "./emailVerify";
import {
  ALLOW_RISKY_SENDS,
  SEND_BLOCKED_EMAIL_STATUSES,
  SENDABLE_EMAIL_STATUSES,
  isSendBlocked,
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
  "0020_sequences.sql",
  "0021_sequence_timezone_backfill.sql",
];

const KEY = "k".repeat(32);

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

const seed = (d1: TestD1, email: string, email_status: string | null = "pending") =>
  d1.exec(
    email_status === null
      ? `INSERT INTO contacts (email) VALUES ('${email}')`
      : `INSERT INTO contacts (email, email_status) VALUES ('${email}','${email_status}')`,
  );

const statusOf = (d1: TestD1, email: string) =>
  d1.sql<{ email_status: string | null }>(
    "SELECT email_status FROM contacts WHERE email=?",
    email,
  )[0]?.email_status ?? null;

afterEach(() => vi.unstubAllGlobals());

describe("import marks contacts pending", () => {
  it("marks imported rows pending and never calls the verifier inline", async () => {
    const d1 = freshDb();
    const calls = stubBec(() => passed());
    const app = new Hono<{ Bindings: Env }>();
    app.route("/api/imports", importsRoutes);

    const res = await app.fetch(
      new Request("http://test/api/imports/csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: [{ email: "a@example.com" }, { email: "b@example.com" }],
          map: { email: "email" },
        }),
      }),
      makeEnv(d1),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toMatchObject({ inserted: 2 });

    expect(statusOf(d1, "a@example.com")).toBe("pending");
    expect(statusOf(d1, "b@example.com")).toBe("pending");
    expect(calls).toHaveLength(0);
  });

  it("does not reset an already-verified contact on re-import", async () => {
    const d1 = freshDb();
    seed(d1, "done@example.com", "valid");
    const app = new Hono<{ Bindings: Env }>();
    app.route("/api/imports", importsRoutes);

    await app.fetch(
      new Request("http://test/api/imports/csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: [{ email: "done@example.com" }],
          map: { email: "email" },
        }),
      }),
      makeEnv(d1),
    );
    expect(statusOf(d1, "done@example.com")).toBe("valid");
  });
});

describe("the cron pass", () => {
  it("checks at most 25 pending contacts per pass", async () => {
    const d1 = freshDb();
    for (let i = 0; i < 30; i++) seed(d1, `p${i}@example.com`);
    const calls = stubBec(() => passed());

    const result = await verifyPendingContacts(makeEnv(d1), { limit: 25 });

    expect(result.checked).toBe(25);
    expect(calls).toHaveLength(25);
    expect(result.remaining).toBe(5);
    expect(result.stopped).toBeNull();
  });

  it("sends the key and email form-encoded, one call per address", async () => {
    const d1 = freshDb();
    seed(d1, "solo@example.com");
    const calls = stubBec(() => passed());

    await verifyPendingContacts(makeEnv(d1), { limit: 25 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.bulkemailchecker.com/real-time/");
    const body = new URLSearchParams(calls[0].body);
    expect(body.get("key")).toBe(KEY);
    expect(body.get("email")).toBe("solo@example.com");
  });

  it("stops the pass when the API's hourly quota is spent", async () => {
    const d1 = freshDb();
    for (let i = 0; i < 10; i++) seed(d1, `q${i}@example.com`);
    const calls = stubBec(() => passed({ hourlyQuotaRemaining: 0 }));

    const result = await verifyPendingContacts(makeEnv(d1), { limit: 25 });

    expect(result.checked).toBe(1);
    expect(result.stopped).toBe("quota");
    expect(calls).toHaveLength(1); // never burns the rest of the selection
    expect(result.remaining).toBe(9);
  });

  it("stops the pass on a 429 instead of retrying", async () => {
    const d1 = freshDb();
    for (let i = 0; i < 10; i++) seed(d1, `r${i}@example.com`);
    const calls = stubBec(() => ({ ok: false, status: 429, json: async () => ({}) }));

    const result = await verifyPendingContacts(makeEnv(d1), { limit: 25 });

    expect(result.checked).toBe(0);
    expect(result.stopped).toBe("rate-limit");
    expect(calls).toHaveLength(1);
  });

  it("stops the pass on a 5xx instead of retrying", async () => {
    const d1 = freshDb();
    for (let i = 0; i < 10; i++) seed(d1, `e${i}@example.com`);
    const calls = stubBec(() => ({ ok: false, status: 503, json: async () => ({}) }));

    const result = await verifyPendingContacts(makeEnv(d1), { limit: 25 });

    expect(result.stopped).toBe("error");
    expect(calls).toHaveLength(1);
  });

  it("is a no-op when no API key is configured", async () => {
    const d1 = freshDb();
    seed(d1, "nokey@example.com");
    const calls = stubBec(() => passed());

    const result = await verifyPendingContacts(makeEnv(d1, { BULK_EMAIL_CHECKER_API: "" }));

    expect(result.stopped).toBe("no-key");
    expect(calls).toHaveLength(0);
    expect(statusOf(d1, "nokey@example.com")).toBe("pending");
  });

  it("never re-checks a terminal status", async () => {
    const d1 = freshDb();
    for (let i = 0; i < 3; i++) seed(d1, `t${i}@example.com`);
    const first = stubBec(() => passed());
    await verifyPendingContacts(makeEnv(d1), { limit: 25 });
    expect(first).toHaveLength(3);
    expect(statusOf(d1, "t0@example.com")).toBe("valid");

    const second = stubBec(() => passed());
    const result = await verifyPendingContacts(makeEnv(d1), { limit: 25 });
    expect(result.checked).toBe(0);
    expect(second).toHaveLength(0);
  });

  it("re-checks a stale unknown but leaves a pending-only pass alone otherwise", async () => {
    const d1 = freshDb();
    seed(d1, "unk@example.com", "unknown");
    d1.exec("UPDATE contacts SET email_verified_at = 1 WHERE email='unk@example.com'");
    const calls = stubBec(() => passed());

    await verifyPendingContacts(makeEnv(d1), { limit: 25, nowSeconds: 2_000_000_000 });

    expect(calls).toHaveLength(1);
    expect(statusOf(d1, "unk@example.com")).toBe("valid");
  });
});

describe("signal mapping", () => {
  it("maps disposable and gibberish to invalid", () => {
    expect(mapVerifyStatus(parseSignals({ status: "passed", isDisposable: true }))).toBe("invalid");
    expect(mapVerifyStatus(parseSignals({ status: "passed", isGibberish: true }))).toBe("invalid");
  });

  it("maps a pass to valid, a complainer to risky, and a fail to invalid", () => {
    expect(mapVerifyStatus(parseSignals({ status: "passed" }))).toBe("valid");
    expect(mapVerifyStatus(parseSignals({ status: "passed", isComplainer: true }))).toBe("risky");
    expect(mapVerifyStatus(parseSignals({ status: "failed" }))).toBe("invalid");
  });

  it("maps anything inconclusive to unknown rather than valid", () => {
    expect(mapVerifyStatus(parseSignals({ status: "unknown" }))).toBe("unknown");
    expect(mapVerifyStatus(parseSignals({}))).toBe("unknown");
  });

  it("keeps the single allowlist/blocklist constant as the source of truth", () => {
    // 'valid' and 'unknown' are sendable; risky is off by default (ALLOW_RISKY_SENDS).
    expect(ALLOW_RISKY_SENDS).toBe(false);
    expect(SENDABLE_EMAIL_STATUSES).toEqual(["valid", "unknown"]);
    expect(SEND_BLOCKED_EMAIL_STATUSES).toEqual(["pending", "risky", "invalid"]);
    expect(isSendBlocked("valid")).toBe(false);
    expect(isSendBlocked("unknown")).toBe(false); // 2026-10-08: unknown is now sendable
    expect(isSendBlocked("risky")).toBe(true); // off unless ALLOW_RISKY_SENDS
    expect(isSendBlocked("pending")).toBe(true);
    expect(isSendBlocked("invalid")).toBe(true);
    expect(isSendBlocked(null)).toBe(true); // never checked is not verified
    expect(isSendBlocked(undefined)).toBe(true);
  });
});

describe("sending holds back unverified and bad addresses", () => {
  it("sends only to 'valid' and 'unknown' — pending, invalid, risky and never-checked are held back", async () => {
    const d1 = freshDb();
    seed(d1, "valid@example.com", "valid");
    seed(d1, "null@example.com", null);
    seed(d1, "pending@example.com", "pending");
    seed(d1, "invalid@example.com", "invalid");
    seed(d1, "unknown@example.com", "unknown");
    seed(d1, "risky@example.com", "risky");

    d1.exec(
      "INSERT INTO templates (source, name, subject, html) VALUES ('local','T','S','<p>x</p>')",
    );
    d1.exec(
      "INSERT INTO campaigns (name, template_id, from_email, status) VALUES ('C', 1, 'from@localdentists.au','draft')",
    );
    const queued = await enqueueCampaign(makeEnv(d1), 1);

    expect(queued).toBe(2);
    const emails = d1
      .sql<{ email: string }>("SELECT email FROM sends ORDER BY email")
      .map((r) => r.email);
    expect(emails).toEqual(["unknown@example.com", "valid@example.com"]);
  });

  it("a verified-as-disposable import is never sent to", async () => {
    const d1 = freshDb();
    seed(d1, "good@example.com");
    seed(d1, "throwaway@example.com");
    // The verifier answers per address: good passes, throwaway is disposable.
    vi.stubGlobal("fetch", (async (_url: unknown, init: any) => {
      const email = new URLSearchParams(String(init.body)).get("email");
      return passed(email === "throwaway@example.com" ? { isDisposable: true } : {});
    }) as any);

    await verifyPendingContacts(makeEnv(d1), { limit: 25 });
    expect(statusOf(d1, "throwaway@example.com")).toBe("invalid");
    expect(statusOf(d1, "good@example.com")).toBe("valid");

    d1.exec(
      "INSERT INTO templates (source, name, subject, html) VALUES ('local','T','S','<p>x</p>')",
    );
    d1.exec(
      "INSERT INTO campaigns (name, template_id, from_email, status) VALUES ('C', 1, 'from@localdentists.au','draft')",
    );
    const queued = await enqueueCampaign(makeEnv(d1), 1);
    expect(queued).toBe(1);
    expect(
      d1.sql<{ email: string }>("SELECT email FROM sends").map((r) => r.email),
    ).toEqual(["good@example.com"]);
  });
});
