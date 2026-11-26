import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { syncSourceTable, syncAll } from "../sync";

export const sourceDbRoutes = new Hono<{ Bindings: Env }>();

const IDENT = /^[A-Za-z0-9_]+$/;

sourceDbRoutes.get("/tables", async (c) => {
  if (!c.env.SOURCE_DB) return c.json({ rows: [], error: "SOURCE_DB binding not configured" });
  const res = await c.env.SOURCE_DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all<{ name: string }>();
  return c.json({ rows: res.results });
});

sourceDbRoutes.get("/columns", async (c) => {
  if (!c.env.SOURCE_DB) return c.json({ rows: [], error: "SOURCE_DB binding not configured" });
  const table = c.req.query("table")?.trim() ?? "";
  if (!IDENT.test(table)) return c.json({ rows: [], error: "Invalid table" }, 400);
  const res = await c.env.SOURCE_DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string; type: string }>();
  return c.json({ rows: res.results });
});

sourceDbRoutes.get("/values", async (c) => {
  if (!c.env.SOURCE_DB) return c.json({ rows: [] });
  const table = c.req.query("table")?.trim() ?? "";
  const column = c.req.query("column")?.trim() ?? "";
  const q = c.req.query("q")?.trim() ?? "";
  if (!IDENT.test(table) || !IDENT.test(column)) return c.json({ rows: [] }, 400);
  const info = await c.env.SOURCE_DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  if (!info.results.some((r) => String(r.name) === column)) return c.json({ rows: [] }, 400);
  const where: string[] = [`${column} IS NOT NULL`, `${column} != ''`];
  const binds: any[] = [];
  if (q) { where.push(`${column} LIKE ?`); binds.push(`%${q}%`); }
  const sql = `SELECT DISTINCT ${column} AS value FROM ${table} WHERE ${where.join(" AND ")} LIMIT 50`;
  const res = await c.env.SOURCE_DB.prepare(sql).bind(...binds).all<{ value: any }>();
  return c.json({ rows: res.results });
});

// ---------- Mirror config (import-first source tables) ----------

sourceDbRoutes.get("/mirrors", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, table_name, email_column, active, cron_enabled, last_synced_at, last_row_count, last_error, created_at FROM source_tables ORDER BY id",
  ).all();
  return c.json({ rows: rows.results });
});

const mirrorSchema = z.object({
  table_name: z.string().regex(IDENT),
  email_column: z.string().regex(IDENT),
  active: z.boolean().optional(),
  cron_enabled: z.boolean().optional(),
});

sourceDbRoutes.post("/mirrors", async (c) => {
  const parsed = mirrorSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const d = parsed.data;
  const r = await c.env.DB.prepare(
    `INSERT INTO source_tables (table_name, email_column, active, cron_enabled)
     VALUES (?,?,?,?)
     ON CONFLICT(table_name) DO UPDATE SET
       email_column = excluded.email_column,
       active       = excluded.active,
       cron_enabled = excluded.cron_enabled
     RETURNING id`,
  )
    .bind(d.table_name, d.email_column, d.active === false ? 0 : 1, d.cron_enabled === false ? 0 : 1)
    .first<{ id: number }>();
  return c.json({ ok: true, id: r?.id });
});

sourceDbRoutes.patch("/mirrors/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const parsed = mirrorSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const sets: string[] = [];
  const binds: any[] = [];
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    sets.push(`${k}=?`);
    binds.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
  }
  if (!sets.length) return c.json({ ok: true });
  binds.push(id);
  await c.env.DB.prepare(`UPDATE source_tables SET ${sets.join(", ")} WHERE id=?`).bind(...binds).run();
  return c.json({ ok: true });
});

sourceDbRoutes.delete("/mirrors/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM source_tables WHERE id=?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

sourceDbRoutes.post("/mirrors/:id/sync", async (c) => {
  const id = Number(c.req.param("id"));
  const cfg = await c.env.DB.prepare(
    "SELECT id, table_name, email_column FROM source_tables WHERE id=?",
  ).bind(id).first<{ id: number; table_name: string; email_column: string }>();
  if (!cfg) return c.json({ error: "not found" }, 404);
  try {
    const r = await syncSourceTable(c.env, cfg);
    return c.json({ ok: true, result: r });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    await c.env.DB.prepare("UPDATE source_tables SET last_error=? WHERE id=?").bind(msg, id).run();
    return c.json({ error: msg }, 500);
  }
});

sourceDbRoutes.post("/sync-all", async (c) => {
  const r = await syncAll(c.env);
  return c.json({ ok: true, results: r });
});
