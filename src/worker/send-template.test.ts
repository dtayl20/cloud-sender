// POST /api/webhooks/send-template — one SMTP2GO template to one contact,
// triggered by a GHL tag.
//
// These run the real route against an in-memory SQLite database built from the
// real migration files (including 0013, which relaxes sends.campaign_id and adds
// the GHL columns), so the SQL — not just the handler logic — is what gets
// checked. The SMTP2GO call is stubbed at `fetch`, so the assertions are on the
// exact payload that would have left, and on the row that would have been
// written for the open/click callback to stamp.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { Env } from "./types";
import { webhooksRoutes } from "./webhooks";
import {
  TAG_TEMPLATE_MAP,
  buildTemplateData,
  templateIdForTag,
  validateSendTemplate,
} from "./sendTemplate";

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
];

const TOKEN = "webhook-token";

function stubSmtp(respond?: () => any) {
  const calls: { url: string; body: any }[] = [];
  vi.stubGlobal("fetch", async (url: unknown, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (respond) return respond();
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ request_id: "req-1", data: { succeeded: 1, email_id: "e1" } }),
    };
  });
  return calls;
}

function makeApp(overrides: Partial<Env> = {}) {
  const d1: TestD1 = createTestD1();
  applyMigrations(d1, MIGRATIONS);
  const env = {
    DB: d1,
    SMTP2GO_API_KEY: "test-key",
    WEBHOOK_TOKEN: TOKEN,
    DEFAULT_FROM_EMAIL: "listing@localdentists.au",
    DEFAULT_FROM_NAME: "LocalDentists.au",
    ...overrides,
  } as unknown as Env;

  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/webhooks", webhooksRoutes);

  const post = (body: unknown, opts: { headers?: Record<string, string>; query?: string } = {}) =>
    app.fetch(
      new Request(`http://test/api/webhooks/send-template${opts.query ?? ""}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
          ...(opts.headers ?? {}),
        },
        body: JSON.stringify(body),
      }),
      env,
    );

  return { env, d1, app, post };
}

const valid = {
  ghl_contact_id: "ghl_123",
  email: "manager@clinic.com.au",
  first_name: "Sam",
  clinic_name: "Harbourview Dental",
  tag: "send_playbook",
};

const jsonOf = async (res: Response): Promise<any> => (await res.json()) as any;

const sendsOf = (d1: TestD1) =>
  d1.sql<{
    id: number;
    campaign_id: number | null;
    contact_id: number | null;
    email: string;
    status: string;
    smtp2go_id: string | null;
    ghl_contact_id: string | null;
  }>("SELECT * FROM sends ORDER BY id");

/** The shared container campaign every tag-triggered send points at. */
const triggerCampaignId = (d1: TestD1): number =>
  Number(
    d1.sql<{ id: number }>("SELECT id FROM campaigns WHERE name='GHL tag triggers'")[0]?.id,
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("token gating", () => {
  it("refuses a request with no token and sends nothing", async () => {
    const calls = stubSmtp();
    const { d1 } = makeApp();
    const res = await makeAppNoToken(d1, valid);

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("forbidden");
    expect(calls).toHaveLength(0);
    expect(sendsOf(d1)).toHaveLength(0);
  });

  it("refuses a wrong token", async () => {
    const calls = stubSmtp();
    const { post } = makeApp();
    const res = await post(valid, { headers: { Authorization: "Bearer nope" } });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("accepts a Bearer token, an X-Webhook-Token and a ?token=", async () => {
    const calls = stubSmtp();
    const { post } = makeApp();

    expect((await post(valid)).status).toBe(200);
    expect(
      (await post(valid, { headers: { Authorization: "", "X-Webhook-Token": TOKEN } })).status,
    ).toBe(200);
    expect((await post(valid, { headers: { Authorization: "" }, query: `?token=${TOKEN}` })).status).toBe(
      200,
    );
    expect(calls).toHaveLength(3);
  });
});

describe("suppression", () => {
  it("blocks a suppressed address and records no send", async () => {
    const calls = stubSmtp();
    const { post, d1 } = makeApp();
    d1.exec(
      "INSERT INTO suppressions (email, reason) VALUES ('manager@clinic.com.au', 'bounce')",
    );

    const res = await post(valid);
    expect(res.status).toBe(409);
    expect(await jsonOf(res)).toEqual({ error: "suppressed", reason: "bounce" });
    expect(calls).toHaveLength(0);
    expect(sendsOf(d1)).toHaveLength(0);
  });
});

describe("tag → template mapping", () => {
  it("maps the known GHL tags", () => {
    expect(TAG_TEMPLATE_MAP.send_playbook).toBe("playbook");
    expect(TAG_TEMPLATE_MAP.send_ld_general_info).toBe("services");
    expect(templateIdForTag("send_playbook")).toBe("playbook");
    expect(templateIdForTag("  SEND_LD_GENERAL_INFO ")).toBe("services");
    expect(templateIdForTag("send_something_else")).toBeNull();
  });

  it("sends the mapped template id for each tag", async () => {
    const calls = stubSmtp();
    const { post } = makeApp();

    expect((await post(valid)).status).toBe(200); // send_playbook
    expect((await post({ ...valid, tag: "send_ld_general_info" })).status).toBe(200);
    expect(calls.map((c) => c.body.template_id)).toEqual(["playbook", "services"]);
  });

  it("lets an explicit template_id win over the tag", async () => {
    const calls = stubSmtp();
    const { post } = makeApp();
    const res = await post({ ...valid, template_id: "custom_7" });
    expect(res.status).toBe(200);
    expect(calls[0].body.template_id).toBe("custom_7");
  });

  it("refuses an unmapped tag rather than guessing", async () => {
    const calls = stubSmtp();
    const { post } = makeApp();
    const res = await post({ ...valid, tag: "send_nope" });
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).errors).toEqual({ tag: "unknown" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a payload with neither a template nor a tag", async () => {
    const calls = stubSmtp();
    const { post } = makeApp();
    const res = await post({ ghl_contact_id: "g", email: "a@b.com" });
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).errors).toEqual({ template_id: "required" });
    expect(calls).toHaveLength(0);
  });
});

describe("the send row and the contact", () => {
  it("records the SMTP2GO id and the GHL contact id on the send", async () => {
    stubSmtp();
    const { post, d1 } = makeApp();
    const res = await post(valid);
    expect(res.status).toBe(200);

    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(typeof body.send_id).toBe("number");

    const rows = sendsOf(d1);
    expect(rows).toHaveLength(1);
    // The send belongs to the shared "GHL tag triggers" container, not no
    // campaign, so it and its opens/clicks show up in the UI.
    expect(rows[0]).toMatchObject({
      id: body.send_id,
      campaign_id: triggerCampaignId(d1),
      email: "manager@clinic.com.au",
      status: "sent",
      smtp2go_id: "e1",
      ghl_contact_id: "ghl_123",
    });
    // Linked to the contact it was upserted as.
    expect(rows[0].contact_id).not.toBeNull();
  });

  it("upserts the contact and stores the GHL id, first name and clinic", async () => {
    stubSmtp();
    const { post, d1 } = makeApp();
    await post(valid);

    const contacts = d1.sql<any>("SELECT * FROM contacts");
    expect(contacts).toHaveLength(1);
    expect(contacts[0].email).toBe("manager@clinic.com.au");
    expect(contacts[0].ghl_contact_id).toBe("ghl_123");
    expect(contacts[0].first_name).toBe("Sam");
    expect(contacts[0].practice_name).toBe("Harbourview Dental");
  });

  it("reuses an existing contact and keeps its fields when not supplied", async () => {
    stubSmtp();
    const { post, d1 } = makeApp();
    d1.exec(
      "INSERT INTO contacts (email, first_name, source) VALUES ('manager@clinic.com.au', 'Existing', 'import')",
    );

    await post({ ghl_contact_id: "ghl_999", email: "manager@clinic.com.au", template_id: "playbook" });

    const contacts = d1.sql<any>("SELECT * FROM contacts");
    expect(contacts).toHaveLength(1);
    expect(contacts[0].first_name).toBe("Existing"); // not blanked by a missing first_name
    expect(contacts[0].ghl_contact_id).toBe("ghl_999");
  });

  it("allows a second send to the same contact, in the same container", async () => {
    stubSmtp();
    const { post, d1 } = makeApp();
    expect((await post(valid)).status).toBe(200);
    expect((await post(valid)).status).toBe(200);
    const rows = sendsOf(d1);
    expect(rows).toHaveLength(2);
    // The container is a normal campaign_id, but a repeat send to the same
    // contact must still be recorded (0015 relaxes the campaign UNIQUE for it).
    expect(rows[0].campaign_id).toBe(triggerCampaignId(d1));
    expect(rows[1].campaign_id).toBe(triggerCampaignId(d1));
    // One container row, reused - not a new campaign per send.
    expect(
      d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM campaigns WHERE name='GHL tag triggers'")[0]
        .n,
    ).toBe(1);
  });

  it("includes the supplied fields and names in template_data", async () => {
    const calls = stubSmtp();
    const { post } = makeApp();
    await post({
      ...valid,
      fields: { promo: "SAVE10", clinic_phone: "0400 000 000" },
    });
    expect(calls[0].body.template_data).toEqual({
      promo: "SAVE10",
      clinic_phone: "0400 000 000",
      first_name: "Sam",
      clinic_name: "Harbourview Dental",
    });
  });

  it("uses the shared sender conventions (sender line + Reply-To header)", async () => {
    const calls = stubSmtp();
    const { post } = makeApp();
    await post(valid);
    expect(calls[0].body.sender).toBe("LocalDentists.au <listing@localdentists.au>");
    expect(calls[0].body.custom_headers).toEqual([
      { header: "Reply-To", value: "listing@localdentists.au" },
    ]);
  });
});

describe("failures", () => {
  it("returns 502 and marks the send failed when SMTP2GO rejects it", async () => {
    stubSmtp(() => ({ ok: false, status: 500, text: async () => "upstream boom" }));
    const { post, d1 } = makeApp();
    const res = await post(valid);
    expect(res.status).toBe(502);
    expect((await jsonOf(res)).error).toBe("send_failed");
    const rows = sendsOf(d1);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
  });

  it("returns 503 rather than mailing when the route is misconfigured", async () => {
    const calls = stubSmtp();
    const { post } = makeApp({ SMTP2GO_API_KEY: "" });
    const res = await post(valid);
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("refuses invalid JSON", async () => {
    stubSmtp();
    const { app, env } = makeApp();
    const res = await app.fetch(
      new Request("http://test/api/webhooks/send-template", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: "{not json",
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe("invalid_json");
  });
});

describe("validation helpers", () => {
  it("requires a GHL contact id and a valid email", () => {
    const r = validateSendTemplate({ tag: "send_playbook" });
    expect(r.ok).toBe(false);
    expect(Object.keys(r.errors).sort()).toEqual(["email", "ghl_contact_id"]);
  });

  it("flattens newlines out of header-bound fields", () => {
    const r = validateSendTemplate({
      ...valid,
      first_name: "Sam\r\nBcc: x@y.com",
    });
    expect(r.values.first_name).toBe("Sam Bcc: x@y.com");
  });

  it("rejects nested field values but accepts scalars", () => {
    expect(validateSendTemplate({ ...valid, fields: { a: { b: 1 } } }).errors.fields).toBe(
      "invalid",
    );
    expect(validateSendTemplate({ ...valid, fields: { a: 1, b: true } }).ok).toBe(true);
  });

  it("only sets template_data keys that have a value", () => {
    expect(buildTemplateData("", "", {})).toEqual({});
    expect(buildTemplateData("Sam", "Clinic", { promo: "X" })).toEqual({
      promo: "X",
      first_name: "Sam",
      clinic_name: "Clinic",
    });
  });
});

/** The no-token case needs a request without the helper's default Bearer. */
async function makeAppNoToken(d1: TestD1, body: unknown): Promise<Response> {
  const env = {
    DB: d1,
    SMTP2GO_API_KEY: "test-key",
    WEBHOOK_TOKEN: TOKEN,
    DEFAULT_FROM_EMAIL: "listing@localdentists.au",
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/webhooks", webhooksRoutes);
  return app.fetch(
    new Request("http://test/api/webhooks/send-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}
