import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { timezoneForState } from "../../shared/timezone";

export const importsRoutes = new Hono<{ Bindings: Env }>();

importsRoutes.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM import_jobs ORDER BY id DESC LIMIT 50",
  ).all();
  return c.json({ rows: rows.results });
});

async function ensureTagIds(env: Env, tags: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const name of tags) {
    const t = await env.DB.prepare(
      "INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name=excluded.name RETURNING id",
    ).bind(name).first<{ id: number }>();
    if (t) ids.push(t.id);
  }
  return ids;
}

async function attachContactToListAndTags(
  env: Env,
  contactId: number,
  listId: number | null,
  tagIds: number[],
) {
  const stmts: D1PreparedStatement[] = [];
  if (listId) {
    stmts.push(
      env.DB.prepare("INSERT OR IGNORE INTO list_members (list_id, contact_id) VALUES (?, ?)").bind(listId, contactId),
    );
  }
  for (const tid of tagIds) {
    stmts.push(
      env.DB.prepare("INSERT OR IGNORE INTO contact_tags (contact_id, tag_id) VALUES (?, ?)").bind(contactId, tid),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
}

const csvSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).max(20000),
  map: z.object({
    email: z.string(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    practice_name: z.string().optional(),
  }),
  source: z.string().default("csv"),
  target_list_id: z.number().int().nullable().optional(),
  tags: z.array(z.string()).optional(),
});

importsRoutes.post("/csv", async (c) => {
  const parsed = csvSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { rows, map, source, target_list_id, tags } = parsed.data;

  const job = await c.env.DB.prepare(
    "INSERT INTO import_jobs (type, status, total, config) VALUES ('csv','running',?,?)",
  )
    .bind(rows.length, JSON.stringify({ map, source, target_list_id, tags }))
    .run();
  const jobId = job.meta.last_row_id;

  const tagIds = tags?.length ? await ensureTagIds(c.env, tags) : [];

  let inserted = 0;
  let skipped = 0;
  const used = new Set(Object.values(map));

  for (const row of rows) {
    const email = String(row[map.email] ?? "").trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      skipped++;
      continue;
    }
    const extras: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) if (!used.has(k)) extras[k] = v;

    const tz = timezoneForState(
      (extras as any).state ?? (extras as any).State ?? (row as any).state ?? (row as any).State ?? null,
    );

    const r = await c.env.DB.prepare(
      `INSERT INTO contacts (email, first_name, last_name, practice_name, attributes, source, email_status, timezone)
       VALUES (?,?,?,?,?,?, 'pending', ?)
       ON CONFLICT(email) DO UPDATE SET
         first_name=COALESCE(excluded.first_name, contacts.first_name),
         last_name=COALESCE(excluded.last_name, contacts.last_name),
         practice_name=COALESCE(excluded.practice_name, contacts.practice_name),
         attributes=excluded.attributes,
         source=excluded.source,
         timezone=COALESCE(contacts.timezone, excluded.timezone),
         status=CASE WHEN contacts.status IN ('unsubscribed','complained','bounced') THEN contacts.status ELSE 'active' END,
         email_status=COALESCE(contacts.email_status, 'pending'),
         updated_at=unixepoch()
       RETURNING id`,
    )
      .bind(
        email,
        map.first_name ? (row[map.first_name] as string) ?? null : null,
        map.last_name ? (row[map.last_name] as string) ?? null : null,
        map.practice_name ? (row[map.practice_name] as string) ?? null : null,
        JSON.stringify(extras),
        source,
        tz,
      )
      .first<{ id: number }>();

    inserted++;
    if (r && (target_list_id || tagIds.length)) {
      await attachContactToListAndTags(c.env, r.id, target_list_id ?? null, tagIds);
    }
  }

  await c.env.DB.prepare(
    "UPDATE import_jobs SET status='done', processed=?, inserted=?, skipped=?, finished_at=unixepoch() WHERE id=?",
  )
    .bind(rows.length, inserted, skipped, jobId)
    .run();

  return c.json({ id: jobId, total: rows.length, inserted, skipped });
});

const d1ImportSchema = z.object({
  table: z.string().regex(/^[A-Za-z0-9_]+$/),
  map: z.object({
    email: z.string().regex(/^[A-Za-z0-9_]+$/),
    first_name: z.string().regex(/^[A-Za-z0-9_]+$/).optional(),
    last_name: z.string().regex(/^[A-Za-z0-9_]+$/).optional(),
    practice_name: z.string().regex(/^[A-Za-z0-9_]+$/).optional(),
  }),
  limit: z.number().int().positive().max(50000).default(10000),
  target_list_id: z.number().int().nullable().optional(),
  tags: z.array(z.string()).optional(),
});

importsRoutes.post("/d1", async (c) => {
  if (!c.env.SOURCE_DB) return c.json({ error: "SOURCE_DB binding not configured" }, 400);
  const parsed = d1ImportSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { table, map, limit, target_list_id, tags } = parsed.data;

  const src = await c.env.SOURCE_DB.prepare(
    `SELECT * FROM ${table} LIMIT ?`,
  )
    .bind(limit)
    .all<Record<string, any>>();
  const used = new Set<string>([
    map.email,
    ...(map.first_name ? [map.first_name] : []),
    ...(map.last_name ? [map.last_name] : []),
    ...(map.practice_name ? [map.practice_name] : []),
  ]);

  const job = await c.env.DB.prepare(
    "INSERT INTO import_jobs (type,status,total,config) VALUES ('d1','running',?,?)",
  )
    .bind(src.results.length, JSON.stringify({ table, map, target_list_id, tags }))
    .run();
  const jobId = job.meta.last_row_id;

  const tagIds = tags?.length ? await ensureTagIds(c.env, tags) : [];
  let inserted = 0;
  let skipped = 0;

  for (const row of src.results) {
    const email = String(row[map.email] ?? "").trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      skipped++;
      continue;
    }
    const extras: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) if (!used.has(k)) extras[k] = v;

    const tz = timezoneForState(
      (extras as any).state ?? (extras as any).State ?? (row as any).state ?? (row as any).State ?? null,
    );

    const r = await c.env.DB.prepare(
      `INSERT INTO contacts (email, first_name, last_name, practice_name, attributes, source, email_status, timezone)
       VALUES (?,?,?,?,?, 'd1-import', 'pending', ?)
       ON CONFLICT(email) DO UPDATE SET
         first_name=COALESCE(excluded.first_name, contacts.first_name),
         last_name=COALESCE(excluded.last_name, contacts.last_name),
         practice_name=COALESCE(excluded.practice_name, contacts.practice_name),
         attributes=excluded.attributes,
         source=excluded.source,
         timezone=COALESCE(contacts.timezone, excluded.timezone),
         status=CASE WHEN contacts.status IN ('unsubscribed','complained','bounced') THEN contacts.status ELSE 'active' END,
         email_status=COALESCE(contacts.email_status, 'pending'),
         updated_at=unixepoch()
       RETURNING id`,
    )
      .bind(
        email,
        map.first_name ? row[map.first_name] ?? null : null,
        map.last_name ? row[map.last_name] ?? null : null,
        map.practice_name ? row[map.practice_name] ?? null : null,
        JSON.stringify(extras),
        tz,
      )
      .first<{ id: number }>();
    inserted++;
    if (r && (target_list_id || tagIds.length)) {
      await attachContactToListAndTags(c.env, r.id, target_list_id ?? null, tagIds);
    }
  }

  await c.env.DB.prepare(
    "UPDATE import_jobs SET status='done', processed=?, inserted=?, skipped=?, finished_at=unixepoch() WHERE id=?",
  )
    .bind(src.results.length, inserted, skipped, jobId)
    .run();
  return c.json({ id: jobId, total: src.results.length, inserted, skipped });
});
