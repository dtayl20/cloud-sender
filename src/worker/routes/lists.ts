import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { buildAudienceQuery, countSegment, normalizeSegmentFilter, segmentFilterSchema } from "../audience";

export const listsRoutes = new Hono<{ Bindings: Env }>();

listsRoutes.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT l.id, l.name, l.kind, l.filter_json, l.created_at,
            (SELECT COUNT(*) FROM list_members lm WHERE lm.list_id = l.id) AS member_count
     FROM lists l ORDER BY l.id DESC`,
  ).all();
  return c.json({ rows: rows.results });
});

const createSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(["static", "segment"]).default("static"),
  filter: segmentFilterSchema.optional(),
});
listsRoutes.post("/", async (c) => {
  const parsed = createSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const r = await c.env.DB.prepare(
    "INSERT INTO lists (name, kind, filter_json) VALUES (?,?,?)",
  )
    .bind(parsed.data.name, parsed.data.kind, parsed.data.filter ? JSON.stringify(parsed.data.filter) : null)
    .run();
  return c.json({ id: r.meta.last_row_id });
});

listsRoutes.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const parsed = createSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const sets: string[] = [];
  const binds: any[] = [];
  if (parsed.data.name !== undefined) { sets.push("name=?"); binds.push(parsed.data.name); }
  if (parsed.data.kind !== undefined) { sets.push("kind=?"); binds.push(parsed.data.kind); }
  if (parsed.data.filter !== undefined) { sets.push("filter_json=?"); binds.push(JSON.stringify(parsed.data.filter)); }
  if (!sets.length) return c.json({ ok: true });
  binds.push(id);
  await c.env.DB.prepare(`UPDATE lists SET ${sets.join(", ")} WHERE id=?`).bind(...binds).run();
  return c.json({ ok: true });
});

listsRoutes.delete("/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM lists WHERE id=?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// Preview audience count for a list or segment
listsRoutes.get("/:id/count", async (c) => {
  const id = Number(c.req.param("id"));
  const list = await c.env.DB.prepare("SELECT * FROM lists WHERE id=?").bind(id).first<any>();
  if (!list) return c.json({ count: 0 });
  if (list.kind === "segment") {
    const filter = list.filter_json ? JSON.parse(list.filter_json) : {};
    const { count, warnings, degraded } = await countSegment(c.env, filter);
    return c.json({ count, warnings, degraded });
  }
  const r = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM list_members lm
     JOIN contacts c ON c.id = lm.contact_id
     WHERE lm.list_id = ? AND c.status='active'
       AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = c.email)`,
  )
    .bind(id)
    .first<{ n: number }>();
  return c.json({ count: r?.n ?? 0 });
});

/**
 * CSV cell per RFC 4180: quote when the value contains a delimiter, quote or
 * line break, and double any inner quotes. Objects/arrays (attributes such as
 * `services` or `profile`) are serialised as JSON, never "[object Object]".
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (typeof value === "object") {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  } else {
    s = String(value);
  }
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Attribute keys that never leave in an export. `api_key` is a per-clinic
 * profile credential and `verification_token` is the token used to prove
 * control of a listing — exporting either would spread secrets into a
 * spreadsheet that gets emailed around.
 */
const EXPORT_EXCLUDED_ATTRS = new Set(["api_key", "verification_token"]);

/** Written for every export, so a verification audit always has them. */
const EXPORT_VERIFICATION_COLUMNS = ["email_status", "email_verified_at"];

const EXPORT_FIXED_HEAD = ["email", "practice_name", "first_name", "last_name"];
const EXPORT_FIXED_TAIL = ["status", "source", "source_table", "created_at"];

function csvFilename(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "list";
  return `${slug}-${new Date().toISOString().slice(0, 10)}.csv`;
}

/** Unix seconds as an ISO stamp; blank for a missing/zero value. */
function isoSeconds(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : "";
}

/**
 * Export a list or segment as CSV. Static lists export their members as they
 * are (every status, not just active) because this is a record dump, not an
 * audience; segments resolve their rules the same way a send would.
 */
listsRoutes.get("/:id/export", async (c) => {
  const id = Number(c.req.param("id"));
  const list = await c.env.DB.prepare("SELECT id, name, kind, filter_json FROM lists WHERE id=?")
    .bind(id)
    .first<{ id: number; name: string; kind: string; filter_json: string | null }>();
  if (!list) return c.json({ error: "List not found" }, 404);

  let contactRows: any[];
  if (list.kind === "segment") {
    let raw: unknown = {};
    try {
      raw = list.filter_json ? JSON.parse(list.filter_json) : {};
    } catch {}
    const { filter, warnings, degraded } = normalizeSegmentFilter(raw);
    if (degraded) return c.json({ error: warnings[0] ?? "Segment could not be evaluated" }, 400);
    const q = buildAudienceQuery(filter, false);
    const res = await c.env.DB.prepare(
      `SELECT c.* FROM contacts c WHERE c.id IN (SELECT s.id FROM (${q.sql}) s) ORDER BY c.email`,
    )
      .bind(...q.binds)
      .all<any>();
    contactRows = res.results;
  } else {
    const res = await c.env.DB.prepare(
      `SELECT c.* FROM list_members lm JOIN contacts c ON c.id = lm.contact_id
       WHERE lm.list_id = ? ORDER BY c.email`,
    )
      .bind(id)
      .all<any>();
    contactRows = res.results;
  }

  // Attribute keys live per contact, so the sheet's columns are the union across
  // the export — verification first, the rest alphabetically.
  const parsed = contactRows.map((row) => {
    let attrs: Record<string, unknown> = {};
    try {
      const o = JSON.parse(row.attributes || "{}");
      if (o && typeof o === "object" && !Array.isArray(o)) attrs = o;
    } catch {}
    return { row, attrs };
  });
  const attrKeys = new Set<string>();
  for (const { attrs } of parsed) {
    for (const k of Object.keys(attrs)) if (!EXPORT_EXCLUDED_ATTRS.has(k)) attrKeys.add(k);
  }
  const extraAttrs = [...attrKeys].sort((a, b) => a.localeCompare(b));

  const header = [...EXPORT_FIXED_HEAD, ...EXPORT_VERIFICATION_COLUMNS, ...extraAttrs, ...EXPORT_FIXED_TAIL];
  const lines = [header.map(csvCell).join(",")];
  for (const { row, attrs } of parsed) {
    const values: unknown[] = [
      ...EXPORT_FIXED_HEAD.map((k) => row[k]),
      ...EXPORT_VERIFICATION_COLUMNS.map((k) => (k === "email_verified_at" ? isoSeconds(row[k]) : row[k])),
      ...extraAttrs.map((k) => attrs[k]),
      ...EXPORT_FIXED_TAIL.map((k) => (k === "created_at" ? isoSeconds(row[k]) : row[k])),
    ];
    lines.push(values.map(csvCell).join(","));
  }

  // BOM so Excel opens UTF-8 clinic names without mojibake.
  const body = "\uFEFF" + lines.join("\r\n") + "\r\n";
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename(list.name)}"`,
      "Cache-Control": "no-store",
    },
  });
});

// Add contacts to a static list
const membersSchema = z.object({ contact_ids: z.array(z.number().int()).min(1).max(5000) });
listsRoutes.post("/:id/members", async (c) => {
  const id = Number(c.req.param("id"));
  const parsed = membersSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const stmts = parsed.data.contact_ids.map((cid) =>
    c.env.DB.prepare("INSERT OR IGNORE INTO list_members (list_id, contact_id) VALUES (?, ?)").bind(id, cid),
  );
  const CHUNK = 50;
  for (let i = 0; i < stmts.length; i += CHUNK) {
    await c.env.DB.batch(stmts.slice(i, i + CHUNK));
  }
  return c.json({ ok: true });
});

// Preview an ad-hoc segment filter (used by builder UI)
listsRoutes.post("/preview", async (c) => {
  const raw = await c.req.json();
  const { count, warnings, degraded } = await countSegment(c.env, raw);
  return c.json({ count, warnings, degraded });
});
