import { z } from "zod";
import { SENDABLE_EMAIL_STATUSES } from "../shared/emailStatus";

const ident = z.string().regex(/^[A-Za-z0-9_]+$/);

export const ruleSchema = z.object({
  source: z.enum(["contact", "attribute"]),
  field: z.string().min(1),
  op: z.enum(["eq", "neq", "contains", "starts_with", "in", "not_in", "empty", "not_empty"]),
  value: z.union([z.string(), z.array(z.string())]).optional(),
});
export type Rule = z.infer<typeof ruleSchema>;

export const segmentFilterSchema = z.object({
  status: z.array(z.enum(["active", "unsubscribed", "bounced", "complained", "disabled"])).optional(),
  tags: z.array(z.string()).optional(),
  tag_mode: z.enum(["any", "all"]).default("any"),
  search: z.string().optional(),
  rules: z.array(ruleSchema).optional(),
});
export type SegmentFilter = z.infer<typeof segmentFilterSchema>;

// Allowed contact columns for safe interpolation
const CONTACT_COLS = new Set([
  "email", "first_name", "last_name", "practice_name", "status", "source",
  "source_table", "created_at", "updated_at",
]);
const STATUSES = new Set(["active", "unsubscribed", "bounced", "complained", "disabled"]);

function emitCondition(
  lhs: string,
  op: Rule["op"],
  value: Rule["value"],
  binds: any[],
): string | null {
  switch (op) {
    case "empty":
      return `(${lhs} IS NULL OR ${lhs} = '')`;
    case "not_empty":
      return `(${lhs} IS NOT NULL AND ${lhs} != '')`;
    case "eq":
      binds.push(value ?? "");
      return `${lhs} = ?`;
    case "neq":
      binds.push(value ?? "");
      return `(${lhs} IS NULL OR ${lhs} != ?)`;
    case "contains":
      binds.push(`%${value ?? ""}%`);
      return `${lhs} LIKE ?`;
    case "starts_with":
      binds.push(`${value ?? ""}%`);
      return `${lhs} LIKE ?`;
    case "in":
    case "not_in": {
      const arr = Array.isArray(value) ? value : value ? [value] : [];
      if (!arr.length) return op === "in" ? "0=1" : "1=1";
      const ph = arr.map(() => "?").join(",");
      binds.push(...arr);
      return op === "in" ? `${lhs} IN (${ph})` : `${lhs} NOT IN (${ph})`;
    }
  }
}

/**
 * Boolean-ish spellings accepted for an attribute rule value. A stored 1 also
 * has to answer to "true"/"yes" (and 0 to "false"/"no") so the spelling the
 * user types never has to match the stored representation.
 */
const BOOL_TRUE = new Set(["1", "true", "yes"]);
const BOOL_FALSE = new Set(["0", "false", "no"]);

/** Normalise a rule value to 1 / 0 / null when it is boolean-ish. */
export function boolishValue(value: unknown): 0 | 1 | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value === 1 ? 1 : value === 0 ? 0 : null;
  const s = String(value).trim().toLowerCase();
  if (BOOL_TRUE.has(s)) return 1;
  if (BOOL_FALSE.has(s)) return 0;
  return null;
}

/**
 * SQL expression that normalises a JSON attribute to 1 / 0 / NULL, accepting
 * every boolean-ish spelling (and the JSON true/false that json_extract turns
 * into 1/0). Anything else is NULL, so it only matches via a fallback rule.
 */
function boolishSql(lhs: string): string {
  return `(CASE lower(trim(CAST(${lhs} AS TEXT)))
    WHEN '1' THEN 1 WHEN 'true' THEN 1 WHEN 'yes' THEN 1
    WHEN '0' THEN 0 WHEN 'false' THEN 0 WHEN 'no' THEN 0
    ELSE NULL END)`;
}

/**
 * Attribute rules: boolean-ish values compare against the normalised
 * attribute rather than raw string equality, so `outreach_ok = 1`,
 * `= true` and `= yes` are the same audience. Non-boolean values fall back
 * to plain equality/listing so existing segments are unchanged.
 */
function emitAttributeCondition(
  lhs: string,
  op: Rule["op"],
  value: Rule["value"],
  binds: any[],
): string | null {
  if (op === "eq" || op === "neq") {
    const b = boolishValue(value);
    if (b !== null) {
      const expr = boolishSql(lhs);
      binds.push(b);
      return op === "eq" ? `${expr} = ?` : `(${expr} IS NULL OR ${expr} != ?)`;
    }
  }
  if (op === "in" || op === "not_in") {
    const arr = Array.isArray(value) ? value : value ? [value] : [];
    if (arr.length) {
      const mapped = arr.map(boolishValue);
      if (mapped.every((v) => v !== null)) {
        const uniq = [...new Set(mapped as number[])];
        const expr = boolishSql(lhs);
        const ph = uniq.map(() => "?").join(",");
        binds.push(...uniq);
        return op === "in" ? `${expr} IN (${ph})` : `${expr} NOT IN (${ph})`;
      }
    }
  }
  return emitCondition(lhs, op, value, binds);
}

/**
 * SQL predicate restricting a contact alias to sendable addresses, pushing one
 * bind per sendable status. Shared by the segment query and the list/all-active
 * branches of resolveAudience (routes/campaigns.ts) so every send path applies
 * the same rule. This is an ALLOWLIST: only 'valid' (plus 'risky' when
 * ALLOW_RISKY_SENDS is on) matches, so NULL (never checked) is excluded too.
 */
export function sendableContactFilter(alias: string, binds: any[]): string {
  const ph = SENDABLE_EMAIL_STATUSES.map(() => "?").join(",");
  binds.push(...SENDABLE_EMAIL_STATUSES);
  return `${alias}.email_status IN (${ph})`;
}

/**
 * Build an audience query over local contacts. Segments are pure local
 * filters — new source-DB rows arrive via the scheduled mirror sync
 * (see src/worker/sync.ts).
 *
 * `forSending` additionally restricts to contacts that are verified sendable
 * (see shared/emailStatus.ts). Browsing callers leave it off so the Contacts
 * page can still show a held-back address.
 */
export function buildAudienceQuery(
  filter: SegmentFilter,
  count = false,
  opts: { forSending?: boolean } = {},
) {
  const where: string[] = [];
  const binds: any[] = [];

  const statuses = filter.status?.length ? filter.status : ["active"];
  where.push(`c.status IN (${statuses.map(() => "?").join(",")})`);
  binds.push(...statuses);

  where.push(`NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = c.email)`);

  if (opts.forSending) where.push(sendableContactFilter("c", binds));

  if (filter.search) {
    where.push(`(c.email LIKE ? OR c.first_name LIKE ? OR c.practice_name LIKE ?)`);
    const like = `%${filter.search}%`;
    binds.push(like, like, like);
  }

  if (filter.tags?.length) {
    const ph = filter.tags.map(() => "?").join(",");
    if (filter.tag_mode === "all") {
      where.push(
        `(SELECT COUNT(DISTINCT t.id) FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
          WHERE ct.contact_id = c.id AND t.name IN (${ph})) = ?`,
      );
      binds.push(...filter.tags, filter.tags.length);
    } else {
      where.push(
        `EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
          WHERE ct.contact_id = c.id AND t.name IN (${ph}))`,
      );
      binds.push(...filter.tags);
    }
  }

  for (const rule of filter.rules ?? []) {
    let lhs: string;
    let cond: string | null;
    if (rule.source === "contact") {
      if (!CONTACT_COLS.has(rule.field)) continue;
      lhs = `c.${rule.field}`;
      cond = emitCondition(lhs, rule.op, rule.value, binds);
    } else {
      const key = rule.field.replace(/'/g, "''");
      lhs = `json_extract(c.attributes, '$.${key}')`;
      cond = emitAttributeCondition(lhs, rule.op, rule.value, binds);
    }
    if (cond) where.push(cond);
  }

  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const sql = count
    ? `SELECT COUNT(*) AS n FROM contacts c ${whereSql}`
    : `SELECT c.id, c.email FROM contacts c ${whereSql}`;
  return { sql, binds };
}

export function normalizeSegmentFilter(raw: unknown): {
  filter: SegmentFilter;
  warnings: string[];
  degraded: boolean;
} {
  const warnings: string[] = [];
  let degraded = false;
  const r: any = raw && typeof raw === "object" ? raw : {};

  // Detect pre-import-first schema fields that no longer resolve.
  const legacyTopKeys = ["source_db_rule", "source_db", "source_table", "email_column", "source_rules"];
  for (const k of legacyTopKeys) {
    if (k in r) {
      warnings.push(
        `Legacy segment field "${k}" is no longer supported. Open this segment on Lists & tags and re-save it as an attribute rule (e.g. attribute state equals TAS).`,
      );
      degraded = true;
    }
  }

  const cleanRules: Rule[] = [];
  const inputRules = Array.isArray(r.rules) ? r.rules : [];
  for (const rule of inputRules) {
    const p = ruleSchema.safeParse(rule);
    if (p.success) {
      if (p.data.source === "contact" && !CONTACT_COLS.has(p.data.field)) {
        warnings.push(`Ignored contact rule for unknown column "${p.data.field}".`);
        degraded = true;
        continue;
      }
      cleanRules.push(p.data);
    } else {
      const label = rule && typeof rule === "object" ? JSON.stringify(rule).slice(0, 80) : String(rule);
      warnings.push(`Ignored invalid rule ${label}. Re-save the segment on Lists & tags.`);
      degraded = true;
    }
  }
  if (inputRules.length > 0 && cleanRules.length === 0) degraded = true;

  // Catch older ad-hoc single-rule objects that were stored directly on
  // filter_json instead of inside `rules`. Without this, they look like an
  // empty segment and would match every active contact.
  if (!inputRules.length && ["field", "column", "table", "source_db", "source_table", "email_column"].some((k) => k in r)) {
    warnings.push("This segment uses an older rule format. Open it on Lists & tags and re-save it with column rules.");
    degraded = true;
  }

  const hasRealFilter =
    cleanRules.length > 0 ||
    (Array.isArray(r.tags) && r.tags.length > 0) ||
    (typeof r.search === "string" && r.search.trim().length > 0);
  if (!hasRealFilter) {
    warnings.push("This segment has no column rules, tags, or search filter, so it has been blocked from matching every active contact.");
    degraded = true;
  }

  const filter: SegmentFilter = {
    status: Array.isArray(r.status) ? r.status.filter((s: any) => typeof s === "string" && STATUSES.has(s)) : undefined,
    tags: Array.isArray(r.tags) ? r.tags.filter((s: any) => typeof s === "string") : undefined,
    tag_mode: r.tag_mode === "all" ? "all" : "any",
    search: typeof r.search === "string" ? r.search : undefined,
    rules: cleanRules,
  };
  return { filter, warnings, degraded };
}

export async function countSegment(
  env: { DB: D1Database },
  raw: unknown,
): Promise<{ count: number; warnings: string[]; degraded: boolean }> {
  const { filter, warnings, degraded } = normalizeSegmentFilter(raw);
  // Fail-safe: if the segment could not be evaluated, return 0 so we never
  // accidentally address the whole database.
  if (degraded) return { count: 0, warnings, degraded };
  const { sql, binds } = buildAudienceQuery(filter, true);
  const r = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return { count: r?.n ?? 0, warnings, degraded };
}

export async function resolveSegmentRows(
  env: { DB: D1Database },
  raw: unknown,
  opts: { forSending?: boolean } = {},
): Promise<{ rows: { id: number; email: string }[]; warnings: string[]; degraded: boolean }> {
  const { filter, warnings, degraded } = normalizeSegmentFilter(raw);
  if (degraded) return { rows: [], warnings, degraded };
  const { sql, binds } = buildAudienceQuery(filter, false, opts);
  const res = await env.DB.prepare(sql).bind(...binds).all<{ id: number; email: string }>();
  return { rows: res.results, warnings, degraded };
}
