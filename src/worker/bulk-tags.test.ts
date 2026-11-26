// The tag endpoints must work regardless of campaign status, and tagging must
// be possible in bulk. These tests run the real routes against an in-memory
// SQLite database (and the real migrations) so the SQL is what gets checked.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { Env } from "./types";
import { campaignsRoutes } from "./routes/campaigns";
import { tagsRoutes } from "./routes/tags";

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
];

function freshDb(): TestD1 {
  const d1 = createTestD1();
  applyMigrations(d1, FRESH);
  return d1;
}

function makeApp(d1: TestD1) {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/campaigns", campaignsRoutes);
  app.route("/api/tags", tagsRoutes);
  const env = { DB: d1 } as unknown as Env;
  const call = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://test${path}`, init), env);
  const json = async (path: string, init?: RequestInit) => (await call(path, init)).json() as any;
  return {
    call,
    json,
    post: (path: string, body: unknown) =>
      json(path, { method: "POST", body: JSON.stringify(body) }),
    put: (path: string, body: unknown) => json(path, { method: "PUT", body: JSON.stringify(body) }),
  };
}

describe("tagging a sent campaign", () => {
  it("accepts a tag write on a campaign that has already been sent", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const created = await app.post("/api/campaigns", { name: "Sent one", from_email: "a@b.com" });
    d1.exec(`UPDATE campaigns SET status='sent' WHERE id=${created.id}`);

    const res = await app.call(`/api/campaigns/${created.id}/tags`, {
      method: "PUT",
      body: JSON.stringify({ tags: ["newsletter"] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toMatchObject({ ok: true, tags: ["newsletter"] });

    // The tag sticks, and the campaign is still 'sent' — tagging is metadata.
    expect((await app.json(`/api/campaigns/${created.id}/tags`)).tags).toEqual(["newsletter"]);
    expect(
      d1.sql<{ status: string }>("SELECT status FROM campaigns WHERE id=?", created.id),
    ).toEqual([{ status: "sent" }]);
  });

  it("also removes tags on a sent campaign", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const created = await app.post("/api/campaigns", {
      name: "Sent two",
      from_email: "a@b.com",
      tags: ["newsletter"],
    });
    d1.exec(`UPDATE campaigns SET status='sent' WHERE id=${created.id}`);

    await app.put(`/api/campaigns/${created.id}/tags`, { tags: [] });
    expect((await app.json(`/api/campaigns/${created.id}/tags`)).tags).toEqual([]);
  });
});

describe("bulk campaign tagging", () => {
  it("adds a tag to every selected campaign and keeps existing tags", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const a = await app.post("/api/campaigns", { name: "A", from_email: "a@b.com" });
    const b = await app.post("/api/campaigns", { name: "B", from_email: "a@b.com", tags: ["old"] });
    const c = await app.post("/api/campaigns", { name: "C", from_email: "a@b.com" });

    const res = await app.call("/api/campaigns/bulk-tags", {
      method: "POST",
      body: JSON.stringify({ ids: [a.id, b.id, c.id], add: ["newsletter"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.summary).toEqual({ total: 3, ok: 3, failed: 0 });
    expect(body.results.map((r: any) => r.id)).toEqual([a.id, b.id, c.id]);
    expect(body.results.every((r: any) => r.ok)).toBe(true);

    // Every campaign carries the new tag; B keeps the one it already had.
    expect(
      d1.sql<{ id: number; tag: string }>(
        `SELECT ct.campaign_id AS id, t.name AS tag
         FROM campaign_tags ct JOIN tags t ON t.id = ct.tag_id
         WHERE t.scope='campaign' ORDER BY ct.campaign_id, t.name`,
      ),
    ).toEqual([
      { id: a.id, tag: "newsletter" },
      { id: b.id, tag: "newsletter" },
      { id: b.id, tag: "old" },
      { id: c.id, tag: "newsletter" },
    ]);
  });

  it("removes a tag from the selection only", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const a = await app.post("/api/campaigns", {
      name: "A",
      from_email: "a@b.com",
      tags: ["newsletter", "keep"],
    });
    const b = await app.post("/api/campaigns", {
      name: "B",
      from_email: "a@b.com",
      tags: ["newsletter"],
    });

    const body = await app.post("/api/campaigns/bulk-tags", {
      ids: [a.id],
      remove: ["newsletter"],
    });
    expect(body.summary).toEqual({ total: 1, ok: 1, failed: 0 });
    expect((await app.json(`/api/campaigns/${a.id}/tags`)).tags).toEqual(["keep"]);
    // The unselected campaign is untouched.
    expect((await app.json(`/api/campaigns/${b.id}/tags`)).tags).toEqual(["newsletter"]);
  });

  it("reports a failure per campaign and still tags the rest", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const a = await app.post("/api/campaigns", { name: "A", from_email: "a@b.com" });
    const c = await app.post("/api/campaigns", { name: "C", from_email: "a@b.com" });
    const missingId = 9999;

    const body = await app.post("/api/campaigns/bulk-tags", {
      ids: [a.id, missingId, c.id],
      add: ["x"],
    });
    expect(body.summary).toEqual({ total: 3, ok: 2, failed: 1 });

    const byId = new Map<number, any>(body.results.map((r: any) => [r.id, r]));
    expect(byId.get(a.id).ok).toBe(true);
    expect(byId.get(missingId).ok).toBe(false);
    expect(byId.get(missingId).error).toContain("not found");
    expect(byId.get(c.id).ok).toBe(true);

    // The failure did not abort the campaigns after it.
    expect((await app.json(`/api/campaigns/${c.id}/tags`)).tags).toEqual(["x"]);
  });

  it("rejects a request that names no tag at all", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const a = await app.post("/api/campaigns", { name: "A", from_email: "a@b.com" });

    const res = await app.call("/api/campaigns/bulk-tags", {
      method: "POST",
      body: JSON.stringify({ ids: [a.id] }),
    });
    expect(res.status).toBe(400);
  });
});

describe("bulk tagging stays inside the campaign scope", () => {
  it("creates and assigns a campaign-scope tag, never the contact one", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    // A contact tag of the same name already exists.
    await app.post("/api/tags", { name: "melbourne" });
    const a = await app.post("/api/campaigns", { name: "A", from_email: "a@b.com" });

    await app.post("/api/campaigns/bulk-tags", { ids: [a.id], add: ["melbourne"] });

    // Two independent rows, one per scope.
    expect(
      d1.sql<{ name: string; scope: string }>("SELECT name, scope FROM tags ORDER BY scope"),
    ).toEqual([
      { name: "melbourne", scope: "campaign" },
      { name: "melbourne", scope: "contact" },
    ]);
    // The picker (campaign scope) offers it; the contact list is untouched.
    expect((await app.json("/api/tags?scope=campaign")).rows.map((r: any) => r.name)).toEqual([
      "melbourne",
    ]);
    expect((await app.json("/api/tags")).rows.map((r: any) => r.name)).toEqual(["melbourne"]);
    expect(d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM tags WHERE scope='contact'")).toEqual([
      { n: 1 },
    ]);
  });

  it("cannot remove a contact-only tag through the campaign bulk path", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    await app.post("/api/tags", { name: "tas" });
    const a = await app.post("/api/campaigns", {
      name: "A",
      from_email: "a@b.com",
      tags: ["newsletter"],
    });

    const body = await app.post("/api/campaigns/bulk-tags", { ids: [a.id], remove: ["tas"] });
    expect(body.summary).toEqual({ total: 1, ok: 1, failed: 0 });
    // Nothing of the campaign's own tags was touched...
    expect((await app.json(`/api/campaigns/${a.id}/tags`)).tags).toEqual(["newsletter"]);
    // ...and the contact tag still exists.
    expect((await app.json("/api/tags")).rows.map((r: any) => r.name)).toEqual(["tas"]);
  });
});
