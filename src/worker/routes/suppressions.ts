import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";

export const suppressionsRoutes = new Hono<{ Bindings: Env }>();

suppressionsRoutes.get("/", async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const pageSize = Math.min(200, Number(c.req.query("pageSize") ?? 100));
  const offset = (page - 1) * pageSize;
  const where = q ? "WHERE email LIKE ?" : "";
  const binds = q ? [`%${q}%`] : [];
  const [rows, count] = await Promise.all([
    c.env.DB.prepare(`SELECT * FROM suppressions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(...binds, pageSize, offset)
      .all(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM suppressions ${where}`)
      .bind(...binds)
      .first<{ n: number }>(),
  ]);
  return c.json({ rows: rows.results, total: count?.n ?? 0, page, pageSize });
});

suppressionsRoutes.post("/", async (c) => {
  const schema = z.object({ email: z.string().email(), reason: z.string().default("manual") });
  const parsed = schema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO suppressions (email, reason, source) VALUES (?,?, 'manual') ON CONFLICT(email) DO UPDATE SET reason=excluded.reason",
    ).bind(parsed.data.email.toLowerCase(), parsed.data.reason),
    c.env.DB.prepare("UPDATE contacts SET status='unsubscribed' WHERE email=?").bind(
      parsed.data.email.toLowerCase(),
    ),
  ]);
  return c.json({ ok: true });
});

suppressionsRoutes.delete("/:email", async (c) => {
  const email = c.req.param("email").toLowerCase();
  await c.env.DB.prepare("DELETE FROM suppressions WHERE email = ?").bind(email).run();
  return c.json({ ok: true });
});
