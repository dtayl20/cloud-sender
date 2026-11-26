import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { resolveSegmentRows, buildAudienceQuery, normalizeSegmentFilter } from "../audience";
import { ensureTag } from "./tags";
import { getStaleDays } from "../emailVerify";
import { CREDITS_REMAINING_SETTING_KEY, staleBeforeSeconds } from "../../shared/emailStatus";
import { timezoneForState } from "../../shared/timezone";

export const contactsRoutes = new Hono<{ Bindings: Env }>();

interface ContactsFilter {
  /** "" or "WHERE ...", always aliased on `contacts c`. */
  whereSql: string;
  binds: any[];
  warnings: string[];
  /** A resolved segment could not be evaluated - fail safe, match nothing. */
  degraded: boolean;
  /** A resolved segment matched no contacts at all. */
  empty: boolean;
}

/**
 * The Contacts list filter, shared by the list endpoint and the bulk-verify
 * action so "all contacts matching the current filter" means exactly what the
 * page is showing. `staleCutoff` is threaded in so the 'stale' option uses the
 * same cadence as the pass and the counts.
 */
async function buildContactsFilter(
  env: Env,
  params: URLSearchParams,
  staleCutoff: number,
): Promise<ContactsFilter> {
  const q = (params.get("q") ?? "").trim();
  const status = params.get("status");
  const emailStatus = params.get("email_status");
  const list = params.get("list");
  let tagParams = params.getAll("tag");
  const tagMode = params.get("tag_mode") === "all" ? "all" : "any";

  // Segment list: resolve to a local contact-id set via resolveSegmentRows.
  let segmentIds: number[] | null = null;
  let warnings: string[] = [];
  if (list) {
    const listRow = await env.DB.prepare("SELECT id, kind, filter_json FROM lists WHERE id=?")
      .bind(Number(list))
      .first<{ id: number; kind: string; filter_json: string | null }>();
    if (listRow?.kind === "segment") {
      const raw = listRow.filter_json ? JSON.parse(listRow.filter_json) : {};
      const res = await resolveSegmentRows(env, raw);
      warnings = res.warnings;
      if (res.degraded) return { whereSql: "", binds: [], warnings, degraded: true, empty: false };
      segmentIds = res.rows.map((r) => r.id);
      if (!segmentIds.length) return { whereSql: "", binds: [], warnings, degraded: false, empty: true };
    }
  }

  const where: string[] = [];
  const binds: any[] = [];
  if (q) {
    where.push("(c.email LIKE ? OR c.first_name LIKE ? OR c.practice_name LIKE ?)");
    const like = `%${q}%`;
    binds.push(like, like, like);
  }
  if (status) {
    where.push("c.status = ?");
    binds.push(status);
  }
  if (emailStatus) {
    // "none" is the UI's spelling for NULL = never checked (pre-0016 rows).
    if (emailStatus === "none") {
      where.push("c.email_status IS NULL");
    } else if (emailStatus === "stale") {
      // A 'valid' address older than the re-verify cadence.
      where.push(
        "c.email_status='valid' AND c.email_verified_at IS NOT NULL AND c.email_verified_at < ?",
      );
      binds.push(staleCutoff);
    } else if (emailStatus === "queued") {
      where.push("c.email_verify_queued = 1");
    } else {
      where.push("c.email_status = ?");
      binds.push(emailStatus);
    }
  }
  if (segmentIds) {
    // Inline as integer literals — a bound IN(...) list would blow past D1's
    // 100-bound-variable-per-statement limit for any sizeable segment.
    const safeIds = segmentIds
      .map((n) => Number(n))
      .filter((n) => Number.isSafeInteger(n))
      .slice(0, 20000);
    where.push(`c.id IN (${safeIds.length ? safeIds.join(",") : "NULL"})`);
  } else if (list) {
    where.push("EXISTS (SELECT 1 FROM list_members lm WHERE lm.contact_id = c.id AND lm.list_id = ?)");
    binds.push(Number(list));
  }
  if (tagParams.length) {
    // Cap tag count so the IN(...) list can't exceed D1's bound-variable limit.
    if (tagParams.length > 20) tagParams = tagParams.slice(0, 20);
    const placeholders = tagParams.map(() => "?").join(",");
    // t.scope='contact' keeps a campaign tag of the same name out of this filter.
    if (tagMode === "all") {
      where.push(
        `(SELECT COUNT(DISTINCT t.id) FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
          WHERE ct.contact_id = c.id AND t.scope='contact' AND t.name IN (${placeholders})) = ?`,
      );
      binds.push(...tagParams, tagParams.length);
    } else {
      where.push(
        `EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
          WHERE ct.contact_id = c.id AND t.scope='contact' AND t.name IN (${placeholders}))`,
      );
      binds.push(...tagParams);
    }
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  return { whereSql, binds, warnings, degraded: false, empty: false };
}

contactsRoutes.get("/", async (c) => {
  const params = new URL(c.req.url).searchParams;
  const page = Math.max(1, Number(params.get("page") ?? 1));
  const pageSize = Math.min(200, Number(params.get("pageSize") ?? 50));
  const offset = (page - 1) * pageSize;

  const staleDays = await getStaleDays(c.env);
  const staleCutoff = staleBeforeSeconds(Math.floor(Date.now() / 1000), staleDays);
  const filter = await buildContactsFilter(c.env, params, staleCutoff);
  if (filter.degraded) {
    return c.json({ rows: [], total: 0, page, pageSize, warnings: filter.warnings, degraded: true });
  }
  if (filter.empty) return c.json({ rows: [], total: 0, page, pageSize, warnings: filter.warnings });

  const sort = params.get("sort") ?? "";
  const orderSql =
    sort === "verified_asc"
      ? "c.email_verified_at IS NULL, c.email_verified_at ASC, c.id DESC"
      : sort === "verified_desc"
        ? "c.email_verified_at IS NULL, c.email_verified_at DESC, c.id DESC"
        : "c.id DESC";

  const sql = `SELECT c.id,c.email,c.first_name,c.last_name,c.practice_name,c.status,c.source,c.source_table,c.email_status,c.email_verified_at,c.email_verify_queued,c.updated_at,c.attributes,
                 (SELECT GROUP_CONCAT(t.name, ',') FROM contact_tags ct
                  JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = c.id) AS tag_csv
               FROM contacts c ${filter.whereSql}
               ORDER BY ${orderSql} LIMIT ? OFFSET ?`;
  const countSql = `SELECT COUNT(*) AS n FROM contacts c ${filter.whereSql}`;
  const [rows, count] = await Promise.all([
    c.env.DB.prepare(sql).bind(...filter.binds, pageSize, offset).all<any>(),
    c.env.DB.prepare(countSql).bind(...filter.binds).first<{ n: number }>(),
  ]);
  const results = rows.results.map((r: any) => {
    // Parsed here so the table can render an arbitrary import column without
    // paying for a JSON.parse per cell in the browser.
    let attributes: Record<string, unknown> = {};
    try {
      const o = JSON.parse(r.attributes || "{}");
      if (o && typeof o === "object" && !Array.isArray(o)) attributes = o;
    } catch {}
    return { ...r, attributes, tags: r.tag_csv ? String(r.tag_csv).split(",") : [] };
  });
  return c.json({
    rows: results,
    total: count?.n ?? 0,
    page,
    pageSize,
    warnings: filter.warnings,
    stale_days: staleDays,
  });
});

// Queue verification without ever calling the API: rows are flagged so the
// existing 25/min cron pass does the work. Scope is one of:
//   pending  - every 'pending'/never-checked row
//   stale    - every 'valid' row older than the re-verify cadence
//   filter   - every row matching the current Contacts filter (filter_query)
//   ids      - an explicit selection
// A fresh 'valid' is never queued (and so never re-checked); `dry_run` returns
// the counts only, so the UI can state the size and the credit cost first.
const verifySchema = z.object({
  scope: z.enum(["pending", "stale", "filter", "ids"]),
  ids: z.array(z.number().int()).max(20000).optional(),
  filter_query: z.string().max(8000).optional(),
  dry_run: z.boolean().optional(),
});

contactsRoutes.post("/verify", async (c) => {
  const parsed = verifySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { scope, dry_run } = parsed.data;

  const staleDays = await getStaleDays(c.env);
  const staleCutoff = staleBeforeSeconds(Math.floor(Date.now() / 1000), staleDays);

  let targetSql: string;
  let binds: any[] = [];
  let warnings: string[] = [];

  if (scope === "pending") {
    targetSql = "(c.email_status = 'pending' OR c.email_status IS NULL)";
  } else if (scope === "stale") {
    targetSql =
      "(c.email_status = 'valid' AND c.email_verified_at IS NOT NULL AND c.email_verified_at < ?)";
    binds.push(staleCutoff);
  } else if (scope === "ids") {
    const ids = (parsed.data.ids ?? [])
      .map((n) => Number(n))
      .filter((n) => Number.isSafeInteger(n))
      .slice(0, 20000);
    if (!ids.length) return c.json({ error: "ids is required when scope=ids" }, 400);
    targetSql = `c.id IN (${ids.join(",")})`;
  } else {
    const f = await buildContactsFilter(c.env, new URLSearchParams(parsed.data.filter_query ?? ""), staleCutoff);
    if (f.degraded) {
      return c.json({ error: "filter could not be evaluated", warnings: f.warnings, degraded: true }, 400);
    }
    warnings = f.warnings;
    targetSql = f.empty ? "0=1" : f.whereSql.replace(/^WHERE\s+/, "") || "1=1";
    binds = f.binds;
  }

  // A fresh 'valid' can never be queued - that is what "never re-check a fresh
  // valid" means at the queueing end. A stale 'valid' is eligible.
  const eligibleSql =
    "(c.email_status IS NULL OR c.email_status <> 'valid' OR c.email_verified_at IS NULL OR c.email_verified_at < ?)";
  const eligibleBinds = [staleCutoff];

  const matched =
    (
      await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM contacts c WHERE ${targetSql}`)
        .bind(...binds)
        .first<{ n: number }>()
    )?.n ?? 0;
  const alreadyQueued =
    (
      await c.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM contacts c WHERE ${targetSql} AND ${eligibleSql} AND c.email_verify_queued = 1`,
      )
        .bind(...binds, ...eligibleBinds)
        .first<{ n: number }>()
    )?.n ?? 0;
  const eligible = Math.max(
    0,
    ((await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM contacts c WHERE ${targetSql} AND ${eligibleSql}`,
    )
      .bind(...binds, ...eligibleBinds)
      .first<{ n: number }>())?.n ?? 0) - alreadyQueued,
  );

  const summary = {
    scope,
    matched,
    eligible,
    skipped: matched - eligible - alreadyQueued,
    already_queued: alreadyQueued,
    stale_days: staleDays,
    warnings,
  };

  if (dry_run) return c.json({ ...summary, queued: 0, dry_run: true });

  const upd = await c.env.DB.prepare(
    `UPDATE contacts SET email_verify_queued = 1, updated_at = unixepoch()
      WHERE id IN (SELECT c.id FROM contacts c WHERE ${targetSql} AND ${eligibleSql})
        AND email_verify_queued = 0`,
  )
    .bind(...binds, ...eligibleBinds)
    .run();
  const queued = Number((upd.meta as any)?.changes ?? 0);
  return c.json({ ...summary, queued, dry_run: false });
});

const upsertSchema = z.object({
  email: z.string().email(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  practice_name: z.string().optional(),
  attributes: z.record(z.unknown()).optional(),
  status: z.enum(["active", "unsubscribed", "bounced", "complained", "disabled"]).optional(),
  source: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

async function applyTags(env: Env, contactId: number, tags: string[]) {
  for (const name of tags) {
    // Contact tags only — a campaign tag of the same name is a different row.
    const tagId = await ensureTag(env, name, "contact");
    if (tagId) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO contact_tags (contact_id, tag_id) VALUES (?, ?)",
      ).bind(contactId, tagId).run();
    }
  }
}

contactsRoutes.post("/", async (c) => {
  const parsed = upsertSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const d = parsed.data;
  const r = await c.env.DB.prepare(
    `INSERT INTO contacts (email, first_name, last_name, practice_name, attributes, status, source, email_status, timezone)
     VALUES (?,?,?,?,?,?,?, 'pending', ?)
     ON CONFLICT(email) DO UPDATE SET
       first_name=excluded.first_name,
       last_name=excluded.last_name,
       practice_name=excluded.practice_name,
       attributes=excluded.attributes,
       timezone=COALESCE(contacts.timezone, excluded.timezone),
       status=excluded.status,
       updated_at=unixepoch()
     RETURNING id`,
  )
    .bind(
      d.email.toLowerCase(),
      d.first_name ?? null,
      d.last_name ?? null,
      d.practice_name ?? null,
      JSON.stringify(d.attributes ?? {}),
      d.status ?? "active",
      d.source ?? "manual",
      timezoneForState((d.attributes as any)?.state ?? (d.attributes as any)?.State ?? null),
    )
    .first<{ id: number }>();
  if (r && d.tags?.length) await applyTags(c.env, r.id, d.tags);
  return c.json({ ok: true, id: r?.id });
});

contactsRoutes.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const parsed = upsertSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const d = parsed.data;
  const sets: string[] = [];
  const binds: any[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (k === "tags") continue;
    if (k === "attributes") {
      sets.push("attributes = ?");
      binds.push(JSON.stringify(v));
    } else {
      sets.push(`${k} = ?`);
      binds.push(v);
    }
  }
  if (sets.length) {
    sets.push("updated_at = unixepoch()");
    binds.push(id);
    await c.env.DB.prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  }
  if (d.tags) {
    await c.env.DB.prepare("DELETE FROM contact_tags WHERE contact_id=?").bind(id).run();
    await applyTags(c.env, id, d.tags);
  }
  return c.json({ ok: true });
});

contactsRoutes.get("/fields", async (c) => {
  const sourceTable = c.req.query("source_table")?.trim() ?? "";
  const listId = Number(c.req.query("list_id") ?? "");
  const segmentId = Number(c.req.query("segment_id") ?? "");
  const fixed = [
    { path: "email", label: "Email" },
    { path: "first_name", label: "First name" },
    { path: "last_name", label: "Last name" },
    { path: "practice_name", label: "Practice name" },
  ];

  // Custom attributes are JSON keys written per contact at import time, so the
  // raw set is global: every column anyone ever imported, across every list.
  // Scope the sample to the audience the operator picked, so a campaign or
  // template for one list offers that list's fields instead of the union.
  type AttrScope = "list" | "segment" | "global";
  let scope: AttrScope = "global";
  let scope_label = "All contacts";
  let scope_warning: string | null = null;
  let rows: { attributes: string }[] = [];

  const sampleSql = (where: string, binds: any[]) =>
    c.env.DB.prepare(
      `SELECT attributes FROM contacts WHERE attributes IS NOT NULL AND attributes != '' AND attributes != '{}' ${where} ORDER BY id DESC LIMIT 500`,
    )
      .bind(...binds)
      .all<{ attributes: string }>();

  const audienceId = listId > 0 ? listId : segmentId > 0 ? segmentId : 0;
  if (audienceId) {
    const listRow = await c.env.DB.prepare("SELECT id, name, kind, filter_json FROM lists WHERE id=?")
      .bind(audienceId)
      .first<{ id: number; name: string; kind: string; filter_json: string | null }>();
    if (!listRow) {
      scope_warning = "Audience not found — showing fields from all contacts.";
    } else if (listRow.kind === "segment") {
      let raw: unknown = {};
      try {
        raw = listRow.filter_json ? JSON.parse(listRow.filter_json) : {};
      } catch {}
      const { filter, warnings, degraded } = normalizeSegmentFilter(raw);
      if (degraded) {
        scope_warning = warnings[0] ?? "Segment could not be evaluated — showing fields from all contacts.";
      } else {
        const { sql, binds } = buildAudienceQuery(filter, false);
        const res = await c.env.DB.prepare(
          `SELECT c.attributes FROM contacts c
           WHERE c.id IN (SELECT s.id FROM (${sql}) s)
             AND c.attributes IS NOT NULL AND c.attributes != '' AND c.attributes != '{}'
           LIMIT 500`,
        )
          .bind(...binds)
          .all<{ attributes: string }>();
        rows = res.results;
        scope = "segment";
        scope_label = listRow.name;
      }
    } else {
      const res = await sampleSql("AND id IN (SELECT contact_id FROM list_members WHERE list_id = ?)", [listRow.id]);
      rows = res.results;
      scope = "list";
      scope_label = listRow.name;
    }
  }
  if (scope === "global") {
    const res = await sampleSql("", []);
    rows = res.results;
  }

  // Count coverage so fields present on most of the audience sort first, then
  // alphabetically — the picker leads with what is actually populated.
  const counts = new Map<string, number>();
  for (const row of rows) {
    try {
      const o = JSON.parse(row.attributes);
      if (o && typeof o === "object") for (const k of Object.keys(o)) counts.set(k, (counts.get(k) ?? 0) + 1);
    } catch {}
  }
  const attrs = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => ({ path: `attributes.${k}`, label: k }));
  const source: Array<{ path: string; label: string }> = [];
  let source_error: string | null = null;
  if (sourceTable) {
    if (!/^[A-Za-z0-9_]+$/.test(sourceTable)) {
      source_error = "Invalid source table";
    } else if (!c.env.SOURCE_DB) {
      source_error = "SOURCE_DB binding not configured";
    } else {
      try {
        const cfg = await c.env.DB.prepare("SELECT email_column FROM source_tables WHERE table_name=?")
          .bind(sourceTable)
          .first<{ email_column: string }>();
        const info = await c.env.SOURCE_DB.prepare(`PRAGMA table_info(${sourceTable})`).all<{ name: string }>();
        const fixedAliases: Record<string, string> = {
          first_name: "first_name",
          FirstName: "first_name",
          firstName: "first_name",
          given_name: "first_name",
          last_name: "last_name",
          LastName: "last_name",
          lastName: "last_name",
          surname: "last_name",
          family_name: "last_name",
          practice_name: "practice_name",
          PracticeName: "practice_name",
          practice: "practice_name",
          company: "practice_name",
          clinic: "practice_name",
          business_name: "practice_name",
        };
        for (const col of info.results.map((r) => String(r.name))) {
          const path = col === cfg?.email_column ? "email" : fixedAliases[col] ?? `attributes.${col}`;
          source.push({ path, label: col === path ? col : `${col} → ${path}` });
        }
      } catch (e: any) {
        source_error = String(e?.message ?? e);
      }
    }
  }
  return c.json({ fixed, attributes: attrs, source, source_error, scope, scope_label, scope_warning, sampled: rows.length });
});

contactsRoutes.get("/stats", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const staleDays = await getStaleDays(c.env);
  const staleCutoff = staleBeforeSeconds(now, staleDays);
  const [rows, verification, stale, queued, credits] = await Promise.all([
    c.env.DB.prepare(
      "SELECT status, COUNT(*) AS n FROM contacts GROUP BY status",
    ).all<{ status: string; n: number }>(),
    // NULL (never checked) is reported as 'none' so the UI can show it.
    c.env.DB.prepare(
      "SELECT COALESCE(email_status,'none') AS email_status, COUNT(*) AS n FROM contacts GROUP BY COALESCE(email_status,'none')",
    ).all<{ email_status: string; n: number }>(),
    // 'stale' is a subset of 'valid': a verified address older than the cadence.
    c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM contacts WHERE email_status='valid' AND email_verified_at IS NOT NULL AND email_verified_at < ?",
    )
      .bind(staleCutoff)
      .first<{ n: number }>(),
    // Rows the operator has explicitly asked to (re)check.
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM contacts WHERE email_verify_queued = 1").first<{
      n: number;
    }>(),
    c.env.DB.prepare("SELECT value FROM settings WHERE key=?")
      .bind(CREDITS_REMAINING_SETTING_KEY)
      .first<{ value: string }>(),
  ]);
  let creditsRemaining: number | null = null;
  if (credits?.value != null) {
    try {
      const n = Number(JSON.parse(credits.value));
      creditsRemaining = Number.isFinite(n) ? n : null;
    } catch {
      const n = Number(credits.value);
      creditsRemaining = Number.isFinite(n) ? n : null;
    }
  }
  return c.json({
    stats: rows.results,
    verification: verification.results,
    stale: stale?.n ?? 0,
    queued: queued?.n ?? 0,
    stale_days: staleDays,
    credits_remaining: creditsRemaining,
  });
});
