import { Hono } from "hono";
import { z } from "zod";
import type { ContactRow, Env, SendJob, TemplateRow } from "../types";
import { smtp2goSend } from "../smtp2go";
import { sendEnvelope } from "../sendPayload";
import { acceptsCampaignBody } from "../../shared/body";
import {
  MAX_SUBJECT_LENGTH,
  bodyPlainText,
  contactVars,
  mappedVars,
  parseMapping,
  renderBody,
  renderSubject,
  renderTextBody,
  sanitizeSubject,
  subjectTooLong,
  urlContextVars,
  type VarMapping,
} from "../render";
import { sampleContactVars, sampleVarsForMapping } from "../../shared/sampleValues";
import { resolveSegmentRows, sendableContactFilter } from "../audience";
import { checkSpam, type SpamCheckResult } from "../../shared/spamCheck";
import { isSendingDomain, normalizeSendingDomain } from "../../shared/domain";
import {
  DEFAULT_SEND_TIMEZONE,
  currentWindowStart,
  evaluatePlanNow,
  formatSendDays,
  hasSendPlan,
  isValidTimeZone,
  localDayWindow,
  normalizeDailyCap,
  normalizeRampDays,
  normalizeRampStart,
  normalizeSendTime,
  normalizeSpreadMinutes,
  parseSendDays,
  parseSendTime,
  planWords,
  projectFinish,
  rampAllowanceAt,
  rampScheduleWords,
  resolveTimeZone,
  sendRamp,
  spreadTarget,
  spreadWords,
  todayRampAllowance,
  zonedParts,
  type SendRamp,
} from "../../shared/sendPlan";
import { ensureTag, listCampaignTags, setCampaignTags } from "./tags";
import { GHL_TAG_TRIGGER_CAMPAIGN, isGhlTagTriggerCampaign } from "../ghlCampaign";
import { readVerifiedDomains, sendDomainViolation } from "../senderDomain";

export const campaignsRoutes = new Hono<{ Bindings: Env }>();

campaignsRoutes.get("/", async (c) => {
  // Campaign tags are their own namespace: a "melbourne" campaign tag never
  // matches a contact tag of the same name.
  let tagParams = c.req.queries("tag") ?? [];
  const tagMode = c.req.query("tag_mode") === "any" ? "any" : "all";
  const where: string[] = [];
  const binds: any[] = [];
  if (tagParams.length) {
    // Cap tag count so the IN(...) list can't exceed D1's bound-variable limit.
    if (tagParams.length > 20) tagParams = tagParams.slice(0, 20);
    const placeholders = tagParams.map(() => "?").join(",");
    if (tagMode === "all") {
      where.push(
        `(SELECT COUNT(DISTINCT t.id) FROM campaign_tags ct JOIN tags t ON t.id = ct.tag_id
          WHERE ct.campaign_id = c.id AND t.scope='campaign' AND t.name IN (${placeholders})) = ?`,
      );
      binds.push(...tagParams, tagParams.length);
    } else {
      where.push(
        `EXISTS (SELECT 1 FROM campaign_tags ct JOIN tags t ON t.id = ct.tag_id
          WHERE ct.campaign_id = c.id AND t.scope='campaign' AND t.name IN (${placeholders}))`,
      );
      binds.push(...tagParams);
    }
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.status, c.scheduled_at, c.created_at, c.started_at,
            c.finished_at, c.template_id, c.from_email,
            (SELECT GROUP_CONCAT(t.name, ',') FROM campaign_tags ct
             JOIN tags t ON t.id = ct.tag_id
             WHERE ct.campaign_id = c.id AND t.scope='campaign') AS tag_csv,
            COALESCE(SUM(CASE WHEN s.sent_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS sent,
            COALESCE(SUM(CASE WHEN s.delivered_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS delivered,
            COALESCE(SUM(CASE WHEN s.opened_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS opened,
            COALESCE(SUM(CASE WHEN s.clicked_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS clicked,
            COALESCE(SUM(CASE WHEN s.bounced_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS bounced,
            (SELECT COUNT(*) FROM suppressions sup
               JOIN sends s2 ON s2.email = sup.email
               WHERE s2.campaign_id = c.id
                 AND sup.reason = 'unsubscribe'
                 AND sup.created_at >= COALESCE(c.started_at, c.created_at)) AS unsubscribed
     FROM campaigns c
     LEFT JOIN sends s ON s.campaign_id = c.id
     ${whereSql}
     GROUP BY c.id
     ORDER BY c.id DESC LIMIT 200`,
  )
    .bind(...binds)
    .all<any>();
  const results = rows.results.map((r: any) => ({
    ...r,
    tags: r.tag_csv ? String(r.tag_csv).split(",") : [],
  }));
  return c.json({ rows: results });
});

campaignsRoutes.get("/audience-count", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM contacts c
     WHERE c.status='active'
       AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = c.email)`,
  ).first<{ n: number }>();
  return c.json({ count: r?.n ?? 0, warnings: [], degraded: false });
});

campaignsRoutes.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first<any>();
  if (!row) return c.json({ error: "not found" }, 404);
  const tags = await listCampaignTags(c.env, id);
  return c.json({ row: { ...row, tags } });
});

// Campaign tags — always the campaign scope.
campaignsRoutes.get("/:id/tags", async (c) => {
  const id = Number(c.req.param("id"));
  const tags = await listCampaignTags(c.env, id);
  return c.json({ tags });
});

const setTagsSchema = z.object({ tags: z.array(z.string().min(1).max(64)).max(50) });
// Tags are metadata, not send-affecting content: there is deliberately NO status
// guard here, so a campaign can be tagged at any status (draft, scheduled,
// sending, paused, sent). Keep it that way — the UI locks content, not tags.
campaignsRoutes.put("/:id/tags", async (c) => {
  const id = Number(c.req.param("id"));
  const parsed = setTagsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const camp = await c.env.DB.prepare("SELECT id FROM campaigns WHERE id=?").bind(id).first<{ id: number }>();
  if (!camp) return c.json({ error: "campaign not found" }, 404);
  const tags = await setCampaignTags(c.env, id, parsed.data.tags);
  return c.json({ ok: true, tags });
});

/** Trim + case-insensitive de-dupe, same rule the single-campaign setter uses. */
function dedupeNames(names: string[]): string[] {
  const out: string[] = [];
  for (const raw of names ?? []) {
    const name = String(raw ?? "").trim();
    if (!name) continue;
    if (!out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

export interface BulkTagResult {
  id: number;
  ok: boolean;
  /** Full campaign tag set after the change (success only). */
  tags?: string[];
  error?: string;
}

/**
 * Add/remove tags across many campaigns in one call. Campaigns are processed
 * one at a time and each is wrapped in its own try/catch, so one bad id is
 * reported as a failed result instead of aborting the rest of the batch.
 * Always the campaign scope — a contact tag of the same name is a different row.
 */
export async function applyBulkCampaignTags(
  env: Env,
  ids: number[],
  ops: { add?: string[]; remove?: string[] },
): Promise<BulkTagResult[]> {
  const add = dedupeNames(ops.add ?? []);
  const remove = dedupeNames(ops.remove ?? []);

  // Resolve once for the whole batch: adds create the tag if missing, removes
  // only match a tag that already exists.
  const addIds: number[] = [];
  for (const name of add) {
    const tagId = await ensureTag(env, name, "campaign");
    if (tagId) addIds.push(tagId);
  }
  const removeIds: number[] = [];
  for (const name of remove) {
    const row = await env.DB.prepare("SELECT id FROM tags WHERE name=? AND scope='campaign'")
      .bind(name)
      .first<{ id: number }>();
    if (row) removeIds.push(row.id);
  }

  const results: BulkTagResult[] = [];
  for (const id of ids) {
    try {
      const camp = await env.DB.prepare("SELECT id FROM campaigns WHERE id=?")
        .bind(id)
        .first<{ id: number }>();
      if (!camp) {
        results.push({ id, ok: false, error: "campaign not found" });
        continue;
      }
      const stmts: D1PreparedStatement[] = [];
      for (const tagId of removeIds) {
        stmts.push(
          env.DB.prepare("DELETE FROM campaign_tags WHERE campaign_id=? AND tag_id=?").bind(id, tagId),
        );
      }
      for (const tagId of addIds) {
        stmts.push(
          env.DB.prepare(
            "INSERT OR IGNORE INTO campaign_tags (campaign_id, tag_id) VALUES (?, ?)",
          ).bind(id, tagId),
        );
      }
      // Chunked so a large tag set cannot exceed D1's batch limits.
      for (let i = 0; i < stmts.length; i += 50) {
        await env.DB.batch(stmts.slice(i, i + 50));
      }
      results.push({ id, ok: true, tags: await listCampaignTags(env, id) });
    } catch (e: any) {
      results.push({ id, ok: false, error: e?.message ?? String(e) });
    }
  }
  return results;
}

const bulkTagsSchema = z.object({
  ids: z.array(z.number().int()).min(1).max(500),
  add: z.array(z.string().min(1).max(64)).max(50).optional(),
  remove: z.array(z.string().min(1).max(64)).max(50).optional(),
});

// Bulk tag assignment. Registered as a single-segment path so it can never be
// mistaken for /:id/tags; the per-campaign result list is the whole point.
campaignsRoutes.post("/bulk-tags", async (c) => {
  const parsed = bulkTagsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const add = parsed.data.add ?? [];
  const remove = parsed.data.remove ?? [];
  if (!add.length && !remove.length) {
    return c.json({ error: "provide at least one tag to add or remove" }, 400);
  }
  const ids = [...new Set(parsed.data.ids)];
  const results = await applyBulkCampaignTags(c.env, ids, { add, remove });
  const failed = results.filter((r) => !r.ok).length;
  return c.json({ results, summary: { total: results.length, ok: results.length - failed, failed } });
});

campaignsRoutes.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const camp = await c.env.DB.prepare("SELECT status FROM campaigns WHERE id=?").bind(id).first<{ status: string }>();
  if (!camp) return c.json({ error: "campaign not found" }, 404);
  if (camp.status === "sending") {
    return c.json({ error: "cannot delete a campaign that is currently sending. Pause or wait for it to finish." }, 400);
  }
  await c.env.DB.prepare("DELETE FROM campaigns WHERE id=?").bind(id).run();
  return c.json({ ok: true });
});

campaignsRoutes.get("/:id/stats", async (c) => {
  const id = Number(c.req.param("id"));
  const rows = await c.env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM sends WHERE campaign_id=? GROUP BY status",
  )
    .bind(id)
    .all<{ status: string; n: number }>();
  const engagement = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered,
       SUM(CASE WHEN opened_at    IS NOT NULL THEN 1 ELSE 0 END) AS opened,
       SUM(CASE WHEN clicked_at   IS NOT NULL THEN 1 ELSE 0 END) AS clicked,
       SUM(CASE WHEN bounced_at   IS NOT NULL THEN 1 ELSE 0 END) AS bounced
     FROM sends WHERE campaign_id=?`,
  ).bind(id).first<{ delivered: number; opened: number; clicked: number; bounced: number }>();
  // Total recipient rows, so the stats block can read "42 sent · 18 opened · 5
  // clicked" without a second request. Additive field; older clients ignore it.
  const totalSends = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM sends WHERE campaign_id=?")
    .bind(id)
    .first<{ n: number }>();
  return c.json({
    stats: rows.results,
    engagement: engagement ?? { delivered: 0, opened: 0, clicked: 0, bounced: 0 },
    total: totalSends?.n ?? 0,
  });
});

// ---------------------------------------------------------------------------
// Per-recipient engagement (read-only)
// ---------------------------------------------------------------------------
//
// One row per `sends` row for the campaign: who it went to, the delivery / open
// / click / bounce timestamps, and the SMTP2GO message id — so the owner can
// see WHO engaged rather than only the aggregate counts on /stats.
//
// One row per send is deliberate: the GHL tag-trigger container (a pseudo
// campaign, see ghlCampaign.ts) holds repeat sends to the same contact, and each
// one is its own send with its own smtp2go_id. A normal campaign send appears at
// most once per contact anyway (the partial unique index from 0015).
//
// Read-only: no writes, no SMTP2Go/GHL calls.
const RECIPIENT_FILTERS = ["all", "opened", "clicked", "delivered", "bounced", "not-opened"] as const;
type RecipientFilter = (typeof RECIPIENT_FILTERS)[number];

/** WHERE fragment for one engagement filter (never introduces a bind itself). */
function recipientFilterSql(filter: RecipientFilter): string {
  switch (filter) {
    case "opened":
      return "s.opened_at IS NOT NULL";
    case "clicked":
      return "s.clicked_at IS NOT NULL";
    case "delivered":
      return "s.delivered_at IS NOT NULL";
    case "bounced":
      return "s.bounced_at IS NOT NULL";
    case "not-opened":
      return "s.opened_at IS NULL";
    default:
      return "1=1";
  }
}

campaignsRoutes.get("/:id/recipients", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id)) return c.json({ error: "invalid campaign id" }, 400);
  const camp = await c.env.DB.prepare("SELECT id FROM campaigns WHERE id=?")
    .bind(id)
    .first<{ id: number }>();
  // A campaign that exists but has no sends is a normal empty list (200, not an
  // error); an unknown campaign is a 404.
  if (!camp) return c.json({ error: "not found" }, 404);

  const filterRaw = c.req.query("filter") ?? "";
  const filter: RecipientFilter = (RECIPIENT_FILTERS as readonly string[]).includes(filterRaw)
    ? (filterRaw as RecipientFilter)
    : "all";
  const sort = c.req.query("sort") === "engagement" ? "engagement" : "recent";
  const q = (c.req.query("q") ?? "").trim().slice(0, 200);

  // Pagination bounds. `limit`/`offset` (and the campaign id) are inlined as
  // integer literals — each validated as a safe integer first — which keeps the
  // bound-variable count at most the four search LIKEs, well under D1's limit
  // (the same reasoning as the inlined-integer-ids technique in
  // /audience-contacts).
  const rawLimit = Number(c.req.query("limit"));
  const rawOffset = Number(c.req.query("offset"));
  const limit = Number.isSafeInteger(rawLimit) ? Math.min(200, Math.max(1, rawLimit)) : 50;
  const offset = Number.isSafeInteger(rawOffset) ? Math.max(0, rawOffset) : 0;

  // `s.campaign_id = <id>` can never match a NULL campaign_id row (legacy / a
  // send that never got a home), so those are excluded by construction.
  const where: string[] = [`s.campaign_id = ${id}`, recipientFilterSql(filter)];
  const binds: any[] = [];
  if (q) {
    const like = `%${q}%`;
    // Search over the recipient address and the contact's name fields.
    where.push(
      "(s.email LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ? OR c.practice_name LIKE ?)",
    );
    binds.push(like, like, like, like);
  }
  const whereSql = where.join(" AND ");

  // "engagement" = the most recent open/click first (never-engaged rows carry 0
  // and fall to the end); "recent" (default) = newest send row first.
  const orderSql =
    sort === "engagement"
      ? "MAX(COALESCE(s.opened_at,0), COALESCE(s.clicked_at,0)) DESC, s.id DESC"
      : "s.id DESC";

  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.email, s.contact_id, s.status, s.smtp2go_id, s.ghl_contact_id,
            s.queued_at, s.sent_at, s.delivered_at, s.opened_at, s.clicked_at, s.bounced_at,
            c.first_name, c.last_name, c.practice_name,
            COALESCE(
              NULLIF(TRIM(c.practice_name), ''),
              NULLIF(TRIM(c.first_name), ''),
              NULLIF(TRIM(c.last_name), '')
            ) AS contact_name
       FROM sends s
       LEFT JOIN contacts c ON c.id = s.contact_id
      WHERE ${whereSql}
      ORDER BY ${orderSql}
      LIMIT ${limit} OFFSET ${offset}`,
  )
    .bind(...binds)
    .all<any>();

  const totalRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM sends s LEFT JOIN contacts c ON c.id = s.contact_id WHERE ${whereSql}`,
  )
    .bind(...binds)
    .first<{ n: number }>();

  // Campaign-wide engagement counts (ignores the filter/search), so the table
  // keeps its context while a filter is applied. Excludes NULL campaign_id too.
  const counts = await c.env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN sent_at      IS NOT NULL THEN 1 ELSE 0 END) AS sent,
       SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered,
       SUM(CASE WHEN opened_at    IS NOT NULL THEN 1 ELSE 0 END) AS opened,
       SUM(CASE WHEN clicked_at   IS NOT NULL THEN 1 ELSE 0 END) AS clicked,
       SUM(CASE WHEN bounced_at   IS NOT NULL THEN 1 ELSE 0 END) AS bounced,
       SUM(CASE WHEN opened_at    IS NULL     THEN 1 ELSE 0 END) AS not_opened
     FROM sends WHERE campaign_id = ${id}`,
  ).first<any>();

  return c.json({
    rows: rows.results.map((r: any) => ({
      id: r.id,
      email: r.email,
      contact_id: r.contact_id ?? null,
      name: r.contact_name ?? null,
      first_name: r.first_name ?? null,
      last_name: r.last_name ?? null,
      practice_name: r.practice_name ?? null,
      ghl_contact_id: r.ghl_contact_id ?? null,
      status: r.status,
      smtp2go_id: r.smtp2go_id ?? null,
      queued_at: r.queued_at ?? null,
      sent_at: r.sent_at ?? null,
      delivered_at: r.delivered_at ?? null,
      opened_at: r.opened_at ?? null,
      clicked_at: r.clicked_at ?? null,
      bounced_at: r.bounced_at ?? null,
    })),
    total: Number(totalRow?.n ?? 0),
    limit,
    offset,
    filter,
    q,
    sort,
    counts: {
      total: Number(counts?.total ?? 0),
      sent: Number(counts?.sent ?? 0),
      delivered: Number(counts?.delivered ?? 0),
      opened: Number(counts?.opened ?? 0),
      clicked: Number(counts?.clicked ?? 0),
      bounced: Number(counts?.bounced ?? 0),
      not_opened: Number(counts?.not_opened ?? 0),
    },
  });
});

// Recompute and self-heal campaign status from the sends table.
// Marks 'sending'/'paused' as 'sent' when nothing is left queued AND no
// recipients are still waiting for a later window — a drip in progress is
// 'sending' on purpose and must not be settled early.
campaignsRoutes.post("/:id/refresh-status", async (c) => {
  const id = Number(c.req.param("id"));
  const r = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued,
       COUNT(*) AS total
     FROM sends WHERE campaign_id=?`,
  ).bind(id).first<{ queued: number; total: number }>();
  if ((r?.total ?? 0) > 0 && (r?.queued ?? 0) === 0) {
    await settleFinishedCampaign(c.env, id);
  }
  const row = await c.env.DB.prepare("SELECT status, finished_at FROM campaigns WHERE id=?").bind(id).first();
  return c.json({ ok: true, row });
});

// Progress for a planned campaign: what has gone out today, what is left, and
// when the last batch is projected to release. Also answers for a campaign with
// no plan, where it simply reports "not planned".
campaignsRoutes.get("/:id/progress", async (c) => {
  const id = Number(c.req.param("id"));
  const camp = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id=?").bind(id).first<any>();
  if (!camp) return c.json({ error: "not found" }, 404);
  return c.json(await campaignProgress(c.env, camp, Math.floor(Date.now() / 1000)));
});

/**
 * One variable's source. A string is the legacy contact-field path; the object
 * form carries a static `value`, a contact `field`, or both (static wins at
 * render time). Unknown shapes are rejected so nothing else lands in the JSON
 * column.
 */
const mappingEntrySchema = z.union([
  z.string().max(500),
  z.object({
    field: z.string().max(500).optional(),
    value: z.string().max(2000).optional(),
  }),
]);

const campaignSchema = z.object({
  name: z.string().min(1),
  template_id: z.number().int().nullable().optional(),
  external_template_id: z.string().nullable().optional(),
  list_id: z.number().int().nullable().optional(),
  segment_id: z.number().int().nullable().optional(),
  audience_filter: z.record(z.unknown()).nullable().optional(),
  var_mapping: z.record(mappingEntrySchema).nullable().optional(),
  // Per-campaign content, merged into a base template at {{content}}.
  // Blank/whitespace-only is stored as NULL (= no campaign body).
  body_html: z.string().max(500_000).nullable().optional(),
  // Per-campaign subject line. Blank/whitespace-only is stored as NULL
  // (= the template's subject), and control characters are stripped: a newline
  // in a header value is header injection. Over-length is rejected, not stored.
  subject: z.string().nullable().optional(),
  // Campaign tags (campaign scope); unknown names are created on save.
  tags: z.array(z.string().min(1).max(64)).max(50).optional(),
  // The sending domain must be a real domain (at least one dot), never a bare
  // label: a first-label truncation like "localdentists" makes every
  // deliverability check run against a name that does not exist. Blank is
  // allowed and means "use the default".
  sending_domain: z
    .string()
    .refine((v) => v.trim() === "" || isSendingDomain(v), {
      message: "sending_domain must be a full domain (for example localdentists.au), not a bare label",
    })
    .optional(),
  from_name: z.string().optional(),
  from_email: z.string().email(),
  reply_to: z.string().email().optional().or(z.literal("")),
  scheduled_at: z.number().int().nullable().optional(),
  // Daily-batch ("drip") plan. All four are optional and nullable: an absent or
  // null value means "no plan" — send all at once, exactly as before. A plan is
  // what the every-minute dispatcher reads; it never applies retroactively to a
  // campaign that is already sending (see the PATCH guard below).
  daily_cap: z.number().int().positive().nullable().optional(),
  send_days: z.array(z.number().int().min(1).max(7)).max(7).nullable().optional(),
  // The optional ramp on the daily cap (see ramp_start / ramp_days). Both are
  // accepted and stored as given; a combination that cannot be a ramp
  // (no cap, a start at/above the cap, ramp_days = 1) simply behaves as the
  // flat cap does, so a typo can never produce a surprise first day.
  ramp_start: z.number().int().positive().nullable().optional(),
  ramp_days: z.number().int().min(1).nullable().optional(),
  // Minutes to spread each day's batch across. 0 (or null) is "no spread" -
  // the whole day's batch at the window, exactly as before.
  spread_minutes: z.number().int().min(0).max(1440).nullable().optional(),
  // "HH:MM" local. Rejected rather than silently dropped when malformed.
  send_time: z
    .string()
    .nullable()
    .optional()
    .refine((v) => v == null || v.trim() === "" || parseSendTime(v) != null, {
      message: "send_time must be HH:MM (24-hour), for example 10:00",
    }),
  send_timezone: z
    .string()
    .nullable()
    .optional()
    .refine((v) => v == null || v.trim() === "" || isValidTimeZone(v), {
      message: "send_timezone must be an IANA zone, for example Australia/Brisbane",
    }),
});

/** Blank/whitespace-only campaign content is stored as NULL (= today's behaviour). */
function normalizeBodyText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return v.trim() ? v : null;
}

/**
 * Blank/whitespace-only subject is stored as NULL (= use the template's).
 * Control characters are stripped here as well as at render time, so what the
 * editor reads back is exactly what will be sent.
 */
function normalizeSubject(v: unknown): string | null {
  const s = sanitizeSubject(v);
  return s ? s : null;
}

/**
 * The sending-domain rule for a campaign's From address, checked against the
 * cached verified-domain snapshot when one exists. Before the first sync there
 * is no verified set to check against, so the save is allowed and the SEND
 * still refuses a mismatched address (see consumer.ts). Existing campaign rows
 * are never rewritten.
 */
async function campaignFromDomainError(env: Env, fromEmail: string | null | undefined): Promise<string | null> {
  if (!fromEmail) return null;
  const snapshot = await readVerifiedDomains(env);
  if (!snapshot) return null;
  return sendDomainViolation({ fromEmail, snapshot });
}

/** A subject is a single short header line; reject instead of silently truncating. */
function subjectLengthError(v: unknown): string | null {
  if (!subjectTooLong(v)) return null;
  return `Subject is too long - keep it to ${MAX_SUBJECT_LENGTH} characters or fewer.`;
}

/**
 * A campaign body only makes sense for an in-app template that can take one:
 * a base template, or any template with a {{content}} slot. SMTP2GO renders its
 * own template body, so a campaign body there would be ignored — reject instead
 * of silently dropping it.
 */
async function campaignBodyError(
  env: Env,
  bodyHtml: string | null,
  templateId: number | null,
  externalTemplateId: string | null,
): Promise<string | null> {
  if (!bodyHtml) return null;
  if (externalTemplateId) {
    return "Campaign content needs an in-app template — SMTP2GO renders its own template body.";
  }
  if (!templateId) return "Choose a base template before adding campaign content.";
  const t = await env.DB.prepare("SELECT is_base, html FROM templates WHERE id = ?")
    .bind(templateId)
    .first<{ is_base: number; html: string }>();
  if (!t) return "Template not found.";
  if (acceptsCampaignBody(t)) return null;
  return "That template cannot take campaign content. Mark it as a base template, or give it a {{content}} slot.";
}

campaignsRoutes.post("/", async (c) => {
  const parsed = campaignSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const d = parsed.data;
  const subjectError = subjectLengthError(d.subject);
  if (subjectError) return c.json({ error: subjectError }, 400);
  const bodyHtml = normalizeBodyText(d.body_html);
  const bodyError = await campaignBodyError(
    c.env,
    bodyHtml,
    d.template_id ?? null,
    d.external_template_id ?? null,
  );
  if (bodyError) return c.json({ error: bodyError }, 400);
  // Sending-domain rule (validated on save going forward).
  const fromDomainError = await campaignFromDomainError(c.env, d.from_email);
  if (fromDomainError) return c.json({ error: fromDomainError }, 400);
  const r = await c.env.DB.prepare(
    `INSERT INTO campaigns (name, template_id, external_template_id, list_id, segment_id, audience_filter,
                            var_mapping, body_html, subject, sending_domain, from_name, from_email, reply_to, scheduled_at,
                            daily_cap, send_days, send_time, send_timezone, ramp_start, ramp_days, spread_minutes, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft')`,
  )
    .bind(
      d.name,
      d.template_id ?? null,
      d.external_template_id ?? null,
      d.list_id ?? null,
      d.segment_id ?? null,
      d.audience_filter ? JSON.stringify(d.audience_filter) : null,
      d.var_mapping ? JSON.stringify(d.var_mapping) : null,
      bodyHtml,
      normalizeSubject(d.subject),
      d.sending_domain ? normalizeSendingDomain(d.sending_domain) : null,
      d.from_name ?? null,
      d.from_email,
      d.reply_to || null,
      d.scheduled_at ?? null,
      normalizeDailyCap(d.daily_cap),
      formatSendDays(d.send_days ?? null),
      normalizeSendTime(d.send_time),
      isValidTimeZone(d.send_timezone) ? d.send_timezone!.trim() : null,
      normalizeRampStart(d.ramp_start),
      normalizeRampDays(d.ramp_days),
      normalizeSpreadMinutes(d.spread_minutes),
    )
    .run();
  const id = Number(r.meta.last_row_id);
  if (d.tags?.length) await setCampaignTags(c.env, id, d.tags);
  return c.json({ id });
});

// ---------------------------------------------------------------------------
// Duplicate a campaign — copy the settings, never the history
// ---------------------------------------------------------------------------
//
// The operator's loop is: pause the original, reword, carry on. Mutating a
// running campaign in place would fold the new copy into the old version's
// stats, so instead a duplicate is a fresh draft carrying the settings
// (content, mapping, tags, sender, plan) and NONE of the history: status
// 'draft', no `sends` rows, no stats, and fresh timestamps. The original is
// untouched — it keeps doing whatever it was doing (pausing or stopping it is a
// separate, deliberate action).
//
// By default the clone targets the remainder rather than the original audience,
// because copying the audience verbatim would re-email everyone already
// contacted. See `alreadyContacted()` for exactly who counts as contacted.

const duplicateSchema = z.object({
  /** Optional name for the clone; the default is "Copy of <name>". */
  name: z.string().min(1).max(200).optional(),
  /** Default true: target the contacts this campaign has not emailed yet. */
  exclude_already_sent: z.boolean().optional(),
});

/**
 * Contact ids and emails the campaign has *actually* contacted: a row that was
 * handed to SMTP2GO (sent_at / smtp2go_id), or that ended up delivered, opened,
 * clicked, bounced or complained, or is in flight.
 *
 * Deliberately NOT included: `queued` (inserted for a batch but never attempted)
 * and `failed` (the provider refused it, so nothing was delivered). Both of
 * those recipients have not been emailed yet, so the clone should include them —
 * the same reason a hard bounce IS excluded: the message did go out, and a
 * retry would be a second copy.
 *
 * `skipped` (suppressed at send time) is treated as never-sent too; those
 * addresses are normally in `suppressions`, which the audience rules already
 * filter out, so they never reach the list either way.
 */
async function alreadyContacted(
  env: Env,
  campaignId: number,
): Promise<{ ids: Set<number>; emails: Set<string> }> {
  const rows = await env.DB.prepare(
    `SELECT contact_id, email FROM sends
      WHERE campaign_id = ?
        AND (
          sent_at IS NOT NULL
          OR smtp2go_id IS NOT NULL
          OR status IN ('sent','delivered','opened','clicked','bounced','complained','sending')
        )`,
  )
    .bind(campaignId)
    .all<{ contact_id: number | null; email: string }>();
  const ids = new Set<number>();
  const emails = new Set<string>();
  for (const r of rows.results ?? []) {
    if (r.contact_id != null) ids.add(Number(r.contact_id));
    if (r.email) emails.add(String(r.email).toLowerCase());
  }
  return { ids, emails };
}

/** "<clone name> — not yet emailed (<n>)": how the remainder list is labelled. */
export function remainderListName(campaignName: string, count: number): string {
  return `${campaignName} \u2014 not yet emailed (${count})`;
}

/** Create a static list and fill it with `contactIds`. Returns the new list id. */
async function createStaticList(env: Env, name: string, contactIds: number[]): Promise<number> {
  const r = await env.DB.prepare(
    "INSERT INTO lists (name, kind, filter_json) VALUES (?, 'static', NULL)",
  )
    .bind(name)
    .run();
  const listId = Number(r.meta.last_row_id);
  const CHUNK = 50;
  for (let i = 0; i < contactIds.length; i += CHUNK) {
    await env.DB.batch(
      contactIds.slice(i, i + CHUNK).map((cid) =>
        env.DB.prepare("INSERT OR IGNORE INTO list_members (list_id, contact_id) VALUES (?, ?)").bind(
          listId,
          cid,
        ),
      ),
    );
  }
  return listId;
}

campaignsRoutes.post("/:id/duplicate", async (c) => {
  const id = Number(c.req.param("id"));
  const parsed = duplicateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const src = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id=?")
    .bind(id)
    .first<any>();
  if (!src) return c.json({ error: "campaign not found" }, 404);

  const excludeAlreadySent = parsed.data.exclude_already_sent !== false;
  const name = String(parsed.data.name ?? "").trim() || `Copy of ${src.name}`;

  // Resolve the audience before writing anything: an unevaluable segment has to
  // fail here rather than leave a half-built clone behind.
  const audience = await resolveAudience(c.env, src);
  if (audience.degraded) {
    return c.json(
      {
        error: "segment could not be evaluated — fix it on Lists & tags, then duplicate again",
        warnings: audience.warnings,
      },
      400,
    );
  }
  const audienceCount = audience.rows.length;

  let listId: number | null = null;
  let listName: string | null = null;
  let remainderCount = audienceCount;
  let excludedCount = 0;

  if (excludeAlreadySent) {
    const contacted = await alreadyContacted(c.env, id);
    const remainder = audience.rows.filter(
      (r) => !contacted.ids.has(Number(r.id)) && !contacted.emails.has(String(r.email).toLowerCase()),
    );
    excludedCount = audienceCount - remainder.length;
    remainderCount = remainder.length;
    // The list is created even when it is empty. A clone left with no list_id
    // would fall back to *every* active contact — re-emailing the whole database
    // is the one outcome this feature must never produce.
    listName = remainderListName(name, remainderCount);
    listId = await createStaticList(c.env, listName, remainder.map((r) => r.id));
  }

  // Settings only: the clone starts as a draft with no history. A plan, once
  // copied, is editable again because the clone is a draft (the plan lock only
  // applies once a campaign is scheduled or running).
  const r = await c.env.DB.prepare(
    `INSERT INTO campaigns (name, template_id, external_template_id, list_id, segment_id, audience_filter,
                            var_mapping, body_html, subject, sending_domain, from_name, from_email, reply_to,
                            daily_cap, send_days, send_time, send_timezone, ramp_start, ramp_days, spread_minutes,
                            status, scheduled_at, started_at, finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft', NULL, NULL, NULL)`,
  )
    .bind(
      name,
      src.template_id ?? null,
      src.external_template_id ?? null,
      // Excluding: point at the remainder list and clear the other audience
      // fields, so the target is unambiguous (resolveAudience prefers
      // segment_id, which would otherwise silently win over the new list).
      // Not excluding: copy the original audience verbatim.
      excludeAlreadySent ? listId : (src.list_id ?? null),
      excludeAlreadySent ? null : (src.segment_id ?? null),
      excludeAlreadySent ? null : (src.audience_filter ?? null),
      src.var_mapping ?? null,
      src.body_html ?? null,
      src.subject ?? null,
      src.sending_domain ?? null,
      src.from_name ?? null,
      src.from_email ?? null,
      src.reply_to ?? null,
      src.daily_cap ?? null,
      src.send_days ?? null,
      src.send_time ?? null,
      src.send_timezone ?? null,
      src.ramp_start ?? null,
      src.ramp_days ?? null,
      src.spread_minutes ?? null,
    )
    .run();
  const newId = Number(r.meta.last_row_id);

  const tags = await listCampaignTags(c.env, id);
  if (tags.length) await setCampaignTags(c.env, newId, tags);

  return c.json({
    id: newId,
    name,
    exclude_already_sent: excludeAlreadySent,
    list_id: listId,
    list_name: listName,
    audience_count: audienceCount,
    remainder_count: remainderCount,
    excluded_already_sent: excludedCount,
    tags,
  });
});

campaignsRoutes.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const parsed = campaignSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  if ("subject" in parsed.data) {
    const subjectError = subjectLengthError(parsed.data.subject);
    if (subjectError) return c.json({ error: subjectError }, 400);
  }

  // Sending-domain rule on the From address (validated on save going forward).
  if ("from_email" in parsed.data) {
    const fromDomainError = await campaignFromDomainError(c.env, parsed.data.from_email);
    if (fromDomainError) return c.json({ error: fromDomainError }, 400);
  }

  // The daily-batch plan decides how much goes out each day, so it is only
  // editable while the campaign is still a draft or waiting to start. Once it
  // is sending, the plan cannot be changed underneath a running drip: that is
  // the difference between configuring a plan and silently re-scaling one.
  const PLAN_FIELDS = [
    "daily_cap",
    "send_days",
    "send_time",
    "send_timezone",
    "ramp_start",
    "ramp_days",
    "spread_minutes",
  ] as const;
  if (PLAN_FIELDS.some((k) => k in parsed.data)) {
    const cur = await c.env.DB.prepare("SELECT status FROM campaigns WHERE id=?")
      .bind(id)
      .first<{ status: string }>();
    if (!cur) return c.json({ error: "not found" }, 404);
    if (cur.status !== "draft" && cur.status !== "scheduled") {
      return c.json(
        {
          error: `cannot change the sending schedule of a campaign in status ${cur.status} — pause it, or set the plan before it starts`,
        },
        400,
      );
    }
  }

  // Validate the campaign body against the template it will end up on, which
  // may come from this patch or from the row as it stands.
  if (
    "body_html" in parsed.data ||
    "template_id" in parsed.data ||
    "external_template_id" in parsed.data
  ) {
    const cur = await c.env.DB.prepare(
      "SELECT template_id, external_template_id, body_html FROM campaigns WHERE id=?",
    )
      .bind(id)
      .first<{
        template_id: number | null;
        external_template_id: string | null;
        body_html: string | null;
      }>();
    if (!cur) return c.json({ error: "not found" }, 404);
    const nextBody =
      "body_html" in parsed.data ? normalizeBodyText(parsed.data.body_html) : cur.body_html;
    const nextTemplate =
      "template_id" in parsed.data ? (parsed.data.template_id ?? null) : cur.template_id;
    const nextExternal =
      "external_template_id" in parsed.data
        ? (parsed.data.external_template_id ?? null)
        : cur.external_template_id;
    const bodyError = await campaignBodyError(c.env, nextBody, nextTemplate, nextExternal);
    if (bodyError) return c.json({ error: bodyError }, 400);
  }

  const sets: string[] = [];
  const binds: any[] = [];
  for (const [k, v] of Object.entries(parsed.data)) {
    if (k === "tags") continue; // handled via campaign_tags below
    if (k === "audience_filter") {
      sets.push("audience_filter = ?");
      binds.push(v ? JSON.stringify(v) : null);
    } else if (k === "var_mapping") {
      sets.push("var_mapping = ?");
      binds.push(v && Object.keys(v as object).length ? JSON.stringify(v) : null);
    } else if (k === "body_html") {
      sets.push("body_html = ?");
      binds.push(normalizeBodyText(v));
    } else if (k === "subject") {
      sets.push("subject = ?");
      binds.push(normalizeSubject(v));
    } else if (k === "sending_domain") {
      // Normalise on write (lowercase, trailing dot, blank -> NULL) so a
      // first-label truncation can never reach the row again.
      sets.push("sending_domain = ?");
      binds.push(normalizeSendingDomain(v) ?? null);
    } else if (k === "reply_to") {
      sets.push("reply_to = ?");
      binds.push(v || null);
    } else if (k === "daily_cap") {
      // 0/negative/blank all normalise to NULL = no cap.
      sets.push("daily_cap = ?");
      binds.push(normalizeDailyCap(v));
    } else if (k === "send_days") {
      // Stored as the CSV list ("1,2,3,4,5"); an empty selection is NULL =
      // any day.
      sets.push("send_days = ?");
      binds.push(formatSendDays((v as number[] | null) ?? null));
    } else if (k === "send_time") {
      sets.push("send_time = ?");
      binds.push(normalizeSendTime(v));
    } else if (k === "send_timezone") {
      // Validated by the schema; blank means "follow the Worker default".
      sets.push("send_timezone = ?");
      binds.push(isValidTimeZone(v) ? (v as string).trim() : null);
    } else if (k === "ramp_start") {
      // 0/negative/blank all normalise to NULL = no ramp (flat cap from day one).
      sets.push("ramp_start = ?");
      binds.push(normalizeRampStart(v));
    } else if (k === "ramp_days") {
      sets.push("ramp_days = ?");
      binds.push(normalizeRampDays(v));
    } else if (k === "spread_minutes") {
      // 0/blank/negative all normalise to NULL = no spread (today's behaviour).
      sets.push("spread_minutes = ?");
      binds.push(normalizeSpreadMinutes(v));
    } else {
      sets.push(`${k} = ?`);
      binds.push(v as any);
    }
  }
  if (sets.length) {
    binds.push(id);
    await c.env.DB.prepare(`UPDATE campaigns SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...binds)
      .run();
  }
  if (parsed.data.tags) await setCampaignTags(c.env, id, parsed.data.tags);
  return c.json({ ok: true });
});

campaignsRoutes.post("/:id/pause", async (c) => {
  await c.env.DB.prepare("UPDATE campaigns SET status='paused' WHERE id=? AND status='sending'")
    .bind(Number(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});

campaignsRoutes.post("/:id/resume", async (c) => {
  await c.env.DB.prepare("UPDATE campaigns SET status='sending' WHERE id=? AND status='paused'")
    .bind(Number(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});

async function loadCampaignTemplate(env: Env, camp: any): Promise<
  | { kind: "local"; tmpl: TemplateRow }
  | { kind: "smtp2go"; templateId: string; subject: string }
  | null
> {
  if (camp.external_template_id) {
    return { kind: "smtp2go", templateId: camp.external_template_id, subject: "" };
  }
  if (camp.template_id) {
    const tmpl = await env.DB.prepare("SELECT * FROM templates WHERE id=?")
      .bind(camp.template_id)
      .first<TemplateRow>();
    if (!tmpl) return null;
    if (tmpl.source === "smtp2go" && tmpl.external_id) {
      return { kind: "smtp2go", templateId: tmpl.external_id, subject: tmpl.subject };
    }
    return { kind: "local", tmpl };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Test sends (test-only: never touches the audience or the queue)
// ---------------------------------------------------------------------------
//
// "Who receives it" and "whose data it renders as" are separate things. The
// recipient list is only ever what the caller typed — a test send can never
// reach an audience contact — while the VALUES come from an optional render
// contact chosen in the UI. With no render contact the recipient address is
// tried as a contact first (the behaviour that left every mapped variable blank
// when testing to your own inbox), and only then does the render fall back to
// the shared sample-value resolver.
type RenderSource = "contact" | "recipient" | "sample";

async function lookupContactByEmail(env: Env, email: string): Promise<ContactRow | null> {
  return await env.DB.prepare("SELECT * FROM contacts WHERE email = ?")
    .bind(email.toLowerCase())
    .first<ContactRow>();
}

/**
 * The contact named by the caller (`contact_id` and/or `contact_email`), or null
 * when none was named. A named contact that does not exist is an error rather
 * than a silent sample render: the operator asked for that clinic's data.
 */
async function loadNamedContact(
  env: Env,
  body: { contact_id?: unknown; contact_email?: unknown },
): Promise<{ contact: ContactRow | null; error?: string; status?: 400 | 404 }> {
  const rawId = body?.contact_id;
  if (rawId !== undefined && rawId !== null && String(rawId).trim() !== "") {
    const id = Number(rawId);
    if (!Number.isSafeInteger(id)) {
      return { contact: null, error: "contact_id must be an integer", status: 400 };
    }
    const row = await env.DB.prepare("SELECT * FROM contacts WHERE id=?")
      .bind(id)
      .first<ContactRow>();
    if (!row) return { contact: null, error: "render contact not found", status: 404 };
    return { contact: row };
  }
  const rawEmail = body?.contact_email;
  if (typeof rawEmail === "string" && rawEmail.trim()) {
    const row = await lookupContactByEmail(env, rawEmail.trim());
    if (!row) return { contact: null, error: "render contact not found", status: 404 };
    return { contact: row };
  }
  return { contact: null };
}

/** The small, non-secret identity a render reports back. Never the api_key. */
function renderContactSummary(c: ContactRow) {
  return {
    id: c.id,
    email: c.email,
    business_name: c.practice_name || c.first_name || c.email,
  };
}

/**
 * Variables for one test/preview render.
 *
 * A real contact resolves exactly like production (mappedVars, href context
 * included). With no contact the mapped values come from the shared
 * sample-value resolver — so a hybrid {{api_key}} inside a button URL still
 * resolves to a link-shaped value — instead of leaving every mapped variable
 * empty.
 */
function testRenderVars(
  mapping: VarMapping | null,
  urlVars: Set<string> | null,
  contact: ContactRow | null,
  to: string,
): { vars: Record<string, unknown>; unresolved: string[] } {
  if (!mapping || Object.keys(mapping).length === 0) {
    if (contact) return { vars: contactVars(contact), unresolved: [] };
    return { vars: sampleContactVars(to), unresolved: [] };
  }
  if (contact) return { vars: mappedVars(contact, mapping, to, urlVars), unresolved: [] };
  const samples = sampleVarsForMapping(mapping);
  const vars: Record<string, unknown> = { ...samples.values };
  if (!("email" in vars)) vars.email = to;
  return { vars, unresolved: samples.unresolved };
}

/**
 * What the operator needs to judge a test before it goes out: the links that
 * will be in it, and the variables that rendered empty (a link variable that
 * renders empty is the broken button). Only link-shaped values are surfaced.
 */
function renderPreview(
  vars: Record<string, unknown>,
  urlVars: Set<string> | null,
  unresolved: string[],
): { links: { name: string; url: string }[]; empty: string[] } {
  const links: { name: string; url: string }[] = [];
  const empty: string[] = [];
  for (const [name, value] of Object.entries(vars)) {
    if (name === "email") continue;
    const s = value == null ? "" : String(value);
    if (!s) {
      empty.push(name);
      continue;
    }
    if (urlVars?.has(name) || /^(?:https?|mailto):/i.test(s)) links.push({ name, url: s });
  }
  for (const name of unresolved) if (!empty.includes(name)) empty.push(name);
  return { links, empty };
}

/** Shared setup for the two test-only endpoints. */
async function loadTestRenderContext(env: Env, campId: number) {
  const camp = await env.DB.prepare("SELECT * FROM campaigns WHERE id=?")
    .bind(campId)
    .first<any>();
  if (!camp) return { error: "campaign not found", status: 404 as const };
  const t = await loadCampaignTemplate(env, camp);
  if (!t) return { error: "template missing", status: 400 as const };
  const campaignBody = camp.body_html ?? null;
  const mapping = parseMapping(camp.var_mapping);
  // Same render rules as production, href variables included (a test send must
  // show what the campaign will actually send).
  const urlVars = t.kind === "local" ? urlContextVars(t.tmpl.html, campaignBody) : null;
  return { camp, t, campaignBody, mapping, urlVars };
}

// What a test send would render as, without sending anything. The UI calls this
// with the picked contact and shows the business name and resolved links BEFORE
// the operator clicks Send test.
campaignsRoutes.get("/:id/test-render", async (c) => {
  const ctx = await loadTestRenderContext(c.env, Number(c.req.param("id")));
  if ("error" in ctx) return c.json({ error: ctx.error }, ctx.status);
  const named = await loadNamedContact(c.env, {
    contact_id: c.req.query("contact_id"),
    contact_email: c.req.query("contact_email"),
  });
  if (named.error) return c.json({ error: named.error }, named.status ?? 400);
  const contact = named.contact;
  // No contact named = the sample render. There is no recipient in a preview, so
  // "recipient" cannot apply here.
  const to = contact?.email ?? "";
  const { vars, unresolved } = testRenderVars(ctx.mapping, ctx.urlVars, contact, to);
  const preview = renderPreview(vars, ctx.urlVars, unresolved);
  return c.json({
    render_source: contact ? "contact" : "sample",
    render_contact: contact ? renderContactSummary(contact) : null,
    links: preview.links,
    empty: preview.empty,
  });
});

// Read-only: contacts from the campaign's OWN audience, for the render picker.
// Resolves the same audience the send path uses; it writes nothing.
campaignsRoutes.get("/:id/audience-contacts", async (c) => {
  const camp = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id=?")
    .bind(Number(c.req.param("id")))
    .first<any>();
  if (!camp) return c.json({ rows: [], total: 0 }, 404);
  const audience = await resolveAudience(c.env, camp);
  const total = audience.rows.length;
  if (audience.degraded) {
    return c.json({ rows: [], total: 0, warnings: audience.warnings, degraded: true });
  }
  // Ids are inlined as integer literals: a bound IN(...) list would blow past
  // D1's bound-variable limit for any sizeable audience (the same approach the
  // contacts route uses). The cap is reported so a truncated picker can say so.
  const allIds = audience.rows.map((r) => Number(r.id)).filter((n) => Number.isSafeInteger(n));
  const ids = allIds.slice(0, 20000);
  if (!ids.length) {
    return c.json({ rows: [], total, warnings: audience.warnings, degraded: false, truncated: false });
  }
  const q = (c.req.query("q") ?? "").trim();
  const random = c.req.query("random") === "1";
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 20) || 20));
  const where = [`c.id IN (${ids.join(",")})`];
  const binds: any[] = [];
  if (q) {
    where.push("(c.email LIKE ? OR c.practice_name LIKE ? OR c.first_name LIKE ?)");
    const like = `%${q}%`;
    binds.push(like, like, like);
  }
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.email, c.practice_name, c.first_name FROM contacts c
     WHERE ${where.join(" AND ")}
     ORDER BY ${random ? "RANDOM()" : "c.practice_name, c.id"} LIMIT ?`,
  )
    .bind(...binds, random ? 1 : limit)
    .all<any>();
  return c.json({
    rows: rows.results.map((r) => ({
      id: r.id,
      email: r.email,
      business_name: r.practice_name || r.first_name || r.email,
    })),
    total,
    warnings: audience.warnings,
    degraded: false,
    truncated: allIds.length > ids.length,
  });
});

// Test send to up to 5 explicit addresses (synchronous, no queue)
campaignsRoutes.post("/:id/test", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}) as any);
  const addrs = z
    .array(z.string().email())
    .max(5)
    .parse(body.to ?? []);
  const ctx = await loadTestRenderContext(c.env, id);
  if ("error" in ctx) return c.json({ error: ctx.error }, ctx.status);
  const { camp, t, campaignBody, mapping, urlVars } = ctx;
  // Same from-address fallback production uses, so a campaign with no explicit
  // from_email does not test differently to how it sends.
  const fromEmail = camp.from_email || c.env.DEFAULT_FROM_EMAIL || "";
  // A render contact named by the caller is the SAME data for every recipient;
  // the recipient list is never consulted for it.
  const named = await loadNamedContact(c.env, body);
  if (named.error) return c.json({ error: named.error }, named.status ?? 400);
  const results: any[] = [];
  // The pre-send spam check runs on the SAME rendered subject/body this test
  // send uses (first recipient), so a test send reports the check as well as
  // delivering the message. Nothing leaves the Worker — see shared/spamCheck.ts.
  let spam: SpamCheckResult | null = null;
  const sources = new Set<RenderSource>();
  let renderContact = named.contact ? renderContactSummary(named.contact) : null;
  for (const to of addrs) {
    let contact = named.contact;
    let source: RenderSource;
    if (contact) {
      source = "contact";
    } else {
      // No render contact: the recipient address is tried as a real contact so
      // the mapped values reflect what will actually be sent in production.
      contact = await lookupContactByEmail(c.env, to);
      source = contact ? "recipient" : "sample";
    }
    if (!renderContact && contact) renderContact = renderContactSummary(contact);
    sources.add(source);
    // Test sends use the campaign body too, so what lands in the inbox is what
    // the campaign will actually send.
    const { vars } = testRenderVars(mapping, urlVars, contact, to);
    // Render once, then both check and send exactly what was rendered.
    const subjectLine =
      t.kind === "smtp2go"
        ? renderSubject(camp.subject, t.subject, vars)
        : renderSubject(camp.subject, t.tmpl.subject, vars);
    const htmlBody = t.kind === "smtp2go" ? "" : renderBody(t.tmpl.html, vars, campaignBody);
    const textBody =
      t.kind === "smtp2go"
        ? ""
        : t.tmpl.text
          ? renderTextBody(t.tmpl.text, vars, bodyPlainText(campaignBody))
          : "";
    if (!spam) {
      spam = checkSpam({
        subject: subjectLine,
        html: htmlBody,
        text: textBody,
        // Same fallback the send path uses, so the check sees the address that
        // will actually be on the message.
        from: fromEmail,
        replyTo: camp.reply_to ?? "",
        bodyNote:
          t.kind === "smtp2go"
            ? "the body content (SMTP2GO renders this template's body server-side — only the subject and the sender details could be checked)"
            : null,
      });
    }
    // The envelope is built exactly like production's (same sender line, same
    // resolved subject, same X-Campaign-ID/Reply-To headers) — a test send that
    // omits the Reply-To header is the bug this fixes. A test queues no send
    // row, so there is no X-Send-ID to identify.
    const envelope = sendEnvelope({
      campaignId: camp.id,
      sendId: null,
      fromName: camp.from_name,
      fromEmail,
      replyTo: camp.reply_to,
      subject: subjectLine,
    });
    try {
      const r =
        t.kind === "smtp2go"
          ? await smtp2goSend(c.env.SMTP2GO_API_KEY, {
              ...envelope,
              to: [to],
              template_id: t.templateId,
              version: 1,
              template_data: vars,
            })
          : await smtp2goSend(c.env.SMTP2GO_API_KEY, {
              ...envelope,
              to: [to],
              html_body: htmlBody,
              text_body: textBody || undefined,
            });
      results.push({ to, ok: true, id: r.data?.email_id ?? r.request_id, render_source: source });
    } catch (e: any) {
      results.push({ to, ok: false, error: e.message, render_source: source });
    }
  }
  // The response names the render source per recipient and, at the top level,
  // the strongest one used — "contact" beats "recipient" beats "sample".
  const render_source: RenderSource = sources.has("contact")
    ? "contact"
    : sources.has("recipient")
      ? "recipient"
      : "sample";
  return c.json({ results, spam, render_source, render_contact: renderContact });
});

// Resolve campaign audience to {id,email} rows
async function resolveAudience(
  env: Env,
  camp: any,
): Promise<{ rows: { id: number; email: string }[]; warnings: string[]; degraded: boolean }> {
  if (camp.segment_id) {
    const seg = await env.DB.prepare("SELECT filter_json FROM lists WHERE id=?")
      .bind(camp.segment_id)
      .first<{ filter_json: string | null }>();
    const filter = seg?.filter_json ? JSON.parse(seg.filter_json) : {};
    return await resolveSegmentRows(env, filter, { forSending: true });
  }
  if (camp.list_id) {
    // Verification blocklist (shared/emailStatus.ts) applies to every send path;
    // this is the choke point both the manual send and the drip dispatcher use.
    const binds: any[] = [camp.list_id];
    const sendable = sendableContactFilter("c", binds);
    const r = await env.DB.prepare(
      `SELECT c.id, c.email FROM contacts c
       JOIN list_members lm ON lm.contact_id = c.id
       WHERE lm.list_id = ? AND c.status='active'
         AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = c.email)
         AND ${sendable}`,
    )
      .bind(...binds)
      .all<{ id: number; email: string }>();
    return { rows: r.results, warnings: [], degraded: false };
  }
  const binds: any[] = [];
  const sendable = sendableContactFilter("contacts", binds);
  const r = await env.DB.prepare(
    `SELECT id, email FROM contacts
     WHERE status='active'
       AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = contacts.email)
       AND ${sendable}`,
  ).bind(...binds).all<{ id: number; email: string }>();
  return { rows: r.results, warnings: [], degraded: false };
}


// Preview audience size for the campaign as configured
campaignsRoutes.get("/:id/audience-count", async (c) => {
  const id = Number(c.req.param("id"));
  const camp = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id=?").bind(id).first<any>();
  if (!camp) return c.json({ count: 0, warnings: [], degraded: false });
  const a = await resolveAudience(c.env, camp);
  return c.json({ count: a.rows.length, warnings: a.warnings, degraded: a.degraded });
});

/**
 * Shared enqueue path used by manual send and the scheduled dispatcher.
 * Returns the number of jobs enqueued. Throws on validation errors.
 */
export async function enqueueCampaign(env: Env, id: number): Promise<number> {
  const camp = await env.DB.prepare("SELECT * FROM campaigns WHERE id=?").bind(id).first<any>();
  if (!camp) throw new Error("campaign not found");
  // The tag-trigger container is never a blast: it has no list/segment, so an
  // accidental send would target every active contact.
  if (isGhlTagTriggerCampaign(camp)) {
    throw new Error(
      "this campaign is a container for GHL tag-triggered sends and is never dispatched",
    );
  }
  if (camp.status !== "draft" && camp.status !== "scheduled") {
    throw new Error(`cannot send in status ${camp.status}`);
  }
  // Defensive: a planned campaign must never be handed the whole audience at
  // once. The dispatcher routes it to runPlanTick instead.
  if (hasSendPlan(camp)) {
    throw new Error("campaign has a sending plan — the daily-batch dispatcher releases it");
  }
  if (!camp.from_email || (!camp.template_id && !camp.external_template_id)) {
    throw new Error("template and from_email required");
  }
  const audience = await resolveAudience(env, camp);
  if (audience.degraded) throw new Error("segment could not be evaluated");
  const recipients = audience.rows;
  if (!recipients.length) throw new Error("audience is empty");

  await env.DB.prepare("UPDATE campaigns SET status='sending', started_at=unixepoch() WHERE id=?")
    .bind(id)
    .run();

  // 1) Insert all send rows. Each statement binds 3 variables, well under D1's
  //    100-bound-variable-per-statement limit; batches are chunked for size.
  const INSERT_CHUNK = 50;
  for (let i = 0; i < recipients.length; i += INSERT_CHUNK) {
    const chunk = recipients.slice(i, i + INSERT_CHUNK);
    const stmts = chunk.map((r) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO sends (campaign_id, contact_id, email, status) VALUES (?,?,?, 'queued')",
      ).bind(id, r.id, r.email),
    );
    await env.DB.batch(stmts);
  }

  // 2) Page through the queued sends by primary key. No variable-length IN(...)
  //    list, so bound variables stay constant regardless of audience size.
  const PAGE = 100; // also the Cloudflare Queues sendBatch limit
  let lastId = 0;
  let enqueued = 0;
  for (;;) {
    const sendRows = await env.DB.prepare(
      `SELECT id, contact_id, email FROM sends
       WHERE campaign_id=? AND status='queued' AND sent_at IS NULL AND id > ?
       ORDER BY id LIMIT ?`,
    )
      .bind(id, lastId, PAGE)
      .all<{ id: number; contact_id: number; email: string }>();

    const rows = sendRows.results;
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;

    const jobs: SendJob[] = rows.map((s) => ({
      campaign_id: id,
      send_id: s.id,
      contact_id: s.contact_id,
      email: s.email,
    }));
    await env.SEND_QUEUE.sendBatch(jobs.map((body) => ({ body })));
    enqueued += jobs.length;

    if (rows.length < PAGE) break;
  }
  return enqueued;
}

// ---------------------------------------------------------------------------
// Daily-batch ("drip") sending plan
// ---------------------------------------------------------------------------
//
// A campaign with a plan (daily_cap / send_days / send_time) is never released
// in one go. The every-minute cron calls runPlanTick, which:
//   * only acts on an allowed weekday, at/after send_time local;
//   * starts the campaign (scheduled -> sending) at the first open window;
//   * releases at most `daily_cap - already released today` recipients, where
//     "today" is the local calendar day of the campaign's send_timezone;
//   * leaves the campaign 'sending' until the audience is exhausted.
//
// There is deliberately no "batch released" flag anywhere. The allowance is
// recomputed from the sends table on every tick, so the sixty ticks an hour —
// or a tick that is re-entered — cannot release twice.

/** Zone a campaign's window is measured in: its own override, else the Worker var. */
export function planTimeZone(env: Env, camp: any): string {
  return resolveTimeZone(camp?.send_timezone, env.SEND_TIMEZONE ?? DEFAULT_SEND_TIMEZONE);
}

/** Contacts that already carry a sends row for this campaign, in any status. */
async function existingSendContactIds(env: Env, campaignId: number): Promise<Set<number>> {
  const rows = await env.DB.prepare("SELECT contact_id FROM sends WHERE campaign_id=?")
    .bind(campaignId)
    .all<{ contact_id: number | null }>();
  const out = new Set<number>();
  for (const r of rows.results ?? []) if (r.contact_id != null) out.add(Number(r.contact_id));
  return out;
}

/**
 * The ONE definition of "this sends row belongs to the campaign's local day":
 * a row counts for the local day it was *released* (queued_at) into, or the day
 * it was *sent* (sent_at) on — both measured against the campaign timezone's
 * day boundary, never UTC. Rows skipped because they were suppressed never went
 * anywhere, so they do not consume the cap.
 *
 * Both the counter (`releasedTodayCount`) and the ceiling the release insert
 * enforces (`releaseCampaignBatch`) are built from this same text, so the
 * number the dispatcher reads and the number the write enforces cannot drift
 * apart. Qualified with the table name so it embeds in either a SELECT or a
 * subquery.
 */
const RELEASED_IN_DAY = `sends.campaign_id = ?
  AND NOT (sends.status = 'skipped' AND sends.sent_at IS NULL)
  AND (
    (sends.sent_at IS NOT NULL AND sends.sent_at >= ? AND sends.sent_at < ?)
    OR (sends.sent_at IS NULL AND sends.queued_at >= ? AND sends.queued_at < ?)
  )`;

/** The binds `RELEASED_IN_DAY` expects, in order. */
function releasedInDayBinds(campaignId: number, day: { start: number; end: number }) {
  return [campaignId, day.start, day.end, day.start, day.end];
}

/**
 * How many recipients this campaign has already used up on the local day
 * containing `nowSeconds`.
 *
 * Read-only. It sizes a tick's attempt (and reports whether the day is spent);
 * what a release may actually write is enforced by the insert itself — see
 * `releaseCampaignBatch`.
 */
export async function releasedTodayCount(
  env: Env,
  campaignId: number,
  timezone: string,
  nowSeconds: number,
): Promise<number> {
  const day = localDayWindow(nowSeconds, timezone);
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sends WHERE ${RELEASED_IN_DAY}`)
    .bind(...releasedInDayBinds(campaignId, day))
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * Cap on how far back the ramp walk goes, so a malformed plan cannot turn one
 * tick into an unbounded scan. In practice the walk stops as soon as it has
 * found enough sending days, or once it passes the campaign's own start.
 */
const MAX_RAMP_LOOKBACK = 400;

/**
 * How many sending days this campaign has already used strictly BEFORE the
 * local day containing `nowSeconds` - the k the ramp's day index is measured
 * from.
 *
 * Derived from the sends table (the distinct local days that actually have
 * sends), exactly like releasedTodayCount and for the same reason: a re-entered
 * cron tick, a reaped run or a pause/resume must all land on the same step, so
 * there is no stored counter that can drift. Only distinct DAYS count - 500
 * sends on one day are one step - and a day that sent nothing (a skipped
 * weekend, a paused day) never consumes a step.
 *
 * The walk starts at yesterday and stops as soon as `limit` days are found:
 * past that point the caller no longer needs the exact number, because every
 * day from `ramp_days` on is the full cap. It also stops once it passes the
 * campaign's own `started_at`, so a young campaign costs a day or two of
 * probes rather than a full scan.
 */
async function sendingDaysBefore(
  env: Env,
  camp: any,
  timezone: string,
  nowSeconds: number,
  limit: number,
): Promise<number> {
  const need = Math.max(0, Math.floor(limit));
  if (need <= 0) return 0;
  const startedAt = Number(camp.started_at ?? 0);
  let dayStart = localDayWindow(nowSeconds, timezone).start;
  let found = 0;
  for (let back = 0; back < MAX_RAMP_LOOKBACK && found < need; back++) {
    // One second before this local day's start is the previous local day.
    const window = localDayWindow(dayStart - 1, timezone);
    dayStart = window.start;
    // No sending day can precede the instant the campaign started.
    if (startedAt > 0 && window.end <= startedAt) break;
    const hit = await env.DB.prepare(
      `SELECT 1 AS x FROM sends
        WHERE campaign_id = ?
          AND NOT (status = 'skipped' AND sent_at IS NULL)
          AND (
            (sent_at IS NOT NULL AND sent_at >= ? AND sent_at < ?)
            OR (sent_at IS NULL AND queued_at >= ? AND queued_at < ?)
          )
        LIMIT 1`,
    )
      .bind(camp.id, window.start, window.end, window.start, window.end)
      .first();
    if (hit) found += 1;
  }
  return found;
}

/** Audience members this campaign has not released a sends row for yet. */
export async function remainingAudienceCount(env: Env, camp: any): Promise<number> {
  const audience = await resolveAudience(env, camp);
  if (audience.degraded) throw new Error("segment could not be evaluated");
  if (!audience.rows.length) return 0;
  const already = await existingSendContactIds(env, camp.id);
  return audience.rows.filter((r) => !already.has(r.id)).length;
}

/**
 * Release up to `limit` recipients: take audience members with no sends row yet,
 * insert exactly those rows, and queue exactly the rows this call inserted.
 * Returns how many were released.
 *
 * `nowSeconds` is the dispatcher's own instant and is stored as the rows'
 * queued_at: the day a batch belongs to is then a fact on the row, not a guess
 * from whatever clock the insert happened to run on.
 *
 * `ceiling` is the day's hard limit — what may exist in `sends` for this local
 * day once this call is done, whatever a count read earlier said. It is enforced
 * by the insert itself, in the same statement:
 *
 *   INSERT ... SELECT ... WHERE (SELECT COUNT(*) FROM sends WHERE <day>) < ?
 *
 * so a dispatcher tick cannot spend an allowance another tick is spending at the
 * same moment: the second write re-reads the table the first write wrote to and
 * inserts nothing. That is a conditional write, deliberately not a lock — there
 * is no claim to hold, so a tick that dies mid-release leaves nothing behind and
 * the next tick simply counts the table again. Null (a plan with no cap) inserts
 * without a guard, exactly as before. The count that sizes a tick's attempt is
 * `releasedTodayCount`, which uses the same RELEASED_IN_DAY predicate this guard
 * uses, so the two can never mean different things.
 */
export async function releaseCampaignBatch(
  env: Env,
  camp: any,
  limit: number,
  nowSeconds: number,
  ceiling: { timezone: string; max: number } | null = null,
): Promise<number> {
  const max = Math.floor(limit);
  if (!(max > 0)) return 0;
  const audience = await resolveAudience(env, camp);
  if (audience.degraded) throw new Error("segment could not be evaluated");
  const already = await existingSendContactIds(env, camp.id);
  const batch = audience.rows.filter((r) => !already.has(r.id)).slice(0, max);
  if (!batch.length) return 0;

  // The local day this batch is released into, and the ceiling its insert
  // enforces. A null ceiling means there is no cap to guard (no daily_cap).
  const guarded = ceiling != null && Number.isFinite(ceiling.max);
  const day = guarded ? localDayWindow(nowSeconds, ceiling!.timezone) : null;
  const maxForDay = guarded ? Math.max(0, Math.floor(ceiling!.max)) : null;

  // 1) Insert this batch only. UNIQUE(campaign_id, contact_id) with OR IGNORE
  //    means a re-entered tick cannot create a second row for a recipient, and
  //    the reported `changes` says which rows this call owns. With a ceiling the
  //    insert also refuses any row that would take the local day past it, which
  //    is what makes two overlapping ticks release the day's allowance once.
  const INSERT_CHUNK = 50;
  const inserted: { send_id: number; contact_id: number; email: string }[] = [];
  for (let i = 0; i < batch.length; i += INSERT_CHUNK) {
    const chunk = batch.slice(i, i + INSERT_CHUNK);
    const results = await env.DB.batch(
      chunk.map((r) =>
        day
          ? env.DB.prepare(
              `INSERT OR IGNORE INTO sends (campaign_id, contact_id, email, status, queued_at)
               SELECT ?, ?, ?, 'queued', ?
                WHERE (SELECT COUNT(*) FROM sends WHERE ${RELEASED_IN_DAY}) < ?`,
            ).bind(
              camp.id,
              r.id,
              r.email,
              nowSeconds,
              ...releasedInDayBinds(camp.id, day),
              maxForDay,
            )
          : env.DB.prepare(
              "INSERT OR IGNORE INTO sends (campaign_id, contact_id, email, status, queued_at) VALUES (?,?,?, 'queued', ?)",
            ).bind(camp.id, r.id, r.email, nowSeconds),
      ),
    );
    results.forEach((res: any, idx: number) => {
      if (Number(res?.meta?.changes ?? 0) > 0) {
        inserted.push({
          send_id: Number(res.meta.last_row_id),
          contact_id: chunk[idx].id,
          email: chunk[idx].email,
        });
      }
    });
  }

  // 2) Queue only what this call inserted — never a blanket "all queued rows",
  //    so two ticks can never hand the same batch to the queue twice.
  const PAGE = 100; // Cloudflare Queues sendBatch limit
  for (let i = 0; i < inserted.length; i += PAGE) {
    const jobs: SendJob[] = inserted.slice(i, i + PAGE).map((s) => ({
      campaign_id: camp.id,
      send_id: s.send_id,
      contact_id: s.contact_id,
      email: s.email,
    }));
    await env.SEND_QUEUE.sendBatch(jobs.map((body) => ({ body })));
  }
  return inserted.length;
}

/**
 * Settle a running campaign: mark it 'sent' once nothing is queued AND there is
 * no audience left to release. A planned campaign that still has recipients
 * waiting for a later window stays 'sending' — that is the whole point of a
 * drip — so the consumer and the UI's refresh-status both go through here.
 * Returns true when the campaign was marked sent.
 */
export async function settleFinishedCampaign(env: Env, campaignId: number): Promise<boolean> {
  const camp = await env.DB.prepare("SELECT * FROM campaigns WHERE id=?")
    .bind(campaignId)
    .first<any>();
  if (!camp) return false;
  if (camp.status !== "sending" && camp.status !== "paused") return false;

  const queued = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM sends WHERE campaign_id=? AND status='queued'",
  )
    .bind(campaignId)
    .first<{ n: number }>();
  if ((queued?.n ?? 0) > 0) return false;

  if (hasSendPlan(camp)) {
    const remaining = await remainingAudienceCount(env, camp);
    if (remaining > 0) return false; // more batches on later days
  }

  await env.DB.prepare(
    "UPDATE campaigns SET status='sent', finished_at=COALESCE(finished_at, unixepoch()) WHERE id=? AND status IN ('sending','paused')",
  )
    .bind(campaignId)
    .run();
  return true;
}

export type PlanTickAction =
  | "released"
  | "before-window"
  | "day-skipped"
  | "not-due"
  | "cap-reached"
  | "paced"
  | "waiting"
  | "finished";

export interface PlanTickResult {
  id: number;
  action: PlanTickAction;
  released: number;
  timezone: string;
}

/**
 * One dispatcher pass over a single planned campaign. Safe to run as often as
 * the cron fires: the allowance is recomputed, never remembered.
 */
export async function runPlanTick(
  env: Env,
  camp: any,
  opts: { nowSeconds?: number } = {},
): Promise<PlanTickResult> {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const timezone = planTimeZone(env, camp);
  const sendDays = parseSendDays(camp.send_days);
  const sendTime = parseSendTime(camp.send_time);
  const base = { id: Number(camp.id), timezone };

  const nowPlan = evaluatePlanNow({ nowSeconds: now, timezone, sendDays, sendTime });
  if (!nowPlan.dayAllowed) return { ...base, action: "day-skipped", released: 0 };
  if (!nowPlan.windowOpen) return { ...base, action: "before-window", released: 0 };
  if (camp.scheduled_at != null && now < Number(camp.scheduled_at)) {
    return { ...base, action: "not-due", released: 0 };
  }

  // The plan starts the campaign at the first open window. (A manual Start may
  // already have moved it to 'sending'.)
  if (camp.status === "scheduled") {
    await env.DB.prepare(
      "UPDATE campaigns SET status='sending', started_at=COALESCE(started_at, unixepoch()) WHERE id=? AND status='scheduled'",
    )
      .bind(camp.id)
      .run();
  }

  const cap = normalizeDailyCap(camp.daily_cap);
  const releasedToday = await releasedTodayCount(env, camp.id, timezone, now);
  // Today's allowance: the flat cap, or the ramp's step for the sending day
  // today is. The step comes from what the sends table already holds, so a
  // re-entered tick cannot advance the ramp and a skipped or paused day does
  // not consume one.
  let allowance = Number.MAX_SAFE_INTEGER;
  // The day's ceiling: what may exist in `sends` for this local day when this
  // tick is done. The count above sizes the attempt, but the ceiling is what the
  // release insert enforces, so two ticks that overlap cannot both spend the
  // day's allowance (null = a plan with no cap, nothing to enforce).
  let dayCeiling: number | null = null;
  // Today's allowance, kept for the re-check below so a spent day is reported
  // from a fresh count rather than from the one this tick started with.
  let dayAllowance: number | null = null;
  let paced = false;
  if (cap != null) {
    const ramp = sendRamp(camp);
    const prior = ramp ? await sendingDaysBefore(env, camp, timezone, now, ramp.days - 1) : 0;
    dayAllowance = todayRampAllowance(camp, prior) ?? cap;
    // A spread meters the day: release against the clock (`elapsed x rate`),
    // never against the tick count, so a missed tick releases the slices time
    // has earned rather than a backlog of whole batches. With no spread the
    // whole allowance is due the moment the window opens.
    const spread = normalizeSpreadMinutes(camp.spread_minutes);
    const target = spreadTarget({
      dayAllowance,
      spreadMinutes: spread,
      windowStartAt: currentWindowStart({ nowSeconds: now, timezone, sendTime }),
      nowSeconds: now,
    });
    dayCeiling = Math.max(0, Math.min(dayAllowance, target));
    allowance = dayCeiling - releasedToday;
    // Nothing due yet is the spread working, not the cap being spent.
    paced = spread != null && releasedToday < dayAllowance;
  }  if (allowance <= 0) {
    return { ...base, action: paced ? "paced" : "cap-reached", released: 0 };
  }

  const released = await releaseCampaignBatch(
    env,
    camp,
    allowance,
    now,
    dayCeiling == null ? null : { timezone, max: dayCeiling },
  );
  if (released > 0) return { ...base, action: "released", released };

  // The guard refused every row: another pass was writing at the same time and
  // took the day's ceiling first. Re-read instead of trusting the count this
  // tick started with, so the day is reported as spent rather than as waiting.
  if (dayCeiling != null) {
    const after = await releasedTodayCount(env, camp.id, timezone, now);
    if (after >= dayCeiling) {
      // The day's due slice is met; the day itself is only spent once the whole
      // allowance is in - a spread still has slices to come.
      const spent = dayAllowance == null || after >= dayAllowance;
      return { ...base, action: spent ? "cap-reached" : "paced", released: 0 };
    }
  }

  // Nothing to release: either the audience is exhausted (settle it) or the
  // remaining recipients already have rows in flight.
  if ((await remainingAudienceCount(env, camp)) === 0 && camp.status !== "draft") {
    await settleFinishedCampaign(env, camp.id);
    return { ...base, action: "finished", released: 0 };
  }
  return { ...base, action: "waiting", released: 0 };
}

/**
 * Everything the campaign editor needs to show a running plan: what has gone
 * out today, what is left, and when the last batch is projected to release.
 */
export async function campaignProgress(env: Env, camp: any, nowSeconds: number) {
  const timezone = planTimeZone(env, camp);
  const sendDays = parseSendDays(camp.send_days);
  const sendTime = parseSendTime(camp.send_time);
  const cap = normalizeDailyCap(camp.daily_cap);
  const planned = hasSendPlan(camp);
  const nowPlan = evaluatePlanNow({ nowSeconds, timezone, sendDays, sendTime });
  const day = localDayWindow(nowSeconds, timezone);

  const counts = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sent,
       SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued,
       SUM(CASE WHEN sent_at IS NOT NULL AND sent_at >= ? AND sent_at < ? THEN 1 ELSE 0 END) AS sent_today
     FROM sends WHERE campaign_id=?`,
  )
    .bind(day.start, day.end, camp.id)
    .first<any>();

  const releasedToday = await releasedTodayCount(env, camp.id, timezone, nowSeconds);
  const remaining = planned ? await remainingAudienceCount(env, camp) : 0;

  // The two derived facts the editor needs about the ramp: which sending
  // day today is, and what that day's allowance is. Both come from the sends
  // table (bounded by the ramp's own length, past which every day is the full
  // cap), and the query only runs when a ramp is actually in force.
  const ramp = sendRamp(camp);
  const priorSendingDays =
    ramp && cap != null
      ? await sendingDaysBefore(env, camp, timezone, nowSeconds, ramp.days - 1)
      : 0;
  const sendingDay = cap == null ? null : priorSendingDays + 1;
  const dayAllowance =
    cap == null ? null : (todayRampAllowance(camp, priorSendingDays) ?? cap);

  // What today can still release. null only when there is no cap at all (the
  // whole remaining audience goes out at the first window). With a spread this
  // is the slice the clock has reached, not the whole day's allowance.
  const spread = normalizeSpreadMinutes(camp.spread_minutes);
  const dueToday =
    dayAllowance == null
      ? null
      : spreadTarget({
          dayAllowance,
          spreadMinutes: spread,
          windowStartAt: currentWindowStart({ nowSeconds, timezone, sendTime }),
          nowSeconds,
        });
  const windowOpenToday = nowPlan.windowOpen;
  const todayAllowance =
    dayAllowance == null ? null : Math.max(0, (dueToday ?? dayAllowance) - releasedToday);
  // What today still releases in total by the end of its spread: the figure the
  // projection counts for today, since a spread meters the day rather than
  // shrinking it. Only the panel's "what can go now" number is the due slice.
  const todayDayAllowance =
    dayAllowance == null ? null : Math.max(0, dayAllowance - releasedToday);
  // Sending days used so far, counting today once it has really released
  // something: the step the projection continues the ramp from.
  const sendingDaysUsed = priorSendingDays + (releasedToday > 0 ? 1 : 0);

  const finish =
    planned && remaining > 0 && cap != null && cap > 0
      ? projectFinish({
          remaining,
          dailyCap: cap,
          sendDays,
          sendTime,
          timezone,
          nowSeconds,
          todayAllowance: windowOpenToday ? todayDayAllowance : 0,
          sendingDaysUsed,
          rampStart: camp.ramp_start ?? null,
          rampDays: camp.ramp_days ?? null,
          spreadMinutes: spread,
        })
      : null;

  return {
    planned,
    timezone,
    daily_cap: cap,
    ramp_start: normalizeRampStart(camp.ramp_start),
    ramp_days: normalizeRampDays(camp.ramp_days),
    ramp_active: !!ramp,
    ramp_words: rampScheduleWords(camp),
    spread_minutes: spread,
    spread_words: spreadWords(spread, cap, !!ramp),
    due_today: dueToday,
    sending_day: sendingDay,
    day_allowance: dayAllowance,
    send_days: sendDays,
    send_time: normalizeSendTime(camp.send_time),
    plan_words: planned ? planWords(camp, timezone) : null,
    day_key: day.dayKey,
    weekday: nowPlan.weekday,
    day_allowed: nowPlan.dayAllowed,
    window_open: windowOpenToday,
    next_window_at: nowPlan.nextWindowAt,
    released_today: releasedToday,
    sent_today: Number(counts?.sent_today ?? 0),
    today_allowance: todayAllowance,
    total: Number(counts?.total ?? 0),
    sent: Number(counts?.sent ?? 0),
    queued: Number(counts?.queued ?? 0),
    remaining,
    projected_finish_at: finish?.finishAt ?? null,
    projected_finish_day: finish?.finishDayKey ?? null,
    projected_days: finish?.days ?? null,
  };
}

// Manual send
campaignsRoutes.post("/:id/send", async (c) => {
  const id = Number(c.req.param("id"));
  try {
    const camp = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id=?").bind(id).first<any>();
    if (!camp) return c.json({ error: "campaign not found" }, 404);

    // A planned campaign is never a one-shot blast. "Send now" starts it: if
    // today's window is open the first batch goes out immediately, otherwise the
    // campaign waits for the next window (the cron releases it then).
    if (hasSendPlan(camp)) {
      if (camp.status !== "draft" && camp.status !== "scheduled" && camp.status !== "sending") {
        return c.json({ error: `cannot send in status ${camp.status}` }, 400);
      }
      if (!camp.from_email || (!camp.template_id && !camp.external_template_id)) {
        return c.json({ error: "template and from_email required" }, 400);
      }
      const now = Math.floor(Date.now() / 1000);
      const timezone = planTimeZone(c.env, camp);
      const nowPlan = evaluatePlanNow({
        nowSeconds: now,
        timezone,
        sendDays: parseSendDays(camp.send_days),
        sendTime: parseSendTime(camp.send_time),
      });
      if (!nowPlan.windowOpen) {
        await c.env.DB.prepare(
          "UPDATE campaigns SET status='scheduled', scheduled_at=? WHERE id=? AND status IN ('draft','scheduled')",
        )
          .bind(nowPlan.nextWindowAt, id)
          .run();
        return c.json({
          ok: true,
          planned: true,
          released: 0,
          action: "before-window",
          next_window_at: nowPlan.nextWindowAt,
          plan: planWords(camp, timezone),
        });
      }
      await c.env.DB.prepare(
        "UPDATE campaigns SET status='sending', started_at=COALESCE(started_at, unixepoch()) WHERE id=? AND status IN ('draft','scheduled')",
      )
        .bind(id)
        .run();
      const tick = await runPlanTick(
        c.env,
        { ...camp, status: "sending", scheduled_at: null },
        { nowSeconds: now },
      );
      return c.json({
        ok: true,
        planned: true,
        released: tick.released,
        action: tick.action,
        plan: planWords(camp, timezone),
      });
    }

    const enqueued = await enqueueCampaign(c.env, id);
    return c.json({ ok: true, enqueued });
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 400);
  }
});

// Schedule a campaign for a future send
campaignsRoutes.post("/:id/schedule", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const camp = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id=?").bind(id).first<any>();
  if (!camp) return c.json({ error: "campaign not found" }, 404);
  if (camp.status !== "draft" && camp.status !== "scheduled") {
    return c.json({ error: `cannot schedule in status ${camp.status}` }, 400);
  }
  if (!camp.from_email || (!camp.template_id && !camp.external_template_id)) {
    return c.json({ error: "template and from_email required" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const planned = hasSendPlan(camp);
  const requested = Number(body?.scheduled_at);
  let scheduled_at: number;
  if (Number.isFinite(requested)) {
    if (requested < now + 30) {
      return c.json({ error: "scheduled_at must be at least 30 seconds in the future" }, 400);
    }
    scheduled_at = requested;
  } else if (planned) {
    // A planned campaign needs no explicit moment: its window decides. Store the
    // next opening so the editor can show exactly when it starts and the
    // dispatcher will not release ahead of it.
    scheduled_at = evaluatePlanNow({
      nowSeconds: now,
      timezone: planTimeZone(c.env, camp),
      sendDays: parseSendDays(camp.send_days),
      sendTime: parseSendTime(camp.send_time),
    }).nextWindowAt;
  } else {
    return c.json({ error: "scheduled_at required (unix seconds)" }, 400);
  }

  const audience = await resolveAudience(c.env, camp);
  if (audience.degraded) {
    return c.json({ error: "segment could not be evaluated", warnings: audience.warnings }, 400);
  }
  if (!audience.rows.length) return c.json({ error: "audience is empty" }, 400);

  await c.env.DB.prepare("UPDATE campaigns SET status='scheduled', scheduled_at=? WHERE id=?")
    .bind(scheduled_at, id)
    .run();
  return c.json({
    ok: true,
    scheduled_at,
    count: audience.rows.length,
    planned,
    plan: planned ? planWords(camp, planTimeZone(c.env, camp)) : null,
  });
});

campaignsRoutes.post("/:id/unschedule", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare(
    "UPDATE campaigns SET status='draft', scheduled_at=NULL WHERE id=? AND status='scheduled'",
  ).bind(id).run();
  return c.json({ ok: true });
});

/**
 * Called by the Worker's scheduled() handler. Two passes:
 *
 *  1. Legacy one-shot campaigns — a single scheduled_at and no plan — released
 *     in full, exactly as before.
 *  2. Planned (daily-batch) campaigns — waiting for their first window
 *     ('scheduled') or mid-run ('sending'). Each tick recomputes that day's
 *     remaining allowance, so calling this sixty times an hour is harmless.
 *
 * A legacy failure marks the campaign as a draft so the operator can see what
 * happened; a plan failure is logged and left alone, then retried next tick.
 */
export async function dispatchDueCampaigns(
  env: Env,
  nowSeconds?: number,
): Promise<{ ran: number; ok: number; failed: number; plans: PlanTickResult[] }> {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const due = await env.DB.prepare(
    `SELECT id FROM campaigns
      WHERE status='scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?
        AND daily_cap IS NULL AND send_days IS NULL AND send_time IS NULL
        AND name != ?`,
  )
    .bind(now, GHL_TAG_TRIGGER_CAMPAIGN)
    .all<{ id: number }>();
  let ok = 0,
    failed = 0;
  for (const row of due.results) {
    try {
      await enqueueCampaign(env, row.id);
      ok++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error("scheduled dispatch failed", row.id, msg);
      await env.DB.prepare(
        "UPDATE campaigns SET status='draft' WHERE id=? AND status='scheduled'",
      )
        .bind(row.id)
        .run();
    }
  }

  const planned = await env.DB.prepare(
    `SELECT * FROM campaigns
      WHERE status IN ('scheduled','sending')
        AND (daily_cap IS NOT NULL OR send_days IS NOT NULL OR send_time IS NOT NULL)
        AND name != ?`,
  ).bind(GHL_TAG_TRIGGER_CAMPAIGN).all<any>();
  const plans: PlanTickResult[] = [];
  for (const camp of planned.results ?? []) {
    try {
      const tick = await runPlanTick(env, camp, { nowSeconds: now });
      plans.push(tick);
      if (tick.action === "released" || tick.action === "finished") ok++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error("plan dispatch failed", camp.id, msg);
    }
  }

  return { ran: due.results.length + (planned.results?.length ?? 0), ok, failed, plans };
}

