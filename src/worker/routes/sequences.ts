// Sequence API. Mounted at /api/sequences (see worker/index.ts).
//
// Everything the sequence editor and detail page need: create/edit a sequence
// and its steps, enrol / re-enrol (both modes) / remove, the append
// preview -> confirm flow, per-step metrics, the per-recipient view, and the
// test-mode run.

import { Hono } from "hono";
import { z } from "zod";
import type { Env, SendJob } from "../types";
import {
  STEP_POSITION_GAP,
  confirmRelease,
  enrollContacts,
  loadSteps,
  releaseHeldEnrollments,
  releasePreview,
  reenroll,
  removeEnrollment,
  runSequenceTest,
  sequenceAudience,
  sequenceAudienceCount,
  sequenceEnrollments,
  sequenceMetrics,
  sequenceProgress,
  type AudienceRow,
  type SequenceRow,
} from "../sequences";
import { resolveTimeZone } from "../../shared/sendPlan";
import { getDefaultSenderIdentity } from "../senderIdentities";
import { enrollFormSubmissions, listFormSlugs, previewFormEnrollment } from "../formEnroll";

export const sequencesRoutes = new Hono<{ Bindings: Env }>();

async function loadSequence(env: Env, id: number): Promise<SequenceRow | null> {
  if (!Number.isSafeInteger(id)) return null;
  return env.DB.prepare("SELECT * FROM sequences WHERE id=?").bind(id).first<SequenceRow>();
}

const planSchema = z.object({
  list_id: z.number().int().nullable().optional(),
  segment_id: z.number().int().nullable().optional(),
  audience_filter: z.string().nullable().optional(),
  from_name: z.string().max(200).nullable().optional(),
  from_email: z.string().max(320).nullable().optional(),
  reply_to: z.string().max(320).nullable().optional(),
  /** Chosen sender identity (0023). NULL = default identity, else legacy from_*. */
  sender_identity_id: z.number().int().nullable().optional(),
  daily_cap: z.number().int().min(0).max(1000000).nullable().optional(),
  send_days: z.string().nullable().optional(),
  send_time: z.string().nullable().optional(),
  send_timezone: z.string().nullable().optional(),
  ramp_start: z.number().int().min(0).nullable().optional(),
  ramp_days: z.number().int().min(0).nullable().optional(),
  spread_minutes: z.number().int().min(0).nullable().optional(),
});

const createSchema = planSchema.extend({ name: z.string().min(1).max(200) });
const updateSchema = planSchema.extend({ name: z.string().min(1).max(200).optional() });

const stepSchema = z.object({
  name: z.string().max(200).nullable().optional(),
  template_id: z.number().int().nullable().optional(),
  external_template_id: z.string().max(200).nullable().optional(),
  subject: z.string().max(998).nullable().optional(),
  body_html: z.string().nullable().optional(),
  /** The step's OWN email copy (0024); seeded from a template but never live-linked. */
  content_html: z.string().nullable().optional(),
  content_text: z.string().nullable().optional(),
  seeded_from_template_id: z.number().int().nullable().optional(),
  wait_minutes: z.number().int().min(0).max(1000000).optional(),
  /** Insert after this position; omit / null to append at the end. */
  after_position: z.number().int().min(0).nullable().optional(),
});

/** The columns a PATCH may set, whitelisted so nothing else lands in the row. */
const PLAN_COLS = [
  "list_id",
  "segment_id",
  "audience_filter",
  "from_name",
  "from_email",
  "reply_to",
  "sender_identity_id",
  "daily_cap",
  "send_days",
  "send_time",
  "send_timezone",
  "ramp_start",
  "ramp_days",
  "spread_minutes",
] as const;

function normalizePlanValue(col: string, v: unknown): unknown {
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return null;
    return trimmed;
  }
  return v ?? null;
}

// ---------------------------------------------------------------------------
// List & create
// ---------------------------------------------------------------------------

sequencesRoutes.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.*,
            (SELECT COUNT(*) FROM sequence_steps st WHERE st.sequence_id = s.id) AS step_count,
            (SELECT COUNT(*) FROM sequence_enrollments e WHERE e.sequence_id = s.id AND e.status='active') AS active_count,
            (SELECT COUNT(*) FROM sequence_enrollments e WHERE e.sequence_id = s.id) AS enrolled_count
       FROM sequences s ORDER BY s.id DESC`,
  ).all<any>();
  return c.json({
    rows: (rows.results ?? []).map((r) => ({
      ...r,
      timezone: resolveTimeZone(r.send_timezone, c.env.SEND_TIMEZONE),
      step_count: Number(r.step_count ?? 0),
      active_count: Number(r.active_count ?? 0),
      enrolled_count: Number(r.enrolled_count ?? 0),
    })),
  });
});

sequencesRoutes.post("/", async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const d = parsed.data;
  const r = await c.env.DB.prepare(
    `INSERT INTO sequences
       (name, list_id, segment_id, audience_filter, from_name, from_email, reply_to,
        daily_cap, send_days, send_time, send_timezone, ramp_start, ramp_days, spread_minutes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
  )
    .bind(
      d.name,
      d.list_id ?? null,
      d.segment_id ?? null,
      d.audience_filter ?? null,
      d.from_name ?? null,
      d.from_email ?? null,
      d.reply_to ?? null,
      d.daily_cap ?? null,
      d.send_days ?? null,
      d.send_time ?? null,
      d.send_timezone ?? null,
      d.ramp_start ?? null,
      d.ramp_days ?? null,
      d.spread_minutes ?? null,
    )
    .first<{ id: number }>();
  return c.json({ ok: true, id: r?.id });
});

// ---------------------------------------------------------------------------
// Read / update one
// -------------------------------------------------------------------------

// The form slugs an operator can enrol from: recorded form_submissions plus the
// slugs configured in form_sequence_map. Registered before /:id so the literal
// "form-slugs" is never read as a sequence id.
sequencesRoutes.get("/form-slugs", async (c) => {
  return c.json({ slugs: await listFormSlugs(c.env) });
});

sequencesRoutes.get("/:id", async (c) => {
  const seq = await loadSequence(c.env, Number(c.req.param("id")));
  if (!seq) return c.json({ error: "not found" }, 404);
  const [steps, progress, preview, audience_count] = await Promise.all([
    loadSteps(c.env, seq.id),
    sequenceProgress(c.env, seq),
    releasePreview(c.env, seq),
    sequenceAudienceCount(c.env, seq).catch(() => 0),
  ]);
  return c.json({ sequence: seq, steps, progress, release_preview: preview, audience_count });
});

sequencesRoutes.patch("/:id", async (c) => {
  const seq = await loadSequence(c.env, Number(c.req.param("id")));
  if (!seq) return c.json({ error: "not found" }, 404);
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const d = parsed.data as Record<string, unknown>;
  const sets: string[] = [];
  const binds: any[] = [];
  if (typeof d.name === "string") {
    sets.push("name=?");
    binds.push(d.name);
  }
  for (const col of PLAN_COLS) {
    if (col in d) {
      sets.push(`${col}=?`);
      binds.push(normalizePlanValue(col, d[col]));
    }
  }
  if (sets.length) {
    binds.push(seq.id);
    await c.env.DB.prepare(`UPDATE sequences SET ${sets.join(", ")} WHERE id=?`)
      .bind(...binds)
      .run();
  }
  return c.json({ ok: true });
});

sequencesRoutes.post("/:id/status", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const status = String(body?.status ?? "");
  if (!["draft", "active", "paused", "archived"].includes(status)) {
    return c.json({ error: "invalid status" }, 400);
  }
  const seq = await loadSequence(c.env, id);
  if (!seq) return c.json({ error: "not found" }, 404);
  if (status === "active") {
    const steps = await loadSteps(c.env, id);
    if (!steps.length) return c.json({ error: "add at least one step before activating" }, 400);
    // A from-address may come from the sequence, an explicitly chosen identity,
    // or the default identity. Only refuse when none of those resolves.
    const hasSender = Boolean(seq.from_email) || Boolean(seq.sender_identity_id) || Boolean(await getDefaultSenderIdentity(c.env));
    if (!hasSender) return c.json({ error: "set a sender identity (or from_email) before activating" }, 400);
  }
  await c.env.DB.prepare(
    "UPDATE sequences SET status=?, started_at=CASE WHEN ? = 'active' THEN COALESCE(started_at, unixepoch()) ELSE started_at END WHERE id=?",
  )
    .bind(status, status, id)
    .run();
  // Activation releases every captured-and-held enrolment: their wait starts
  // now (activation + step 1's wait) instead of at the draft-time enrolment.
  let released_held = 0;
  if (status === "active") {
    released_held = await releaseHeldEnrollments(c.env, seq, Math.floor(Date.now() / 1000));
  }
  return c.json({ ok: true, status, released_held });
});

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Make room for a step at `atPosition` by shifting that position and every
 * later one up by 1 - in the steps, in the send records and in the enrolments'
 * `last_sent_position`. Shifting all three together is what preserves meaning:
 * a contact who already received a step keeps "already passed" that step after
 * the renumber. A large temporary offset makes the shift collision-free.
 */
async function renumberForInsert(env: Env, sequenceId: number, atPosition: number): Promise<void> {
  const OFF = 100000000;
  await env.DB.batch([
    env.DB.prepare("UPDATE sequence_steps SET position = position + ? WHERE sequence_id=? AND position >= ?").bind(OFF, sequenceId, atPosition),
    env.DB.prepare("UPDATE sequence_sends SET step_position = step_position + ? WHERE sequence_id=? AND step_position >= ?").bind(OFF, sequenceId, atPosition),
    env.DB.prepare("UPDATE sequence_enrollments SET last_sent_position = last_sent_position + ? WHERE sequence_id=? AND last_sent_position >= ?").bind(OFF, sequenceId, atPosition),
    env.DB.prepare("UPDATE sequence_steps SET position = position - ? WHERE sequence_id=? AND position >= ?").bind(OFF - 1, sequenceId, atPosition + OFF),
    env.DB.prepare("UPDATE sequence_sends SET step_position = step_position - ? WHERE sequence_id=? AND step_position >= ?").bind(OFF - 1, sequenceId, atPosition + OFF),
    env.DB.prepare("UPDATE sequence_enrollments SET last_sent_position = last_sent_position - ? WHERE sequence_id=? AND last_sent_position >= ?").bind(OFF - 1, sequenceId, atPosition + OFF),
  ]);
}

sequencesRoutes.post("/:id/steps", async (c) => {
  const seq = await loadSequence(c.env, Number(c.req.param("id")));
  if (!seq) return c.json({ error: "not found" }, 404);
  const parsed = stepSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const d = parsed.data;

  const steps = await loadSteps(c.env, seq.id);
  const after = d.after_position ?? null;

  let position: number;
  let insertedMid = false;
  if (after == null || !steps.length) {
    position = (steps.length ? steps[steps.length - 1].position : 0) + STEP_POSITION_GAP;
  } else if (after >= steps[steps.length - 1].position) {
    position = steps[steps.length - 1].position + STEP_POSITION_GAP;
  } else {
    const prev = steps.filter((s) => s.position <= after).pop();
    const next = steps.find((s) => s.position > after)!;
    const lo = prev ? prev.position : 0;
    const gap = next.position - lo;
    if (gap >= 2) {
      position = lo + Math.floor(gap / 2);
    } else {
      await renumberForInsert(c.env, seq.id, next.position);
      position = next.position; // the shifted-up slot
      insertedMid = true;
    }
  }

  const r = await c.env.DB.prepare(
    `INSERT INTO sequence_steps
       (sequence_id, position, name, template_id, external_template_id, subject, body_html, wait_minutes)
     VALUES (?,?,?,?,?,?,?,?) RETURNING id`,
  )
    .bind(
      seq.id,
      position,
      d.name ?? null,
      d.template_id ?? null,
      d.external_template_id ?? null,
      d.subject ?? null,
      d.body_html ?? null,
      d.wait_minutes ?? 0,
    )
    .first<{ id: number }>();
  return c.json({ ok: true, id: r?.id, position, inserted_mid: insertedMid });
});

sequencesRoutes.patch("/:id/steps/:stepId", async (c) => {
  const seq = await loadSequence(c.env, Number(c.req.param("id")));
  if (!seq) return c.json({ error: "not found" }, 404);
  const stepId = Number(c.req.param("stepId"));
  const parsed = stepSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const d = parsed.data as Record<string, unknown>;
  const cols = [
    "name",
    "template_id",
    "external_template_id",
    "subject",
    "body_html",
    "content_html",
    "content_text",
    "seeded_from_template_id",
    "wait_minutes",
  ];
  const sets: string[] = [];
  const binds: any[] = [];
  for (const col of cols) {
    if (col in d) {
      sets.push(`${col}=?`);
      binds.push(normalizePlanValue(col, d[col]));
    }
  }
  if (sets.length) {
    binds.push(seq.id, stepId);
    await c.env.DB.prepare(`UPDATE sequence_steps SET ${sets.join(", ")} WHERE sequence_id=? AND id=?`)
      .bind(...binds)
      .run();
  }
  return c.json({ ok: true });
});

sequencesRoutes.delete("/:id/steps/:stepId", async (c) => {
  const seq = await loadSequence(c.env, Number(c.req.param("id")));
  if (!seq) return c.json({ error: "not found" }, 404);
  const stepId = Number(c.req.param("stepId"));
  await c.env.DB.prepare("DELETE FROM sequence_steps WHERE sequence_id=? AND id=?")
    .bind(seq.id, stepId)
    .run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Append -> release preview -> confirm
// ---------------------------------------------------------------------------

sequencesRoutes.get("/:id/release-preview", async (c) => {
  const seq = await loadSequence(c.env, Number(c.req.param("id")));
  if (!seq) return c.json({ error: "not found" }, 404);
  return c.json(await releasePreview(c.env, seq));
});

sequencesRoutes.post("/:id/release", async (c) => {
  const seq = await loadSequence(c.env, Number(c.req.param("id")));
  if (!seq) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const stepIds = Array.isArray(body?.step_ids)
    ? body.step_ids.map(Number).filter((n: number) => Number.isSafeInteger(n))
    : undefined;
  const r = await confirmRelease(c.env, seq, { stepIds });
  return c.json({ ok: true, ...r });
});

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

const enrollSchema = z.object({
  mode: z.enum(["restart", "resume"]).default("restart"),
  contact_ids: z.array(z.number().int()).optional(),
});

async function sendableContacts(env: Env, ids: number[]): Promise<AudienceRow[]> {
  if (!ids.length) return [];
  const ph = ids.map(() => "?").join(",");
  const r = await env.DB.prepare(
    `SELECT c.id, c.email FROM contacts c
      WHERE c.id IN (${ph}) AND c.status='active'
        AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = c.email)`,
  )
    .bind(...ids)
    .all<AudienceRow>();
  return r.results ?? [];
}

sequencesRoutes.post("/:id/enroll", async (c) => {
  const seq = await loadSequence(c.env, Number(c.req.param("id")));
  if (!seq) return c.json({ error: "not found" }, 404);
  const parsed = enrollSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { mode, contact_ids } = parsed.data;

  const contacts = contact_ids?.length
    ? await sendableContacts(c.env, contact_ids)
    : await sequenceAudience(c.env, seq);
  const result = await enrollContacts(c.env, seq, contacts, mode);
  return c.json({ ok: true, ...result, considered: contacts.length });
});

sequencesRoutes.post("/:id/enrollments/:eid/reenroll", async (c) => {
  const seq = await loadSequence(c.env, Number(c.req.param("id")));
  if (!seq) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const mode = body?.mode === "resume" ? "resume" : "restart";
  const ok = await reenroll(c.env, seq, Number(c.req.param("eid")), mode);
  if (!ok) return c.json({ error: "enrolment not found" }, 404);
  return c.json({ ok: true, mode });
});

sequencesRoutes.delete("/:id/enrollments/:eid", async (c) => {
  const seq = await loadSequence(c.env, Number(c.req.param("id")));
  if (!seq) return c.json({ error: "not found" }, 404);
  const ok = await removeEnrollment(c.env, seq.id, Number(c.req.param("eid")));
  if (!ok) return c.json({ error: "enrolment not found" }, 404);
  return c.json({ ok: true });
});

sequencesRoutes.get("/:id/enrollments", async (c) => {
  const seq = await loadSequence(c.env, Number(c.req.param("id")));
  if (!seq) return c.json({ error: "not found" }, 404);
  const limit = Number(c.req.query("limit"));
  const offset = Number(c.req.query("offset"));
  const data = await sequenceEnrollments(c.env, seq, {
    limit: Number.isSafeInteger(limit) ? limit : 50,
    offset: Number.isSafeInteger(offset) ? offset : 0,
    status: c.req.query("status") ?? "all",
  });
  return c.json(data);
});

// ---------------------------------------------------------------------------
// Metrics & test
// ---------------------------------------------------------------------------

sequencesRoutes.get("/:id/metrics", async (c) => {
  const seq = await loadSequence(c.env, Number(c.req.param("id")));
  if (!seq) return c.json({ error: "not found" }, 404);
  return c.json(await sequenceMetrics(c.env, seq));
});

sequencesRoutes.post("/:id/test", async (c) => {
  const seq = await loadSequence(c.env, Number(c.req.param("id")));
  if (!seq) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.json({ error: "a valid test email is required" }, 400);
  }
  const steps = await loadSteps(c.env, seq.id);
  if (!steps.length) return c.json({ error: "add at least one step before testing" }, 400);
  const compressMinutes = Number(body?.compress_minutes);
  const r = await runSequenceTest(c.env, seq, email, {
    compressMinutes: Number.isFinite(compressMinutes) ? compressMinutes : 1,
  });
  return c.json({ ok: true, test: true, ...r });
});

// Test a SINGLE step (the docked editor's test send). Queues one test job that
// renders and sends this step only; like the whole-sequence test it writes to
// sequence_test_sends and never touches an enrolment or a metric.
sequencesRoutes.post("/:id/steps/:stepId/test", async (c) => {
  const seq = await loadSequence(c.env, Number(c.req.param("id")));
  if (!seq) return c.json({ error: "not found" }, 404);
  const stepId = Number(c.req.param("stepId"));
  const steps = await loadSteps(c.env, seq.id);
  const step = steps.find((s) => s.id === stepId);
  if (!step) return c.json({ error: "step not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.json({ error: "a valid test email is required" }, 400);
  }
  await c.env.DB.prepare(
    "INSERT INTO sequence_test_sends (sequence_id, step_position, email) VALUES (?,?,?)",
  )
    .bind(seq.id, step.position, email)
    .run();
  const job: SendJob = {
    test: true,
    sequence_id: seq.id,
    step_position: step.position,
    contact_id: null,
    email,
  };
  await c.env.SEND_QUEUE.send(job);
  return c.json({ ok: true, test: true, step_position: step.position, queued: 1 });
});

// ---------------------------------------------------------------------------
// Enrol a form's existing submissions
// ---------------------------------------------------------------------------

/** Read-only preview: exactly how many would enrol and how many are skipped, and why. */
sequencesRoutes.get("/:id/form-enroll/preview", async (c) => {
  const seq = await loadSequence(c.env, Number(c.req.param("id")));
  if (!seq) return c.json({ error: "not found" }, 404);
  const formSlug = String(c.req.query("form_slug") ?? "").trim();
  if (!formSlug) return c.json({ error: "form_slug is required" }, 400);
  return c.json(await previewFormEnrollment(c.env, seq, formSlug));
});

/** Confirm: enrol the not-yet-enrolled consenting, sendable submissions. */
sequencesRoutes.post("/:id/form-enroll", async (c) => {
  const seq = await loadSequence(c.env, Number(c.req.param("id")));
  if (!seq) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const formSlug = String(body?.form_slug ?? "").trim();
  if (!formSlug) return c.json({ error: "form_slug is required" }, 400);
  const result = await enrollFormSubmissions(c.env, seq, formSlug);
  return c.json({ ok: true, ...result });
});
