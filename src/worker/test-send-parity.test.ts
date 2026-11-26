// A test send must send exactly what production sends.
//
// The bug: POST /:id/test passed only `to`, `sender`, `subject` and the body --
// no `custom_headers` and no reply address -- so a test arrived with no Reply-To
// header even when the campaign had one, and no X-Campaign-ID. That is exactly
// what a test send exists to reveal, so both paths now build their envelope from
// worker/sendPayload.ts and these tests pin the parity.
//
// Reply-To is delivered via `custom_headers` (verified on the wire 2026-09-23:
// a top-level `reply_to` is accepted with a 200 but never appears on the
// message), so the payload carries no top-level `reply_to` at all.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { ContactRow, Env, SendJob } from "./types";
import { campaignsRoutes } from "./routes/campaigns";
import { processSendBatch } from "./consumer";
import { customHeaders, replyToHeader, senderLine } from "./sendPayload";

const FRESH = [
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

const REPLY_TO = "hello@localdentists.au";
const SUBJECT = "what we measured on {{practice_name}}'s website";

function freshDb(): TestD1 {
  const d1 = createTestD1();
  applyMigrations(d1, FRESH);
  d1.exec(
    `INSERT INTO templates (source, name, subject, html, text, is_base)
     VALUES ('local', 'Outreach', 'Update for {{practice_name}}', '<p>Hi {{first_name}}</p>', 'Hi {{first_name}}', 0)`,
  );
  return d1;
}

function templateId(d1: TestD1): number {
  return d1.sql<{ id: number }>("SELECT id FROM templates WHERE name='Outreach'")[0].id;
}

function addContact(d1: TestD1, email: string): number {
  const r = d1.sql<{ id: number }>(
    `INSERT INTO contacts (email, first_name, practice_name, status, source, email_status)
     VALUES (?, 'Alex', 'Riverside Dental', 'active', 'seed', 'valid') RETURNING id`,
    email,
  );
  return r[0].id;
}

function addCampaign(
  d1: TestD1,
  opts: { replyTo?: string | null; subject?: string | null } = {},
): number {
  const r = d1.sql<{ id: number }>(
    `INSERT INTO campaigns (name, template_id, from_email, from_name, status, reply_to, subject)
     VALUES ('Clinic outreach', ?, 'listing@localdentists.au', 'LocalDentists.au', 'draft', ?, ?) RETURNING id`,
    templateId(d1),
    opts.replyTo === undefined ? REPLY_TO : opts.replyTo,
    opts.subject === undefined ? SUBJECT : opts.subject,
  );
  return r[0].id;
}

function addSend(d1: TestD1, campaignId: number, contactId: number, email: string): number {
  const r = d1.sql<{ id: number }>(
    `INSERT INTO sends (campaign_id, contact_id, email, status) VALUES (?, ?, ?, 'queued') RETURNING id`,
    campaignId,
    contactId,
    email,
  );
  return r[0].id;
}

/** Capture the SMTP2GO call a path makes; nothing leaves the test. */
function stubSmtp() {
  const calls: any[] = [];
  vi.stubGlobal("fetch", async (url: unknown, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ request_id: "req-1", data: { succeeded: 1, email_id: "email-1" } }),
    };
  });
  return calls;
}

function makeApp(d1: TestD1) {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/campaigns", campaignsRoutes);
  const env = {
    DB: d1,
    SMTP2GO_API_KEY: "test-key",
    DEFAULT_FROM_EMAIL: "listing@localdentists.au",
  } as unknown as Env;
  const call = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://test${path}`, init), env);
  const post = async (path: string, body: unknown) =>
    (await call(path, { method: "POST", body: JSON.stringify(body) })).json() as any;
  return { env, call, post };
}

/** The smallest queue batch the consumer accepts. */
function batchOf(jobs: SendJob[]) {
  return {
    queue: "send-queue",
    messages: jobs.map((body) => ({ body, ack: () => {}, retry: () => {} })),
    ackAll: () => {},
    retryAll: () => {},
  } as unknown as MessageBatch<SendJob>;
}

const cidHeader = (payload: any) =>
  (payload.custom_headers ?? []).find((h: any) => h.header === "X-Campaign-ID")?.value;
const replyHeader = (payload: any) =>
  (payload.custom_headers ?? []).find((h: any) => h.header === "Reply-To")?.value;
const headerNames = (payload: any) =>
  (payload.custom_headers ?? []).map((h: any) => h.header).sort();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the shared envelope builder", () => {
  it("formats the sender line with and without a name", () => {
    expect(senderLine("LocalDentists.au", "listing@localdentists.au")).toBe(
      "LocalDentists.au <listing@localdentists.au>",
    );
    expect(senderLine("", "listing@localdentists.au")).toBe("listing@localdentists.au");
    expect(senderLine(null, "listing@localdentists.au")).toBe("listing@localdentists.au");
  });

  it("never turns an unset reply address into a header", () => {
    expect(replyToHeader(null)).toBeUndefined();
    expect(replyToHeader(undefined)).toBeUndefined();
    expect(replyToHeader("")).toBeUndefined();
    expect(replyToHeader("   ")).toBeUndefined();
    expect(replyToHeader("  hello@x.com ")).toBe("hello@x.com");
  });

  it("puts Reply-To in custom_headers, never as an empty one", () => {
    expect(customHeaders({ campaignId: 7, sendId: null, replyTo: REPLY_TO })).toEqual([
      { header: "X-Campaign-ID", value: "7" },
      { header: "Reply-To", value: REPLY_TO },
    ]);
    expect(customHeaders({ campaignId: 7, sendId: null, replyTo: "" })).toEqual([
      { header: "X-Campaign-ID", value: "7" },
    ]);
    expect(customHeaders({ campaignId: 7, sendId: 99, replyTo: null })).toEqual([
      { header: "X-Campaign-ID", value: "7" },
      { header: "X-Send-ID", value: "99" },
    ]);
  });
});

describe("the test send carries production's headers", () => {
  it("adds the campaign's Reply-To and the campaign header", async () => {
    const d1 = freshDb();
    const contactId = addContact(d1, "riverside@example.com");
    const campaignId = addCampaign(d1);
    const calls = stubSmtp();
    const app = makeApp(d1);

    const res = await app.post(`/api/campaigns/${campaignId}/test`, {
      to: ["test@example.com"],
      contact_id: contactId,
    });

    expect(res.results[0].ok).toBe(true);
    expect(calls).toHaveLength(1);
    const payload = calls[0].body;
    expect(replyHeader(payload)).toBe(REPLY_TO);
    expect(cidHeader(payload)).toBe(String(campaignId));
    expect(payload.sender).toBe("LocalDentists.au <listing@localdentists.au>");
    // The resolved subject, not the template's.
    expect(payload.subject).toBe("what we measured on Riverside Dental's website");
    // The dead top-level field is gone: it is ignored by SMTP2GO, so leaving it
    // in invites the same false confidence the bug created.
    expect("reply_to" in payload).toBe(false);
  });

  it("sends no Reply-To header at all when the campaign has none", async () => {
    const d1 = freshDb();
    const contactId = addContact(d1, "riverside@example.com");
    const campaignId = addCampaign(d1, { replyTo: null });
    const calls = stubSmtp();
    const app = makeApp(d1);

    await app.post(`/api/campaigns/${campaignId}/test`, {
      to: ["test@example.com"],
      contact_id: contactId,
    });

    expect(calls[0].body.custom_headers).toEqual([
      { header: "X-Campaign-ID", value: String(campaignId) },
    ]);
    expect(headerNames(calls[0].body)).not.toContain("Reply-To");
  });

  it("sends no Reply-To header when the reply address is blank", async () => {
    const d1 = freshDb();
    const contactId = addContact(d1, "riverside@example.com");
    const campaignId = addCampaign(d1, { replyTo: "   " });
    const calls = stubSmtp();
    const app = makeApp(d1);

    await app.post(`/api/campaigns/${campaignId}/test`, {
      to: ["test@example.com"],
      contact_id: contactId,
    });

    expect(headerNames(calls[0].body)).not.toContain("Reply-To");
  });
});

describe("a test send and a production send build the same envelope", () => {
  it("matches header for header (bar the send id only production has)", async () => {
    const d1 = freshDb();
    const contactId = addContact(d1, "riverside@example.com");
    const campaignId = addCampaign(d1);
    const sendId = addSend(d1, campaignId, contactId, "riverside@example.com");
    const app = makeApp(d1);

    // 1. The test send.
    const testCalls = stubSmtp();
    await app.post(`/api/campaigns/${campaignId}/test`, {
      to: ["test@example.com"],
      contact_id: contactId,
    });
    const testPayload = testCalls[0].body;

    // 2. The production path, same campaign and same contact.
    const prodCalls = stubSmtp();
    await processSendBatch(
      batchOf([
        { campaign_id: campaignId, send_id: sendId, contact_id: contactId, email: "riverside@example.com" },
      ]),
      app.env,
    );
    const prodPayload = prodCalls[0].body;

    expect(prodPayload.to).toEqual(["riverside@example.com"]);
    expect(testPayload.to).toEqual(["test@example.com"]);

    // Same sender, same resolved subject.
    expect(testPayload.sender).toBe(prodPayload.sender);
    expect(testPayload.subject).toBe(prodPayload.subject);

    // Production additionally identifies the send row; every other header is
    // identical, which is the parity that was missing.
    expect(headerNames(prodPayload)).toEqual(["Reply-To", "X-Campaign-ID", "X-Send-ID"]);
    expect(testPayload.custom_headers).toEqual(
      prodPayload.custom_headers.filter((h: any) => h.header !== "X-Send-ID"),
    );
    expect(replyHeader(testPayload)).toBe(replyHeader(prodPayload));
    expect(replyHeader(testPayload)).toBe(REPLY_TO);
  });

  it("carries the same payload fields in both directions", async () => {
    const d1 = freshDb();
    const contactId = addContact(d1, "riverside@example.com");
    const campaignId = addCampaign(d1);
    const sendId = addSend(d1, campaignId, contactId, "riverside@example.com");
    const app = makeApp(d1);

    const testCalls = stubSmtp();
    await app.post(`/api/campaigns/${campaignId}/test`, {
      to: ["test@example.com"],
      contact_id: contactId,
    });
    const testPayload = testCalls[0].body;

    const prodCalls = stubSmtp();
    await processSendBatch(
      batchOf([
        { campaign_id: campaignId, send_id: sendId, contact_id: contactId, email: "riverside@example.com" },
      ]),
      app.env,
    );
    const prodPayload = prodCalls[0].body;

    // The in-app template shape: same body fields on both paths.
    for (const key of ["html_body", "text_body"]) {
      expect(testPayload[key]).toBe(prodPayload[key]);
    }
    // Neither path sends fields the API does not take for this shape.
    for (const key of ["template_id", "version", "template_data", "attachments", "inlines"]) {
      expect(key in testPayload).toBe(false);
      expect(key in prodPayload).toBe(false);
    }
  });

  it("carries template_id/version/template_data identically for an SMTP2GO template", async () => {
    const d1 = freshDb();
    const contactId = addContact(d1, "riverside@example.com");
    const campaignId = addCampaign(d1);
    // Point the campaign at an SMTP2GO template instead of the in-app one.
    d1.exec(
      `UPDATE campaigns SET external_template_id='tmpl-42', template_id=NULL WHERE id=${campaignId}`,
    );
    const sendId = addSend(d1, campaignId, contactId, "riverside@example.com");
    const app = makeApp(d1);

    const testCalls = stubSmtp();
    await app.post(`/api/campaigns/${campaignId}/test`, {
      to: ["test@example.com"],
      contact_id: contactId,
    });
    const testPayload = testCalls[0].body;

    const prodCalls = stubSmtp();
    await processSendBatch(
      batchOf([
        { campaign_id: campaignId, send_id: sendId, contact_id: contactId, email: "riverside@example.com" },
      ]),
      app.env,
    );
    const prodPayload = prodCalls[0].body;

    expect(testPayload.template_id).toBe("tmpl-42");
    expect(prodPayload.template_id).toBe("tmpl-42");
    expect(testPayload.version).toBe(prodPayload.version);
    expect(testPayload.template_data).toEqual(prodPayload.template_data);
    expect(headerNames(testPayload)).toEqual(["Reply-To", "X-Campaign-ID"]);
    expect(headerNames(prodPayload)).toEqual(["Reply-To", "X-Campaign-ID", "X-Send-ID"]);
  });
});
