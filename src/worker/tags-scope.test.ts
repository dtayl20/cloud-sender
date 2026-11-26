// Contact tags and campaign tags are independent namespaces. These tests run
// the real routes (and the real migration) against an in-memory SQLite database
// so the SQL — not just the handler logic — is what gets checked.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { Env } from "./types";
import { tagsRoutes } from "./routes/tags";
import { contactsRoutes } from "./routes/contacts";
import { campaignsRoutes } from "./routes/campaigns";

const FRESH = [
  "0001_init.sql",
  "0002_segments.sql",
  "0003_campaign_var_mapping.sql",
  "0004_source_sync.sql",
  "0005_campaign_body.sql",
  "0006_campaign_tags.sql",
  "0007_campaign_subject.sql",
  "0009_campaign_send_plan.sql",
  "0010_campaign_send_ramp.sql",
  "0011_campaign_send_spread.sql",
  "0016_email_verification.sql",
  "0017_email_verification_backfill.sql",
  "0018_email_verify_queue.sql",
  "0020_sequences.sql",
  "0021_sequence_timezone_backfill.sql",
];

function freshDb(): TestD1 {
  const d1 = createTestD1();
  applyMigrations(d1, FRESH);
  return d1;
}

function makeApp(d1: TestD1) {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/tags", tagsRoutes);
  app.route("/api/contacts", contactsRoutes);
  app.route("/api/campaigns", campaignsRoutes);
  const env = { DB: d1 } as unknown as Env;
  const call = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://test${path}`, init), env);
  const json = async (path: string, init?: RequestInit) => (await call(path, init)).json() as any;
  const post = (path: string, body: unknown) =>
    json(path, { method: "POST", body: JSON.stringify(body) });
  return { call, json, post };
}

type TagRow = { id: number; name: string; scope: string; contact_count?: number; campaign_count?: number };

describe("0006 migration: tags gain a scope", () => {
  it("copies existing tags to scope='contact' and keeps contact_tags intact", () => {
    const d1 = createTestD1();
    applyMigrations(d1, ["0001_init.sql", "0002_segments.sql"]);
    // Pre-existing data under the old single-namespace schema.
    d1.exec("INSERT INTO contacts (email) VALUES ('old@example.com')");
    d1.exec("INSERT INTO tags (name) VALUES ('melbourne')");
    d1.exec("INSERT INTO contact_tags (contact_id, tag_id) VALUES (1, 1)");

    applyMigrations(d1, ["0006_campaign_tags.sql"]);

    expect(d1.sql<TagRow>("SELECT id, name, scope FROM tags")).toEqual([
      { id: 1, name: "melbourne", scope: "contact" },
    ]);
    // Same id, so the join row still resolves.
    expect(d1.sql("SELECT contact_id, tag_id FROM contact_tags")).toEqual([
      { contact_id: 1, tag_id: 1 },
    ]);
  });

  it("allows the same name in both scopes, but not twice within a scope", () => {
    const d1 = freshDb();
    d1.exec("INSERT INTO tags (name) VALUES ('melbourne')");
    d1.exec("INSERT INTO tags (name, scope) VALUES ('melbourne', 'campaign')");

    expect(
      d1.sql<TagRow>("SELECT name, scope FROM tags ORDER BY scope"),
    ).toEqual([
      { name: "melbourne", scope: "campaign" },
      { name: "melbourne", scope: "contact" },
    ]);

    expect(() => d1.exec("INSERT INTO tags (name, scope) VALUES ('MELBOURNE', 'contact')")).toThrow();
    expect(() => d1.exec("INSERT INTO tags (name, scope) VALUES ('melbourne', 'campaign')")).toThrow();
  });

  it("leaves contact_tags pointing at the rebuilt tags table (FK still cascades)", () => {
    const d1 = freshDb();
    d1.exec("INSERT INTO contacts (email) VALUES ('c@example.com')");
    d1.exec("INSERT INTO tags (name) VALUES ('tas')");
    d1.exec("INSERT INTO contact_tags (contact_id, tag_id) VALUES (1, 1)");

    d1.exec("DELETE FROM tags WHERE name = 'tas'");

    expect(d1.sql("SELECT * FROM contact_tags")).toEqual([]);
  });

  it("cascades campaign_tags when the campaign is deleted", () => {
    const d1 = freshDb();
    d1.exec("INSERT INTO campaigns (name, from_email) VALUES ('c1', 'a@b.com')");
    d1.exec("INSERT INTO tags (name, scope) VALUES ('melbourne', 'campaign')");
    d1.exec("INSERT INTO campaign_tags (campaign_id, tag_id) VALUES (1, 1)");

    d1.exec("DELETE FROM campaigns WHERE id = 1");

    expect(d1.sql("SELECT * FROM campaign_tags")).toEqual([]);
  });
});

describe("tag API scopes", () => {
  it("keeps a 'melbourne' contact tag and a 'melbourne' campaign tag as separate rows", async () => {
    const d1 = freshDb();
    const { json, post } = makeApp(d1);

    const contactTag = await post("/api/tags", { name: "melbourne" });
    const campaignTag = await post("/api/tags?scope=campaign", { name: "melbourne" });

    expect(contactTag.scope).toBe("contact");
    expect(campaignTag.scope).toBe("campaign");
    expect(contactTag.id).not.toBe(campaignTag.id);
    expect(d1.sql<TagRow>("SELECT id, name, scope FROM tags ORDER BY id")).toEqual([
      { id: 1, name: "melbourne", scope: "contact" },
      { id: 2, name: "melbourne", scope: "campaign" },
    ]);

    // Each scope lists only its own tag.
    const contactList = await json("/api/tags");
    const campaignList = await json("/api/tags?scope=campaign");
    expect((contactList.rows as TagRow[]).map((r) => r.scope)).toEqual(["contact"]);
    expect((campaignList.rows as TagRow[]).map((r) => r.scope)).toEqual(["campaign"]);
  });

  it("defaults to the contact scope when no scope is given (existing callers unchanged)", async () => {
    const d1 = freshDb();
    const { call, json, post } = makeApp(d1);

    await post("/api/tags?scope=campaign", { name: "sydney" });

    // No scope: today's behaviour — contact tags only, with contact_count.
    const listed = await json("/api/tags");
    expect(listed.rows).toEqual([]);

    await post("/api/tags", { name: "tas" });
    const created = await json("/api/tags");
    expect(created.rows).toHaveLength(1);
    expect(created.rows[0]).toMatchObject({ name: "tas", scope: "contact", contact_count: 0 });

    const res = await call(`/api/tags/${created.rows[0].id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await json("/api/tags")).rows).toEqual([]);
    // The campaign tag is untouched by the unscoped delete.
    expect((await json("/api/tags?scope=campaign")).rows).toHaveLength(1);
  });

  it("refuses to delete a tag from the wrong scope", async () => {
    const d1 = freshDb();
    const { call, post } = makeApp(d1);

    const contactTag = await post("/api/tags", { name: "melbourne" });

    const res = await call(`/api/tags/${contactTag.id}?scope=campaign`, { method: "DELETE" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain("contact scope");
    expect(d1.sql("SELECT COUNT(*) AS n FROM tags")[0]).toEqual({ n: 1 });
  });

  it("creates the on-the-fly tag in the requested scope only", async () => {
    const d1 = freshDb();
    const { post } = makeApp(d1);

    await post("/api/contacts", { email: "p@example.com", tags: ["melbourne"] });
    await post("/api/campaigns", { name: "Melb", from_email: "a@b.com", tags: ["melbourne"] });

    expect(d1.sql<TagRow>("SELECT name, scope FROM tags ORDER BY id")).toEqual([
      { name: "melbourne", scope: "contact" },
      { name: "melbourne", scope: "campaign" },
    ]);
  });
});

describe("filtering never crosses scopes", () => {
  async function seed() {
    const d1 = freshDb();
    const app = makeApp(d1);
    await app.post("/api/contacts", { email: "tagged@example.com", tags: ["melbourne"] });
    await app.post("/api/contacts", { email: "plain@example.com" });
    await app.post("/api/campaigns", { name: "Melb campaign", from_email: "a@b.com", tags: ["melbourne"] });
    await app.post("/api/campaigns", { name: "Other campaign", from_email: "a@b.com" });
    return { d1, ...app };
  }

  it("filters contacts by a contact tag and campaigns by a campaign tag", async () => {
    const { json } = await seed();

    const contacts = await json("/api/contacts?tag=melbourne");
    expect((contacts.rows as any[]).map((r) => r.email)).toEqual(["tagged@example.com"]);

    const campaigns = await json("/api/campaigns?tag=melbourne");
    expect((campaigns.rows as any[]).map((r) => r.name)).toEqual(["Melb campaign"]);
    expect((campaigns.rows as any[])[0].tags).toEqual(["melbourne"]);
  });

  it("does not leak a campaign-only tag into the contacts filter", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    await app.post("/api/campaigns", { name: "Sydney campaign", from_email: "a@b.com", tags: ["sydney"] });
    await app.post("/api/contacts", { email: "x@example.com" });

    const contacts = await app.json("/api/contacts?tag=sydney");
    expect(contacts.rows).toEqual([]);
    // and the campaign tag is not offered by the contact-scope tag list
    const listed = await app.json("/api/tags");
    expect(listed.rows).toEqual([]);
  });

  it("does not leak a contact-only tag into the campaigns filter", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    await app.post("/api/contacts", { email: "x@example.com", tags: ["sydney"] });
    await app.post("/api/campaigns", { name: "Plain campaign", from_email: "a@b.com" });

    const campaigns = await app.json("/api/campaigns?tag=sydney");
    expect(campaigns.rows).toEqual([]);
    const listed = await app.json("/api/tags?scope=campaign");
    expect(listed.rows).toEqual([]);
  });

  it("ANDs multiple campaign tags", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    await app.post("/api/campaigns", { name: "Both", from_email: "a@b.com", tags: ["melbourne", "newsletter"] });
    await app.post("/api/campaigns", { name: "One", from_email: "a@b.com", tags: ["melbourne"] });

    const both = await app.json("/api/campaigns?tag=melbourne&tag=newsletter");
    expect((both.rows as any[]).map((r) => r.name)).toEqual(["Both"]);

    const any = await app.json("/api/campaigns?tag=melbourne&tag=newsletter&tag_mode=any");
    expect((any.rows as any[]).map((r) => r.name).sort()).toEqual(["Both", "One"]);
  });
});

describe("campaign tag endpoints", () => {
  it("reads and replaces a campaign's tags, creating missing ones", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const created = await app.post("/api/campaigns", { name: "C1", from_email: "a@b.com" });

    await app.json(`/api/campaigns/${created.id}/tags`, {
      method: "PUT",
      body: JSON.stringify({ tags: ["melbourne", "newsletter"] }),
    });
    expect((await app.json(`/api/campaigns/${created.id}/tags`)).tags).toEqual([
      "melbourne",
      "newsletter",
    ]);

    // Replacing drops the tags that are no longer selected.
    await app.json(`/api/campaigns/${created.id}/tags`, {
      method: "PUT",
      body: JSON.stringify({ tags: ["newsletter"] }),
    });
    expect((await app.json(`/api/campaigns/${created.id}/tags`)).tags).toEqual(["newsletter"]);
    // The tag itself survives — only the join was removed.
    const listed = await app.json("/api/tags?scope=campaign");
    expect((listed.rows as TagRow[]).map((r) => r.name)).toEqual(["melbourne", "newsletter"]);
  });

  it("returns a campaign's tags with the campaign row", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const created = await app.post("/api/campaigns", {
      name: "C2",
      from_email: "a@b.com",
      tags: ["melbourne"],
    });

    const row = await app.json(`/api/campaigns/${created.id}`);
    expect(row.row.tags).toEqual(["melbourne"]);
  });

  it("404s when tagging a campaign that does not exist", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const res = await app.call("/api/campaigns/999/tags", {
      method: "PUT",
      body: JSON.stringify({ tags: ["melbourne"] }),
    });
    expect(res.status).toBe(404);
  });
});
