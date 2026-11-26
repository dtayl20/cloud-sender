// Per-recipient engagement list for a campaign: GET /api/campaigns/:id/recipients.
//
// These run the real route against an in-memory SQLite database built from the
// real migration files, so the SQL (joins, filters, ordering, the NULL
// campaign_id exclusion) is what gets checked, not just the handler logic.
//
// The point of the set is the contract the UI depends on:
//   * one row per send, with the contact name joined in;
//   * pagination (limit/offset) with a filtered total;
//   * each engagement filter;
//   * search over email/name;
//   * a campaign with no sends is an empty list, never an error;
//   * a send with campaign_id = NULL (or another campaign's send) is never
//     included.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { Env } from "./types";
import { campaignsRoutes } from "./routes/campaigns";

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

function freshDb(): TestD1 {
  const d1 = createTestD1();
  applyMigrations(d1, MIGRATIONS);
  return d1;
}

function makeApp(d1: TestD1) {
  const env = {
    DB: d1,
    SEND_TIMEZONE: "Australia/Brisbane",
    DEFAULT_FROM_EMAIL: "listing@localdentists.au",
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/campaigns", campaignsRoutes);
  const call = (p: string) => app.fetch(new Request(`http://test${p}`), env);
  const get = async (p: string) => (await call(p)).json() as any;
  return { env, app, call, get };
}

const esc = (s: string) => s.replace(/'/g, "''");
const lit = (x: unknown): string =>
  x === undefined || x === null ? "NULL" : typeof x === "number" ? String(x) : `'${esc(String(x))}'`;

function makeCampaign(d1: TestD1, name = "Campaign"): number {
  d1.exec(
    `INSERT INTO campaigns (name, status, from_email) VALUES ('${esc(name)}', 'draft', 'listing@localdentists.au')`,
  );
  return Number(d1.sql<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id);
}

function addContact(
  d1: TestD1,
  email: string,
  first_name: string | null = null,
  practice_name: string | null = null,
  ghl_contact_id: string | null = null,
): number {
  d1.exec(
    `INSERT INTO contacts (email, first_name, practice_name, ghl_contact_id, email_status)
     VALUES (${lit(email)}, ${lit(first_name)}, ${lit(practice_name)}, ${lit(ghl_contact_id)}, 'valid')`,
  );
  return Number(d1.sql<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id);
}

interface SendSpec {
  campaignId: number | null;
  email: string;
  contactId?: number | null;
  status?: string;
  smtp2go_id?: string | null;
  ghl_contact_id?: string | null;
  sent_at?: number | null;
  delivered_at?: number | null;
  opened_at?: number | null;
  clicked_at?: number | null;
  bounced_at?: number | null;
}

function addSend(d1: TestD1, s: SendSpec): number {
  d1.exec(
    `INSERT INTO sends (campaign_id, contact_id, email, status, smtp2go_id, ghl_contact_id,
        sent_at, delivered_at, opened_at, clicked_at, bounced_at)
     VALUES (${lit(s.campaignId)}, ${lit(s.contactId ?? null)}, ${lit(s.email)},
        ${lit(s.status ?? "sent")}, ${lit(s.smtp2go_id ?? null)}, ${lit(s.ghl_contact_id ?? null)},
        ${lit(s.sent_at ?? null)}, ${lit(s.delivered_at ?? null)}, ${lit(s.opened_at ?? null)},
        ${lit(s.clicked_at ?? null)}, ${lit(s.bounced_at ?? null)})`,
  );
  return Number(d1.sql<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id);
}

const byEmail = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.email, r]));

describe("recipients: one row per send, with the contact joined in", () => {
  it("returns engagement timestamps, the SMTP2Go id and the GHL contact", async () => {
    const d1 = freshDb();
    const { get } = makeApp(d1);
    const c = makeCampaign(d1);
    const alice = addContact(d1, "alice@example.com", "Alice", "Bright Smiles", "ghl_alice");
    const bob = addContact(d1, "bob@example.com", "Bob");

    addSend(d1, {
      campaignId: c,
      email: "alice@example.com",
      contactId: alice,
      status: "delivered",
      smtp2go_id: "m1",
      sent_at: 1000,
      delivered_at: 1001,
      opened_at: 1002,
      clicked_at: 1003,
      ghl_contact_id: "ghl_alice",
    });
    addSend(d1, {
      campaignId: c,
      email: "bob@example.com",
      contactId: bob,
      status: "delivered",
      smtp2go_id: "m2",
      sent_at: 2000,
      delivered_at: 2001,
    });

    const res = await get(`/api/campaigns/${c}/recipients`);
    expect(res.total).toBe(2);
    expect(res.rows).toHaveLength(2);

    const m = byEmail(res.rows);
    // Practice name wins for the display name; a first name is the fallback.
    expect(m["alice@example.com"].name).toBe("Bright Smiles");
    expect(m["bob@example.com"].name).toBe("Bob");
    expect(m["alice@example.com"].opened_at).toBe(1002);
    expect(m["alice@example.com"].clicked_at).toBe(1003);
    expect(m["alice@example.com"].delivered_at).toBe(1001);
    expect(m["alice@example.com"].smtp2go_id).toBe("m1");
    expect(m["alice@example.com"].ghl_contact_id).toBe("ghl_alice");
    expect(m["bob@example.com"].opened_at).toBeNull();

    // Campaign-wide counts, independent of any filter.
    expect(res.counts).toMatchObject({
      total: 2,
      sent: 2,
      delivered: 2,
      opened: 1,
      clicked: 1,
      bounced: 0,
      not_opened: 1,
    });
  });

  it("adds a per-recipient total to the stats block", async () => {
    const d1 = freshDb();
    const { get } = makeApp(d1);
    const c = makeCampaign(d1);
    addSend(d1, { campaignId: c, email: "a@example.com", sent_at: 1, opened_at: 2 });

    const stats = await get(`/api/campaigns/${c}/stats`);
    expect(stats.total).toBe(1);
    expect(stats.engagement.opened).toBe(1);
  });
});

describe("recipients: pagination", () => {
  it("honours limit/offset, reports the filtered total and clamps bounds", async () => {
    const d1 = freshDb();
    const { get } = makeApp(d1);
    const c = makeCampaign(d1);
    for (let i = 0; i < 8; i++) addSend(d1, { campaignId: c, email: `r${i}@example.com`, sent_at: 100 + i });

    const first = await get(`/api/campaigns/${c}/recipients?limit=3&offset=0`);
    expect(first.rows).toHaveLength(3);
    expect(first.total).toBe(8);
    expect(first.limit).toBe(3);
    expect(first.offset).toBe(0);

    const second = await get(`/api/campaigns/${c}/recipients?limit=3&offset=3`);
    expect(second.rows).toHaveLength(3);
    expect(second.total).toBe(8);

    const last = await get(`/api/campaigns/${c}/recipients?limit=3&offset=6`);
    expect(last.rows).toHaveLength(2);
    expect(last.total).toBe(8);

    const past = await get(`/api/campaigns/${c}/recipients?limit=3&offset=100`);
    expect(past.rows).toHaveLength(0);
    expect(past.total).toBe(8);

    // limit is clamped into [1, 200] rather than trusted blindly.
    const clampedLow = await get(`/api/campaigns/${c}/recipients?limit=0`);
    expect(clampedLow.limit).toBe(1);
    expect(clampedLow.rows).toHaveLength(1);
    const clampedHigh = await get(`/api/campaigns/${c}/recipients?limit=999`);
    expect(clampedHigh.limit).toBe(200);
    expect(clampedHigh.rows).toHaveLength(8);
  });
});

describe("recipients: engagement filters", () => {
  function seed(d1: TestD1, c: number) {
    addSend(d1, { campaignId: c, email: "opened@example.com", status: "delivered", sent_at: 1, delivered_at: 2, opened_at: 3 });
    addSend(d1, { campaignId: c, email: "clicked@example.com", status: "delivered", sent_at: 1, delivered_at: 2, opened_at: 3, clicked_at: 4 });
    addSend(d1, { campaignId: c, email: "delivered@example.com", status: "delivered", sent_at: 1, delivered_at: 2 });
    addSend(d1, { campaignId: c, email: "bounced@example.com", status: "bounced", sent_at: 1, bounced_at: 5 });
    addSend(d1, { campaignId: c, email: "queued@example.com", status: "queued" });
  }

  it("filters by each engagement state", async () => {
    const d1 = freshDb();
    const { get } = makeApp(d1);
    const c = makeCampaign(d1);
    seed(d1, c);

    const all = await get(`/api/campaigns/${c}/recipients`);
    expect(all.total).toBe(5);

    const opened = await get(`/api/campaigns/${c}/recipients?filter=opened`);
    expect(opened.total).toBe(2);
    expect(opened.rows.map((r: any) => r.email).sort()).toEqual([
      "clicked@example.com",
      "opened@example.com",
    ]);

    const clicked = await get(`/api/campaigns/${c}/recipients?filter=clicked`);
    expect(clicked.total).toBe(1);
    expect(clicked.rows[0].email).toBe("clicked@example.com");

    const delivered = await get(`/api/campaigns/${c}/recipients?filter=delivered`);
    expect(delivered.total).toBe(3);

    const bounced = await get(`/api/campaigns/${c}/recipients?filter=bounced`);
    expect(bounced.total).toBe(1);
    expect(bounced.rows[0].email).toBe("bounced@example.com");

    const notOpened = await get(`/api/campaigns/${c}/recipients?filter=not-opened`);
    expect(notOpened.total).toBe(3);
    expect(notOpened.rows.map((r: any) => r.email).sort()).toEqual([
      "bounced@example.com",
      "delivered@example.com",
      "queued@example.com",
    ]);

    // The campaign-wide counts stay put even while a filter narrows the rows.
    expect(clicked.counts.total).toBe(5);
    expect(clicked.counts.opened).toBe(2);

    // An unknown filter falls back to "all" rather than an error.
    const bogus = await get(`/api/campaigns/${c}/recipients?filter=nonsense`);
    expect(bogus.filter).toBe("all");
    expect(bogus.total).toBe(5);
  });
});

describe("recipients: search", () => {
  it("matches on email, first name and practice name", async () => {
    const d1 = freshDb();
    const { get } = makeApp(d1);
    const c = makeCampaign(d1);
    const priya = addContact(d1, "priya@northside.com", "Priya", "Northside Dental");
    const tom = addContact(d1, "tom@other.com", "Tom");
    addSend(d1, { campaignId: c, email: "priya@northside.com", contactId: priya, sent_at: 1 });
    addSend(d1, { campaignId: c, email: "tom@other.com", contactId: tom, sent_at: 2 });

    const byEmail = await get(`/api/campaigns/${c}/recipients?q=northside`);
    expect(byEmail.total).toBe(1);
    expect(byEmail.rows[0].email).toBe("priya@northside.com");

    const byName = await get(`/api/campaigns/${c}/recipients?q=Priya`);
    expect(byName.total).toBe(1);
    expect(byName.rows[0].first_name).toBe("Priya");

    const byPractice = await get(`/api/campaigns/${c}/recipients?q=Dental`);
    expect(byPractice.total).toBe(1);

    const none = await get(`/api/campaigns/${c}/recipients?q=zzz-no-match`);
    expect(none.total).toBe(0);
    expect(none.rows).toHaveLength(0);
    // Counts describe the whole campaign, not the search.
    expect(none.counts.total).toBe(2);
  });
});

describe("recipients: sorting", () => {
  it("orders by most recent open/click when asked, newest send by default", async () => {
    const d1 = freshDb();
    const { get } = makeApp(d1);
    const c = makeCampaign(d1);
    addSend(d1, { campaignId: c, email: "a@example.com", sent_at: 1, opened_at: 500 });
    addSend(d1, { campaignId: c, email: "b@example.com", sent_at: 2, opened_at: 100, clicked_at: 900 });
    addSend(d1, { campaignId: c, email: "c@example.com", sent_at: 3 });

    const recent = await get(`/api/campaigns/${c}/recipients?sort=recent`);
    expect(recent.rows.map((r: any) => r.email)).toEqual([
      "c@example.com",
      "b@example.com",
      "a@example.com",
    ]);

    const engagement = await get(`/api/campaigns/${c}/recipients?sort=engagement`);
    // b's click (900) is the most recent; a's open (500) next; c never engaged.
    expect(engagement.rows.map((r: any) => r.email)).toEqual([
      "b@example.com",
      "a@example.com",
      "c@example.com",
    ]);
  });
});

describe("recipients: boundaries", () => {
  it("returns an empty list (not an error) for a campaign with no sends", async () => {
    const d1 = freshDb();
    const { get, call } = makeApp(d1);
    const c = makeCampaign(d1);

    const res = await get(`/api/campaigns/${c}/recipients`);
    expect(res.rows).toEqual([]);
    expect(res.total).toBe(0);
    expect(res.counts.total).toBe(0);
    expect(res.error).toBeUndefined();
    expect((await call(`/api/campaigns/${c}/recipients`)).status).toBe(200);
  });

  it("never includes a send with campaign_id = NULL, nor another campaign's sends", async () => {
    const d1 = freshDb();
    const { get } = makeApp(d1);
    const c = makeCampaign(d1);
    const other = makeCampaign(d1, "Other");
    addSend(d1, { campaignId: c, email: "mine@example.com", sent_at: 1 });
    // A legacy / home-less send (campaign_id NULL) must be invisible here.
    addSend(d1, { campaignId: null, email: "homeless@example.com", sent_at: 2, opened_at: 3 });
    addSend(d1, { campaignId: other, email: "other@example.com", sent_at: 3 });

    const res = await get(`/api/campaigns/${c}/recipients`);
    expect(res.rows.map((r: any) => r.email)).toEqual(["mine@example.com"]);
    expect(res.total).toBe(1);
    expect(res.counts.total).toBe(1);
    expect(res.counts.opened).toBe(0);
  });

  it("404s for a campaign that does not exist", async () => {
    const d1 = freshDb();
    const { call } = makeApp(d1);
    const res = await call("/api/campaigns/99999/recipients");
    expect(res.status).toBe(404);
  });
});
