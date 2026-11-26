// Sender identities + the sending-domain HARD RULE.
//
// The owner's rule: a From address must be on a verified SMTP2Go sending domain.
// It is refused when an identity is saved, and enforced again at send time -
// including the exact mismatch case (an identity bound to one domain but
// sending from another). Runs against the real routes + consumer on an
// in-memory SQLite built from the real migrations; the SMTP2Go HTTP call is
// stubbed at `fetch`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ALL_MIGRATIONS, applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { Env, SendJob } from "./types";
import { senderIdentitiesRoutes } from "./routes/senderIdentities";
import { sequencesRoutes } from "./routes/sequences";
import { campaignsRoutes } from "./routes/campaigns";
import { processSendBatch } from "./consumer";
import { fromEmailDomain, refreshVerifiedDomains, sendDomainViolation, senderDomainRecord, snapshotFromRecords } from "./senderDomain";

function freshDb(): TestD1 {
  const d1 = createTestD1();
  applyMigrations(d1, ALL_MIGRATIONS);
  return d1;
}

function jsonResp(body: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as any;
}

/** Stub the SMTP2Go API: domain list + email send. */
function stubSmtp2go(opts: { domains?: unknown[] } = {}) {
  const state = { domainCalls: 0, sends: [] as any[] };
  vi.stubGlobal(
    "fetch",
    (async (url: unknown, init: any) => {
      const u = String(url);
      if (u.includes("/domain")) {
        state.domainCalls++;
        return jsonResp({ data: { results: opts.domains ?? [] } });
      }
      if (u.includes("/email/send")) {
        state.sends.push(init?.body ? JSON.parse(String(init.body)) : {});
        return jsonResp({ request_id: "req-1", data: { succeeded: 1, email_id: "msg-1" } });
      }
      return jsonResp({});
    }) as any,
  );
  return state;
}

function makeEnv(d1: TestD1) {
  const jobs: { body: SendJob }[] = [];
  const env = {
    DB: d1,
    SMTP2GO_API_KEY: "test-key",
    SEND_QUEUE: {
      send: async (body: SendJob) => jobs.push({ body }),
      sendBatch: async () => {},
    },
    SEND_TIMEZONE: "Australia/Brisbane",
    DEFAULT_FROM_EMAIL: "listing@localdentists.au",
    DEFAULT_FROM_NAME: "LocalDentists.au",
    WEBHOOK_TOKEN: "tok",
  } as unknown as Env;
  return { env, jobs };
}

function makeApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/sender-identities", senderIdentitiesRoutes);
  app.route("/api/sequences", sequencesRoutes);
  app.route("/api/campaigns", campaignsRoutes);
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await app.fetch(
      new Request(`http://test${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
      env,
    );
    return { status: r.status, json: (await r.json()) as any };
  };
  return {
    post: (p: string, b?: unknown) => call("POST", p, b),
    patch: (p: string, b?: unknown) => call("PATCH", p, b),
    get: (p: string) => call("GET", p),
  };
}

const VERIFIED_LD = { domain: { fulldomain: "localdentists.au", dkim_verified: true, rpath_verified: true } };

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------

describe("domain-rule helpers", () => {
  it("reduces a nested SMTP2Go record to a verified domain", () => {
    const rec = senderDomainRecord(VERIFIED_LD)!;
    expect(rec.domain).toBe("localdentists.au");
    expect(rec.verified).toBe(true);
  });

  it("treats an unverified record as not verified", () => {
    const rec = senderDomainRecord({ domain: { fulldomain: "example.com", dkim_verified: false, rpath_verified: false } })!;
    expect(rec.verified).toBe(false);
  });

  it("extracts the domain of a from address", () => {
    expect(fromEmailDomain("Name <a@LocalDentists.au>")).toBe("localdentists.au");
    expect(fromEmailDomain("not-an-email")).toBeNull();
  });

  it("flags a mismatch between an identity's bound domain and the from address", () => {
    const snapshot = snapshotFromRecords([senderDomainRecord(VERIFIED_LD)!], 0);
    const v = sendDomainViolation({
      fromEmail: "something@localdentists.au",
      identityName: "Example",
      identityDomain: "example.com",
      identityEnabled: true,
      snapshot,
    });
    expect(v).toMatch(/bound to example\.com/);
  });
});

describe("identity save validation (fail closed)", () => {
  it("refuses a from-address whose domain is not an SMTP2Go sending domain", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    stubSmtp2go({ domains: [VERIFIED_LD] });
    const app = makeApp(env);

    const r = await app.post("/api/sender-identities", {
      name: "Wrong",
      from_email: "hello@example.com",
    });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toMatch(/not a sending domain/i);
    // Nothing was written.
    expect(d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM sender_identities")[0].n).toBe(0);
  });

  it("refuses a from-address on a domain that is listed but unverified", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    stubSmtp2go({
      domains: [{ domain: { fulldomain: "example.com", dkim_verified: false, rpath_verified: false } }],
    });
    const app = makeApp(env);
    const r = await app.post("/api/sender-identities", {
      name: "Pending",
      from_email: "hello@example.com",
    });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toMatch(/not verified/i);
  });

  it("accepts a from-address on a verified domain and binds the domain", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    stubSmtp2go({ domains: [VERIFIED_LD] });
    const app = makeApp(env);
    const r = await app.post("/api/sender-identities", {
      name: "LocalDentists",
      from_name: "LocalDentists.au",
      from_email: "listing@localdentists.au",
      is_default: true,
    });
    expect(r.status).toBe(200);
    expect(r.json.row.sending_domain).toBe("localdentists.au");
    expect(Number(r.json.row.is_default)).toBe(1);
  });
});

describe("send-time enforcement", () => {
  it("blocks a sequence send when the identity's from domain and bound domain disagree", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const fetchState = stubSmtp2go({ domains: [VERIFIED_LD] });
    const app = makeApp(env);

    // Create a genuine, verified identity...
    const created = await app.post("/api/sender-identities", {
      name: "Peak",
      from_email: "listing@localdentists.au",
    });
    const identityId = Number(created.json.row.id);
    // ...then make it MISMATCHED (bound to one domain while sending from
    // localdentists.au) - the exact case the owner named.
    d1.sql("UPDATE sender_identities SET sending_domain='example.com' WHERE id=?", identityId);

    // A sequence that picks it, with a queued step send.
    d1.sql("INSERT INTO sequences (name, status, from_email, sender_identity_id) VALUES ('S','active','legacy@localdentists.au',?)", identityId);
    const seqId = Number(d1.sql<{ id: number }>("SELECT id FROM sequences ORDER BY id DESC LIMIT 1")[0].id);
    d1.sql("INSERT INTO sequence_steps (sequence_id, position, content_html, subject) VALUES (?,?,?,?)", seqId, 1000, "<p>hi</p>", "Hello");
    const stepId = Number(d1.sql<{ id: number }>("SELECT id FROM sequence_steps ORDER BY id DESC LIMIT 1")[0].id);
    d1.sql("INSERT INTO contacts (email, status, email_status) VALUES ('c@example.com','active','valid')");
    const contactId = Number(d1.sql<{ id: number }>("SELECT id FROM contacts WHERE email='c@example.com'")[0].id);
    d1.sql(
      "INSERT INTO sequence_enrollments (sequence_id, contact_id, email, status, enrolled_at, last_sent_position, last_sent_at) VALUES (?,?,?,'active',1,1000,1)",
      seqId,
      contactId,
      "c@example.com",
    );
    const eid = Number(d1.sql<{ id: number }>("SELECT id FROM sequence_enrollments ORDER BY id DESC LIMIT 1")[0].id);
    d1.sql(
      "INSERT INTO sequence_sends (sequence_id, enrollment_id, step_id, step_position, contact_id, email, status) VALUES (?,?,?,?,?,?, 'queued')",
      seqId,
      eid,
      stepId,
      1000,
      contactId,
      "c@example.com",
    );
    const sendId = Number(d1.sql<{ id: number }>("SELECT id FROM sequence_sends ORDER BY id DESC LIMIT 1")[0].id);

    const sendsBefore = fetchState.sends.length;
    const messages = [
      {
        body: { sequence_id: seqId, sequence_send_id: sendId, contact_id: contactId, email: "c@example.com" } as SendJob,
        ack: vi.fn(),
        retry: vi.fn(),
      },
    ];
    await processSendBatch({ messages } as any, env);

    const row = d1.sql<{ status: string; error: string }>("SELECT status, error FROM sequence_sends WHERE id=?", sendId)[0];
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/^sender_domain:/);
    expect(fetchState.sends.length).toBe(sendsBefore); // nothing left the Worker
  });

  it("blocks a campaign send when the from domain is not in the synced verified set", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const fetchState = stubSmtp2go({ domains: [VERIFIED_LD] });

    // Sync the verified set (localdentists.au only).
    await refreshVerifiedDomains(env);

    // A local template so the send path reaches the domain check.
    d1.sql("INSERT INTO templates (source, name, subject, html) VALUES ('local','T','Hi','<p>hi</p>')");
    const templateId = Number(d1.sql<{ id: number }>("SELECT id FROM templates ORDER BY id DESC LIMIT 1")[0].id);
    d1.sql("INSERT INTO campaigns (name, status, from_email, template_id) VALUES ('C','sending','someone@other-domain.test',?)", templateId);
    const campaignId = Number(d1.sql<{ id: number }>("SELECT id FROM campaigns ORDER BY id DESC LIMIT 1")[0].id);
    d1.sql("INSERT INTO contacts (email, status, email_status) VALUES ('d@example.com','active','valid')");
    const contactId = Number(d1.sql<{ id: number }>("SELECT id FROM contacts WHERE email='d@example.com'")[0].id);
    d1.sql("INSERT INTO sends (campaign_id, contact_id, email, status) VALUES (?,?,?,'queued')", campaignId, contactId, "d@example.com");
    const sendId = Number(d1.sql<{ id: number }>("SELECT id FROM sends ORDER BY id DESC LIMIT 1")[0].id);

    const sendsBefore = fetchState.sends.length;
    const messages = [
      { body: { campaign_id: campaignId, send_id: sendId, contact_id: contactId, email: "d@example.com" } as SendJob, ack: vi.fn(), retry: vi.fn() },
    ];
    await processSendBatch({ messages } as any, env);

    const row = d1.sql<{ status: string; error: string }>("SELECT status, error FROM sends WHERE id=?", sendId)[0];
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/^sender_domain:/);
    expect(fetchState.sends.length).toBe(sendsBefore);
  });

  it("allows a send whose from domain IS verified", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const fetchState = stubSmtp2go({ domains: [VERIFIED_LD] });
    await refreshVerifiedDomains(env);

    d1.sql("INSERT INTO templates (source, name, subject, html) VALUES ('local','T','Hi','<p>hi</p>')");
    const templateId = Number(d1.sql<{ id: number }>("SELECT id FROM templates ORDER BY id DESC LIMIT 1")[0].id);
    d1.sql("INSERT INTO campaigns (name, status, from_email, template_id) VALUES ('C','sending','listing@localdentists.au',?)", templateId);
    const campaignId = Number(d1.sql<{ id: number }>("SELECT id FROM campaigns ORDER BY id DESC LIMIT 1")[0].id);
    d1.sql("INSERT INTO contacts (email, status, email_status) VALUES ('e@example.com','active','valid')");
    const contactId = Number(d1.sql<{ id: number }>("SELECT id FROM contacts WHERE email='e@example.com'")[0].id);
    d1.sql("INSERT INTO sends (campaign_id, contact_id, email, status) VALUES (?,?,?,'queued')", campaignId, contactId, "e@example.com");
    const sendId = Number(d1.sql<{ id: number }>("SELECT id FROM sends ORDER BY id DESC LIMIT 1")[0].id);

    const messages = [
      { body: { campaign_id: campaignId, send_id: sendId, contact_id: contactId, email: "e@example.com" } as SendJob, ack: vi.fn(), retry: vi.fn() },
    ];
    await processSendBatch({ messages } as any, env);

    const row = d1.sql<{ status: string }>("SELECT status FROM sends WHERE id=?", sendId)[0];
    expect(row.status).toBe("sent");
    expect(fetchState.sends.length).toBe(1);
  });
});

describe("sync-domains", () => {
  it("reads and caches the verified set", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    stubSmtp2go({
      domains: [VERIFIED_LD, { domain: { fulldomain: "example.com", dkim_verified: false, rpath_verified: false } }],
    });
    const app = makeApp(env);
    const r = await app.post("/api/sender-identities/sync-domains");
    expect(r.status).toBe(200);
    expect(r.json.domains).toEqual(["localdentists.au"]);
    const stored = d1.sql<{ value: string }>("SELECT value FROM settings WHERE key='smtp2go_verified_domains'");
    expect(stored.length).toBe(1);
  });
});
