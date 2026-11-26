import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";

export const tagsRoutes = new Hono<{ Bindings: Env }>();

/**
 * Tags live in two independent namespaces. A "melbourne" contact tag and a
 * "melbourne" campaign tag are different rows with different ids, so they can
 * never be confused with one another.
 *
 * Default is "contact" so every existing caller keeps working unchanged.
 */
export type TagScope = "contact" | "campaign";

export function parseScope(raw: unknown): TagScope {
  return raw === "campaign" ? "campaign" : "contact";
}

tagsRoutes.get("/", async (c) => {
  const scope = parseScope(c.req.query("scope"));
  const rows =
    scope === "campaign"
      ? await c.env.DB.prepare(
          `SELECT t.id, t.name, t.color, t.scope, COUNT(ct.campaign_id) AS campaign_count
           FROM tags t LEFT JOIN campaign_tags ct ON ct.tag_id = t.id
           WHERE t.scope = 'campaign'
           GROUP BY t.id ORDER BY t.name`,
        ).all<any>()
      : await c.env.DB.prepare(
          `SELECT t.id, t.name, t.color, t.scope, COUNT(ct.contact_id) AS contact_count
           FROM tags t LEFT JOIN contact_tags ct ON ct.tag_id = t.id
           WHERE t.scope = 'contact'
           GROUP BY t.id ORDER BY t.name`,
        ).all<any>();
  // Keep one response shape for both scopes: the unused count is 0.
  const out = rows.results.map((r: any) => ({
    ...r,
    contact_count: Number(r.contact_count ?? 0),
    campaign_count: Number(r.campaign_count ?? 0),
  }));
  return c.json({ rows: out, scope });
});

const createSchema = z.object({
  name: z.string().min(1).max(64),
  color: z.string().optional(),
  scope: z.enum(["contact", "campaign"]).optional(),
});
tagsRoutes.post("/", async (c) => {
  const parsed = createSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const scope = parseScope(c.req.query("scope") ?? parsed.data.scope);
  const r = await c.env.DB.prepare(
    `INSERT INTO tags (name, color, scope) VALUES (?, ?, ?)
     ON CONFLICT(name, scope) DO UPDATE SET color = COALESCE(excluded.color, tags.color)
     RETURNING id`,
  )
    .bind(parsed.data.name, parsed.data.color ?? null, scope)
    .first<{ id: number }>();
  return c.json({ id: r?.id, scope });
});

tagsRoutes.delete("/:id", async (c) => {
  const scope = parseScope(c.req.query("scope"));
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare("SELECT id, scope FROM tags WHERE id=?")
    .bind(id)
    .first<{ id: number; scope: string }>();
  if (!row) return c.json({ ok: true, deleted: 0 });
  // Never let a campaign-scope call delete a contact tag (or vice versa).
  if (row.scope !== scope) {
    return c.json({ error: `tag ${id} is in the ${row.scope} scope, not ${scope}` }, 400);
  }
  await c.env.DB.prepare("DELETE FROM tags WHERE id=? AND scope=?").bind(id, scope).run();
  return c.json({ ok: true, deleted: 1 });
});

/**
 * Create-or-find a tag inside one scope. Used by the assignment paths so a tag
 * typed in the UI exists as soon as it is used.
 */
export async function ensureTag(env: Env, name: string, scope: TagScope): Promise<number | null> {
  const r = await env.DB.prepare(
    `INSERT INTO tags (name, scope) VALUES (?, ?)
     ON CONFLICT(name, scope) DO UPDATE SET name=excluded.name
     RETURNING id`,
  )
    .bind(name, scope)
    .first<{ id: number }>();
  return r?.id ?? null;
}

/**
 * Replace a campaign's tag set. Names are trimmed, de-duplicated (case-insensitive)
 * and created in the campaign scope if they do not exist yet.
 */
export async function setCampaignTags(env: Env, campaignId: number, names: string[]): Promise<string[]> {
  const wanted: string[] = [];
  for (const raw of names ?? []) {
    const name = String(raw ?? "").trim();
    if (!name) continue;
    if (!wanted.some((n) => n.toLowerCase() === name.toLowerCase())) wanted.push(name);
  }
  const ids: number[] = [];
  for (const name of wanted) {
    const id = await ensureTag(env, name, "campaign");
    if (id) ids.push(id);
  }
  await env.DB.prepare("DELETE FROM campaign_tags WHERE campaign_id=?").bind(campaignId).run();
  if (ids.length) {
    await env.DB.batch(
      ids.map((tagId) =>
        env.DB.prepare("INSERT OR IGNORE INTO campaign_tags (campaign_id, tag_id) VALUES (?, ?)").bind(
          campaignId,
          tagId,
        ),
      ),
    );
  }
  return wanted;
}

/** Tag names for a campaign, from the campaign scope only. */
export async function listCampaignTags(env: Env, campaignId: number): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT t.name FROM campaign_tags ct JOIN tags t ON t.id = ct.tag_id
     WHERE ct.campaign_id = ? AND t.scope = 'campaign' ORDER BY t.name`,
  )
    .bind(campaignId)
    .all<{ name: string }>();
  return rows.results.map((r) => r.name);
}

// Bulk assign/unassign tags — always contact-scoped.
const assignSchema = z.object({
  contact_ids: z.array(z.number().int()).min(1).max(5000),
  tags: z.array(z.string().min(1)).min(1),
  remove: z.boolean().optional(),
});
tagsRoutes.post("/assign", async (c) => {
  const parsed = assignSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { contact_ids, tags, remove } = parsed.data;

  // Resolve tag ids (create if missing when assigning) — contact scope only.
  const tagIds: number[] = [];
  for (const name of tags) {
    if (remove) {
      const r = await c.env.DB.prepare("SELECT id FROM tags WHERE name=? AND scope='contact'")
        .bind(name)
        .first<{ id: number }>();
      if (r) tagIds.push(r.id);
    } else {
      const id = await ensureTag(c.env, name, "contact");
      if (id) tagIds.push(id);
    }
  }
  if (!tagIds.length) return c.json({ ok: true, changed: 0 });

  const stmts: D1PreparedStatement[] = [];
  for (const cid of contact_ids) {
    for (const tid of tagIds) {
      stmts.push(
        remove
          ? c.env.DB.prepare("DELETE FROM contact_tags WHERE contact_id=? AND tag_id=?").bind(cid, tid)
          : c.env.DB.prepare("INSERT OR IGNORE INTO contact_tags (contact_id, tag_id) VALUES (?, ?)").bind(cid, tid),
      );
    }
  }
  // Batch in chunks to stay within D1 limits
  const CHUNK = 50;
  for (let i = 0; i < stmts.length; i += CHUNK) {
    await c.env.DB.batch(stmts.slice(i, i + CHUNK));
  }
  return c.json({ ok: true, changed: stmts.length });
});
