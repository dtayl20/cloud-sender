/**
 * The pseudo-campaign that collects GHL tag-triggered sends.
 *
 * `POST /api/webhooks/send-template` is not a campaign blast: each call is one
 * ad-hoc template to one contact. But a send with campaign_id = NULL shows on no
 * campaign in the UI, so its opens/clicks are invisible. Every such send instead
 * points at ONE shared container campaign, "GHL tag triggers", whose sent/opened
 * /clicked numbers then come from the normal per-campaign aggregation in
 * routes/campaigns.ts.
 *
 * The container must NEVER be dispatched as a scheduled blast. Two independent
 * things guarantee that:
 *
 *  1. Its shape. It is created with status 'draft' and no scheduled_at, and with
 *     none of the plan columns (daily_cap / send_days / send_time) set. The
 *     dispatcher's two selection queries are:
 *       - one-shot:  status='scheduled' AND scheduled_at IS NOT NULL AND ... no plan
 *       - planned:   status IN ('scheduled','sending') AND (a plan column is set)
 *     Neither can match 'draft' with no window and no plan. This is the primary
 *     mechanism: the row simply is not a campaign the dispatcher looks for.
 *  2. A name guard. dispatchDueCampaigns and enqueueCampaign additionally skip /
 *     refuse the reserved name, so even a status or schedule change by hand
 *     cannot turn the container into a blast of the whole active audience (it has
 *     no list/segment, so an accidental send would target everyone).
 *
 * The row is looked up and created by the same name, so the guard and the row can
 * never drift apart.
 */
import type { Env } from "./types";

/** Reserved container name. Created on demand; do not rename. */
export const GHL_TAG_TRIGGER_CAMPAIGN = "GHL tag triggers";

/** True when the row is the reserved tag-trigger container (exact name). */
export function isGhlTagTriggerCampaign(
  camp: { name?: string | null } | null | undefined,
): boolean {
  return (camp?.name ?? "") === GHL_TAG_TRIGGER_CAMPAIGN;
}

/**
 * Resolve (find by name, else create) the container campaign id.
 *
 * Idempotent: the insert-if-absent is a single statement, so SQLite evaluates the
 * existence check and the insert together and two overlapping webhook calls
 * cannot both create a row. Repeated calls reuse the one row.
 */
export async function ensureGhlTagTriggerCampaign(env: Env): Promise<number> {
  await env.DB.prepare(
    `INSERT INTO campaigns (name, status, from_name, from_email)
     SELECT ?, 'draft', ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM campaigns WHERE name = ?)`,
  )
    .bind(
      GHL_TAG_TRIGGER_CAMPAIGN,
      env.DEFAULT_FROM_NAME ?? null,
      env.DEFAULT_FROM_EMAIL ?? null,
      GHL_TAG_TRIGGER_CAMPAIGN,
    )
    .run();

  const row = await env.DB.prepare(
    "SELECT id FROM campaigns WHERE name = ? ORDER BY id LIMIT 1",
  )
    .bind(GHL_TAG_TRIGGER_CAMPAIGN)
    .first<{ id: number }>();
  if (!row) throw new Error("could not resolve the GHL tag trigger campaign");
  return Number(row.id);
}
