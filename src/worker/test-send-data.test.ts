// Test sends render with REAL contact data.
//
// The bug: POST /:id/test looked the RECIPIENT address up as a contact, so
// testing to your own inbox left every mapped variable unresolved — the
// hardcoded {"first_name":"Test","practice_name":"Test Practice"} fallback —
// and a hybrid {{api_key}} inside a button URL rendered empty, leaving a button
// with no link to click.
//
// These tests pin the fix:
//   * a render contact supplies the values, independently of who receives it;
//   * without one, the recipient address is still tried as a contact (today's
//     behaviour, unchanged);
//   * with neither, the render falls back to the shared sample-value resolver
//     and the response says `sample`;
//   * the response names the render source and the contact it used;
//   * a test send never queues a send row and never touches an audience contact.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { ContactRow, Env } from "./types";
import { campaignsRoutes } from "./routes/campaigns";

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

const API_KEY = "ab12cd34ef56ab78";
const TEMPLATE_HTML =
  '<p>Hi {{first_name}}</p><p>{{practice_name}}</p><a href="{{button_url}}">Set up your profile</a>';
const MAPPING = {
  first_name: "first_name",
  practice_name: "practice_name",
  button_url: { value: "https://localdentists.au/setup-profile?api_key={{attributes.api_key}}" },
};

/** The URL a click actually follows (Mustache escapes the substituted value). */
function hrefOf(html: string): string {
  const m = /href="([^"]*)"/.exec(html);
  return (m?.[1] ?? "")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#x3D;/g, "=")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function freshDb(): TestD1 {
  const d1 = createTestD1();
  applyMigrations(d1, FRESH);
  d1.sql(
    "INSERT INTO templates (source, name, subject, html, text, is_base) VALUES ('local','Profile','Hi {{first_name}}',?,'',0)",
    TEMPLATE_HTML,
  );
  return d1;
}

/** A clinic contact whose per-recipient key lives in attributes. */
function addContact(
  d1: TestD1,
  opts: {
    email: string;
    first_name?: string;
    practice_name?: string;
    api_key?: string | null;
    status?: string;
    attributes?: string;
  },
): number {
  const attributes =
    opts.attributes ??
    JSON.stringify({ api_key: opts.api_key ?? API_KEY, slug: "riverside-dental" });
  const r = d1.sql<{ id: number }>(
    `INSERT INTO contacts (email, first_name, practice_name, attributes, status, source, email_status)
     VALUES (?,?,?,?,?, 'seed', 'valid') RETURNING id`,
    opts.email,
    opts.first_name ?? "Alex",
    opts.practice_name ?? "Riverside Dental",
    attributes,
    opts.status ?? "active",
  );
  return r[0].id;
}

/**
 * Template ids are not stable: migration 0005 seeds the "LocalDentists.au base"
 * template first, so the fixture's own template is not id 1.
 */
function profileTemplateId(d1: TestD1): number {
  return d1.sql<{ id: number }>("SELECT id FROM templates WHERE name='Profile'")[0].id;
}

function addCampaign(d1: TestD1, opts: { name?: string; segmentId?: number; listId?: number } = {}): number {
  const r = d1.sql<{ id: number }>(
    `INSERT INTO campaigns (name, template_id, segment_id, list_id, from_email, from_name, status, var_mapping)
     VALUES (?, ?, ?, ?, 'listing@localdentists.au', 'LocalDentists.au', 'draft', ?) RETURNING id`,
    opts.name ?? "Clinic outreach",
    profileTemplateId(d1),
    opts.segmentId ?? null,
    opts.listId ?? null,
    JSON.stringify(MAPPING),
  );
  return r[0].id;
}

/** Capture the SMTP2GO call the route makes; nothing leaves the test. */
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
  const json = async (path: string, init?: RequestInit) => {
    const res = await call(path, init);
    return { status: res.status, body: (await res.json()) as any };
  };
  return {
    call,
    get: (path: string) => json(path),
    post: (path: string, body: unknown) =>
      json(path, { method: "POST", body: JSON.stringify(body) }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a render contact supplies the values", () => {
  it("renders the chosen clinic even though the recipient is someone else", async () => {
    const d1 = freshDb();
    const contactId = addContact(d1, { email: "riverside@example.com" });
    const campaignId = addCampaign(d1);
    const calls = stubSmtp();
    const app = makeApp(d1);

    const { body } = await app.post(`/api/campaigns/${campaignId}/test`, {
      to: ["test@example.com"],
      contact_id: contactId,
    });

    expect(body.render_source).toBe("contact");
    expect(body.render_contact).toEqual({
      id: contactId,
      email: "riverside@example.com",
      business_name: "Riverside Dental",
    });
    // The actual send: the typed recipient, the clinic's data.
    expect(calls).toHaveLength(1);
    expect(calls[0].body.to).toEqual(["test@example.com"]);
    expect(calls[0].body.html_body).toContain("Hi Alex");
    expect(calls[0].body.html_body).toContain("Riverside Dental");
    // The hybrid button URL resolves to a real link — the whole point.
    expect(hrefOf(calls[0].body.html_body)).toBe(
      `https://localdentists.au/setup-profile?api_key=${API_KEY}`,
    );
    expect(body.results[0].render_source).toBe("contact");
  });

  it("accepts the contact's email instead of an id", async () => {
    const d1 = freshDb();
    addContact(d1, { email: "riverside@example.com" });
    const campaignId = addCampaign(d1);
    stubSmtp();
    const app = makeApp(d1);

    const { body } = await app.post(`/api/campaigns/${campaignId}/test`, {
      to: ["test@example.com"],
      contact_email: "RIVERSIDE@example.com",
    });

    expect(body.render_source).toBe("contact");
    expect(body.render_contact.business_name).toBe("Riverside Dental");
  });

  it("refuses a named render contact that does not exist", async () => {
    const d1 = freshDb();
    const campaignId = addCampaign(d1);
    stubSmtp();
    const app = makeApp(d1);

    const { status, body } = await app.post(`/api/campaigns/${campaignId}/test`, {
      to: ["test@example.com"],
      contact_id: 999,
    });

    expect(status).toBe(404);
    expect(body.error).toBe("render contact not found");
  });
});

describe("without a render contact", () => {
  it("still looks the recipient address up as a contact (today's behaviour)", async () => {
    const d1 = freshDb();
    addContact(d1, { email: "alex@example.com" });
    const campaignId = addCampaign(d1);
    const calls = stubSmtp();
    const app = makeApp(d1);

    const { body } = await app.post(`/api/campaigns/${campaignId}/test`, {
      to: ["alex@example.com"],
    });

    expect(body.render_source).toBe("recipient");
    expect(body.render_contact.business_name).toBe("Riverside Dental");
    expect(hrefOf(calls[0].body.html_body)).toBe(
      `https://localdentists.au/setup-profile?api_key=${API_KEY}`,
    );
  });

  it("falls back to sample values for an unknown recipient, and says so", async () => {
    const d1 = freshDb();
    addContact(d1, { email: "alex@example.com" });
    const campaignId = addCampaign(d1);
    const calls = stubSmtp();
    const app = makeApp(d1);

    const { body } = await app.post(`/api/campaigns/${campaignId}/test`, {
      to: ["stranger@example.com"],
    });

    expect(body.render_source).toBe("sample");
    expect(body.render_contact).toBeNull();
    const html = calls[0].body.html_body as string;
    // The samples, never the old hardcoded placeholder strings.
    expect(html).toContain("Sample Dental Care");
    expect(html).toContain("Hi Alex");
    expect(html).not.toContain("Test Practice");
    expect(html).not.toContain("Test User");
    // The hybrid link still resolves to a link-shaped value.
    expect(hrefOf(html)).toMatch(
      /^https:\/\/localdentists\.au\/setup-profile\?api_key=[0-9a-f]{32}$/,
    );
  });
});

describe("the preview endpoint (before anything is sent)", () => {
  it("reports the resolved link and the clinic for a chosen contact", async () => {
    const d1 = freshDb();
    const contactId = addContact(d1, { email: "riverside@example.com" });
    const campaignId = addCampaign(d1);
    const app = makeApp(d1);

    const { body } = await app.get(
      `/api/campaigns/${campaignId}/test-render?contact_id=${contactId}`,
    );

    expect(body.render_source).toBe("contact");
    expect(body.render_contact.business_name).toBe("Riverside Dental");
    expect(body.links).toEqual([
      {
        name: "button_url",
        url: `https://localdentists.au/setup-profile?api_key=${API_KEY}`,
      },
    ]);
    expect(body.empty).toEqual([]);
  });

  it("shows the sample render when no contact is chosen", async () => {
    const d1 = freshDb();
    const campaignId = addCampaign(d1);
    const app = makeApp(d1);

    const { body } = await app.get(`/api/campaigns/${campaignId}/test-render`);

    expect(body.render_source).toBe("sample");
    expect(body.render_contact).toBeNull();
    expect(body.links[0].name).toBe("button_url");
    expect(body.links[0].url).toMatch(/^https:\/\/localdentists\.au\/setup-profile\?api_key=[0-9a-f]{32}$/);
  });

  it("flags the link variable that renders empty (the broken button)", async () => {
    const d1 = freshDb();
    // A contact with no api_key attribute: the hybrid URL fails safe to "".
    const contactId = addContact(d1, { email: "thin@example.com", attributes: "{}" });
    const campaignId = addCampaign(d1);
    const app = makeApp(d1);

    const { body } = await app.get(
      `/api/campaigns/${campaignId}/test-render?contact_id=${contactId}`,
    );

    expect(body.render_source).toBe("contact");
    expect(body.links).toEqual([]);
    expect(body.empty).toContain("button_url");
  });
});

describe("the audience picker reads the campaign's own audience", () => {
  function seedSegment(d1: TestD1): { segmentId: number; keep: number; drop: number; suppressed: number } {
    const r = d1.sql<{ id: number }>(
      `INSERT INTO lists (name, kind, filter_json) VALUES ('Verified outreach','segment',?) RETURNING id`,
      JSON.stringify({
        rules: [{ source: "attribute", field: "outreach_ok", op: "eq", value: "1" }],
      }),
    );
    const keep = addContact(d1, {
      email: "riverside@example.com",
      attributes: JSON.stringify({ api_key: API_KEY, outreach_ok: 1 }),
    });
    const drop = addContact(d1, {
      email: "not-verified@example.com",
      practice_name: "Other Clinic",
      attributes: JSON.stringify({ outreach_ok: 0 }),
    });
    const suppressed = addContact(d1, {
      email: "suppressed@example.com",
      practice_name: "Suppressed Clinic",
      attributes: JSON.stringify({ outreach_ok: 1 }),
    });
    d1.sql("INSERT INTO suppressions (email, reason) VALUES ('suppressed@example.com','unsubscribe')");
    return { segmentId: r[0].id, keep, drop, suppressed };
  }

  it("offers audience contacts only, with their business name", async () => {
    const d1 = freshDb();
    const { segmentId, keep } = seedSegment(d1);
    const campaignId = addCampaign(d1, { segmentId });
    const app = makeApp(d1);

    const { body } = await app.get(`/api/campaigns/${campaignId}/audience-contacts`);

    expect(body.total).toBe(1);
    expect(body.rows).toEqual([
      { id: keep, email: "riverside@example.com", business_name: "Riverside Dental" },
    ]);
    expect(body.degraded).toBe(false);
    expect(body.truncated).toBe(false);
  });

  it("filters the picker by a search term", async () => {
    const d1 = freshDb();
    const { segmentId } = seedSegment(d1);
    const campaignId = addCampaign(d1, { segmentId });
    const app = makeApp(d1);

    const hit = await app.get(`/api/campaigns/${campaignId}/audience-contacts?q=riverside`);
    expect(hit.body.rows).toHaveLength(1);

    const miss = await app.get(`/api/campaigns/${campaignId}/audience-contacts?q=nope`);
    expect(miss.body.rows).toEqual([]);
    // The search never widens past the audience.
    expect(miss.body.total).toBe(1);
  });

  it("picks another at random from the audience", async () => {
    const d1 = freshDb();
    const campaignId = addCampaign(d1);
    addContact(d1, { email: "a@example.com", practice_name: "Alpha Dental" });
    addContact(d1, { email: "b@example.com", practice_name: "Beta Dental" });
    const app = makeApp(d1);

    const { body } = await app.get(`/api/campaigns/${campaignId}/audience-contacts?random=1`);

    expect(body.total).toBe(2);
    expect(body.rows).toHaveLength(1);
    expect(["a@example.com", "b@example.com"]).toContain(body.rows[0].email);
  });

  it("does not mutate anything while reading", async () => {
    const d1 = freshDb();
    const { segmentId } = seedSegment(d1);
    const campaignId = addCampaign(d1, { segmentId });
    const app = makeApp(d1);
    const before = d1.sql<ContactRow>("SELECT * FROM contacts ORDER BY id");

    await app.get(`/api/campaigns/${campaignId}/audience-contacts`);
    await app.get(`/api/campaigns/${campaignId}/audience-contacts?random=1`);

    expect(d1.sql<ContactRow>("SELECT * FROM contacts ORDER BY id")).toEqual(before);
  });
});

describe("a test send is side-effect free for the campaign and its audience", () => {
  it("queues no send row and leaves the audience contact untouched", async () => {
    const d1 = freshDb();
    const contactId = addContact(d1, { email: "riverside@example.com" });
    const campaignId = addCampaign(d1);
    const before = d1.sql<ContactRow>("SELECT * FROM contacts WHERE id=?", contactId)[0];
    stubSmtp();
    const app = makeApp(d1);

    await app.post(`/api/campaigns/${campaignId}/test`, {
      to: ["test@example.com"],
      contact_id: contactId,
    });

    // No queue rows, no campaign send state, no contact change.
    expect(d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM sends")[0].n).toBe(0);
    expect(d1.sql<{ status: string }>("SELECT status FROM campaigns WHERE id=?", campaignId)[0].status).toBe(
      "draft",
    );
    expect(d1.sql<ContactRow>("SELECT * FROM contacts WHERE id=?", contactId)[0]).toEqual(before);
  });

  it("only ever emails the addresses the caller typed", async () => {
    const d1 = freshDb();
    addContact(d1, { email: "riverside@example.com" });
    const campaignId = addCampaign(d1);
    const calls = stubSmtp();
    const app = makeApp(d1);

    await app.post(`/api/campaigns/${campaignId}/test`, {
      to: ["me@example.com", "also-me@example.com"],
      contact_id: 1,
    });

    expect(calls.flatMap((c) => c.body.to)).toEqual(["me@example.com", "also-me@example.com"]);
  });
});
