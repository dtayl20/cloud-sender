import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { extractTemplateVars } from "../smtp2go";

export const templatesRoutes = new Hono<{ Bindings: Env }>();

templatesRoutes.get("/:id/vars", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare(
    "SELECT subject, html, text FROM templates WHERE id = ?",
  )
    .bind(id)
    .first<{ subject: string; html: string; text: string | null }>();
  if (!row) return c.json({ error: "not found" }, 404);
  const vars = extractTemplateVars(row.subject ?? "", row.html ?? "", row.text ?? "");
  return c.json({ vars });
});

templatesRoutes.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, source, external_id, name, subject, is_base, updated_at FROM templates ORDER BY updated_at DESC",
  ).all();
  return c.json({ rows: rows.results });
});

templatesRoutes.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare("SELECT * FROM templates WHERE id = ?").bind(id).first();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ row });
});

const schema = z.object({
  name: z.string().min(1),
  subject: z.string(),
  html: z.string(),
  text: z.string().optional(),
  source: z.enum(["local", "smtp2go"]).default("local"),
  external_id: z.string().optional(),
  // 1 = base template: supplies the chrome, campaigns inject their body at {{content}}.
  is_base: z.coerce.number().int().min(0).max(1).optional(),
});

templatesRoutes.post("/:id/duplicate", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare(
    "SELECT name, subject, html, text, is_base FROM templates WHERE id = ?",
  )
    .bind(id)
    .first<{ name: string; subject: string; html: string; text: string | null; is_base: number }>();
  if (!row) return c.json({ error: "not found" }, 404);
  const r = await c.env.DB.prepare(
    "INSERT INTO templates (source, external_id, name, subject, html, text, is_base) VALUES ('local', NULL, ?, ?, ?, ?, ?)",
  )
    .bind(
      `${row.name} (copy)`,
      row.subject ?? "",
      row.html ?? "",
      row.text ?? null,
      row.is_base ?? 0,
    )
    .run();
  return c.json({ id: r.meta.last_row_id });
});

templatesRoutes.post("/", async (c) => {
  const parsed = schema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const d = parsed.data;
  const r = await c.env.DB.prepare(
    "INSERT INTO templates (source, external_id, name, subject, html, text, is_base) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(
      d.source,
      d.external_id ?? null,
      d.name,
      d.subject,
      d.html,
      d.text ?? null,
      d.is_base ?? 0,
    )
    .run();
  return c.json({ id: r.meta.last_row_id });
});


templatesRoutes.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const parsed = schema.partial().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const sets: string[] = [];
  const binds: any[] = [];
  for (const [k, v] of Object.entries(parsed.data)) {
    sets.push(`${k} = ?`);
    binds.push(v);
  }
  sets.push("updated_at = unixepoch()");
  binds.push(id);
  await c.env.DB.prepare(`UPDATE templates SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  return c.json({ ok: true });
});

templatesRoutes.delete("/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM templates WHERE id = ?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});
