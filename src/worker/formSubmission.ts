// Form-submission webhook: POST /api/webhooks/form-submission.
//
// The forms team posts one fixed payload per website form submission (see the
// route in webhooks.ts, which owns token auth and JSON parsing). This module is
// the behaviour: idempotency, immediate verification, contact upsert, consent,
// sequence mapping, restart-enrolment and the capture-and-hold rule.
//
//   POST /api/webhooks/form-submission?token=***
//   { "form_slug", "submission_id", "email", "first_name", "last_name", "phone",
//     "consent": { "accepted": true, "text": "...", "at": "..." }, "fields": {...} }
//
// Design notes:
//   * `form_submissions.submission_id` is the idempotency key. The handler
//     CLAIMS it with one INSERT OR IGNORE before doing anything; a repeat call
//     sees the existing row and returns its recorded outcome with no side
//     effects (no second verify, no second enrolment).
//   * The address is verified inline via Bulk Email Checker (one credit) so a
//     fresh lead does not queue behind the 20/min cron pass. If the API errors,
//     the address is stored 'pending' and queued for the cron pass instead of
//     the lead being dropped - and enrolment still proceeds, because the
//     dispatcher skips (never stops) a pending address and will send once the
//     cron verifies it.
//   * The form_slug -> sequence mapping is a settings entry (`form_sequence_map`,
//     JSON { slug: sequenceId }) so the forms side stays dumb and the mapping is
//     editable in Settings without a deploy.

import type { Env } from "./types";
import { verifyEmail } from "./emailVerify";
import { isSendBlocked, type EmailStatus } from "../shared/emailStatus";
import { deriveTimezoneFromFields } from "../shared/timezone";
import { enrollContacts, type SequenceRow } from "./sequences";

/** Settings key holding the slug -> sequence-id map. */
export const FORM_SEQUENCE_MAP_SETTING = "form_sequence_map";

export interface FormConsent {
  accepted?: boolean;
  text?: string | null;
  at?: string | null;
}

export interface FormSubmissionInput {
  form_slug: string;
  submission_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  consent: FormConsent | null;
  fields: Record<string, unknown> | null;
}

export interface FormValidation {
  ok: boolean;
  errors: string[];
  values?: FormSubmissionInput;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Validate the fixed contract. Only the three keys we cannot work without. */
export function validateFormSubmission(body: unknown): FormValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: ["body"] };
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];
  const form_slug = str(b.form_slug);
  const submission_id = str(b.submission_id);
  const email = str(b.email).toLowerCase();
  if (!form_slug) errors.push("form_slug");
  if (!submission_id) errors.push("submission_id");
  if (!email) errors.push("email");
  else if (!EMAIL_SHAPE.test(email)) errors.push("email_invalid");

  const consent =
    b.consent && typeof b.consent === "object" && !Array.isArray(b.consent)
      ? (b.consent as FormConsent)
      : null;
  const fields =
    b.fields && typeof b.fields === "object" && !Array.isArray(b.fields)
      ? (b.fields as Record<string, unknown>)
      : null;

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    values: {
      form_slug,
      submission_id,
      email,
      first_name: str(b.first_name) || null,
      last_name: str(b.last_name) || null,
      phone: str(b.phone) || null,
      consent,
      fields,
    },
  };
}

/**
 * Read the slug -> sequence-id map from settings. Accepts the stored JSON as an
 * object OR an array of { form_slug, sequence_id } rows; anything unusable is
 * ignored rather than throwing, so a bad edit degrades to "unmapped".
 */
export async function loadFormSequenceMap(env: Env): Promise<Record<string, number>> {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?")
      .bind(FORM_SEQUENCE_MAP_SETTING)
      .first<{ value: string }>();
    if (!row) return {};
    return normalizeFormSequenceMap(row.value);
  } catch {
    return {};
  }
}

export function normalizeFormSequenceMap(value: unknown): Record<string, number> {
  let v: unknown = value;
  if (typeof value === "string") {
    try {
      v = JSON.parse(value);
    } catch {
      return {};
    }
  }
  const out: Record<string, number> = {};
  const add = (slug: unknown, seq: unknown) => {
    const s = str(slug);
    const n = Number(seq);
    if (s && Number.isSafeInteger(n) && n > 0) out[s] = n;
  };
  if (Array.isArray(v)) {
    for (const r of v) {
      if (r && typeof r === "object") {
        const rr = r as Record<string, unknown>;
        add(rr.form_slug ?? rr.slug, rr.sequence_id ?? rr.sequenceId);
      }
    }
  } else if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) add(k, val);
  }
  return out;
}

export interface FormSubmissionResult {
  ok: true;
  duplicate: boolean;
  submission_id: string;
  email: string;
  status: string;
  reason: string | null;
  email_status: string | null;
  contact_id: number | null;
  sequence_id: number | null;
  enrollment_id: number | null;
  enrolled: boolean;
  held: boolean;
  verify_credits_spent: number;
}

interface SubmissionRow {
  submission_id: string;
  form_slug: string | null;
  email: string | null;
  contact_id: number | null;
  sequence_id: number | null;
  enrollment_id: number | null;
  status: string;
  reason: string | null;
  verify_status: string | null;
}

/**
 * Process one submission. Idempotent on `submission_id`; safe to call twice.
 * `nowSeconds` is injectable so tests are clock-independent.
 */
export async function handleFormSubmission(
  env: Env,
  input: FormSubmissionInput,
  nowSeconds?: number,
): Promise<FormSubmissionResult> {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const email = input.email.toLowerCase();

  // 1. Claim the submission_id. Exactly one caller wins this write; everyone
  // else gets changes=0 and reads the stored outcome back.
  const claim = await env.DB.prepare(
    `INSERT OR IGNORE INTO form_submissions
       (submission_id, form_slug, email, status, consent, payload, created_at, updated_at)
     VALUES (?,?,?, 'processing', ?, ?, ?, ?)`,
  )
    .bind(
      input.submission_id,
      input.form_slug,
      email,
      input.consent ? JSON.stringify(input.consent) : null,
      JSON.stringify(input),
      now,
      now,
    )
    .run();
  if (Number(claim.meta?.changes ?? 0) === 0) {
    return duplicateResult(env, input.submission_id, email);
  }

  const finish = async (
    status: string,
    reason: string | null,
    ids: { contact_id?: number | null; sequence_id?: number | null; enrollment_id?: number | null },
    verifyStatus: string | null,
  ): Promise<FormSubmissionResult> => {
    await env.DB.prepare(
      `UPDATE form_submissions
          SET status=?, reason=?, contact_id=?, sequence_id=?, enrollment_id=?,
              verify_status=?, updated_at=?
        WHERE submission_id=?`,
    )
      .bind(
        status,
        reason,
        ids.contact_id ?? null,
        ids.sequence_id ?? null,
        ids.enrollment_id ?? null,
        verifyStatus,
        now,
        input.submission_id,
      )
      .run();
    return {
      ok: true,
      duplicate: false,
      submission_id: input.submission_id,
      email,
      status,
      reason,
      email_status: verifyStatus,
      contact_id: ids.contact_id ?? null,
      sequence_id: ids.sequence_id ?? null,
      enrollment_id: ids.enrollment_id ?? null,
      enrolled: status === "enrolled" || status === "held",
      held: status === "held",
      verify_credits_spent: 0,
    };
  };

  try {
    // 2. Never touch a suppressed address - not verified, not enrolled.
    const suppressed = await env.DB.prepare("SELECT reason FROM suppressions WHERE email=?")
      .bind(email)
      .first<{ reason: string }>();
    if (suppressed) {
      return finish("suppressed", `suppressed:${suppressed.reason}`, {}, null);
    }

    // 3. Upsert the contact (first/last in columns, phone + consent in the
    //    attributes JSON - contacts has no phone column), deriving the timezone
    //    from the state/postcode when the form supplied one.
    const timezone = deriveTimezoneFromFields({ ...(input.fields ?? {}) });
    const attrs: Record<string, unknown> = {};
    if (input.phone) attrs.phone = input.phone;
    if (input.form_slug) attrs.form_slug = input.form_slug;
    if (input.consent) {
      attrs.consent = {
        accepted: input.consent.accepted ?? null,
        text: input.consent.text ?? null,
        at: input.consent.at ?? null,
      };
    }
    const contact = await env.DB.prepare(
      `INSERT INTO contacts (email, first_name, last_name, attributes, source, email_status, timezone)
       VALUES (?,?,?,?, 'form', 'pending', ?)
       ON CONFLICT(email) DO UPDATE SET
         first_name = COALESCE(excluded.first_name, contacts.first_name),
         last_name  = COALESCE(excluded.last_name, contacts.last_name),
         attributes = json_patch(COALESCE(NULLIF(contacts.attributes,''),'{}'), excluded.attributes),
         source     = COALESCE(contacts.source, 'form'),
         timezone   = COALESCE(contacts.timezone, excluded.timezone),
         updated_at = unixepoch()
       RETURNING id`,
    )
      .bind(email, input.first_name, input.last_name, JSON.stringify(attrs), timezone)
      .first<{ id: number }>();
    const contactId = contact?.id ?? null;

    // 4. Verify THIS address now (one credit) so it does not queue behind the
    //    20/min cron pass. An API error stores 'pending' + queues the row for
    //    the cron pass instead of dropping the lead.
    let verifyStatus: EmailStatus | "pending" = "pending";
    let creditsSpent = 0;
    let verifyFallback: string | null = null;
    const vr = await verifyEmail(env, email);
    if (vr.kind === "checked") {
      verifyStatus = vr.status;
      creditsSpent = 1; // one real-time check == one credit
      if (contactId != null) {
        await env.DB.prepare(
          `UPDATE contacts
             SET email_status=?, email_verified_at=?, email_check_event=?, email_check_flags=?,
                 email_verify_queued=0, updated_at=unixepoch()
           WHERE id=?`,
        )
          .bind(
            vr.status,
            now,
            vr.signals.event,
            JSON.stringify({
              becStatus: vr.signals.status,
              isDisposable: vr.signals.isDisposable,
              isGibberish: vr.signals.isGibberish,
              isRoleAccount: vr.signals.isRoleAccount,
              isComplainer: vr.signals.isComplainer,
              isFreeService: vr.signals.isFreeService,
              emailSuggested: vr.signals.emailSuggested,
            }),
            contactId,
          )
          .run();
      }
    } else {
      verifyFallback = `verify_api_${vr.reason}`;
      if (contactId != null) {
        await env.DB.prepare(
          `UPDATE contacts SET email_status='pending', email_verify_queued=1, updated_at=unixepoch()
            WHERE id=?`,
        )
          .bind(contactId)
          .run();
      }
    }

    // 5. Consent audit: raw event row (email + full payload) plus, when the
    //    contact is enrolled, a sequence_events entry carrying wording + time.
    await env.DB.prepare(
      "INSERT INTO webhook_events (event_type, email, payload) VALUES ('form_submission', ?, ?)",
    )
      .bind(email, JSON.stringify({ ...input, received_at: now }))
      .run();

    // 6. Map form_slug -> sequence. Unmapped: recorded, not enrolled, reason.
    const map = await loadFormSequenceMap(env);
    const sequenceId = map[input.form_slug] ?? null;
    if (!sequenceId) {
      return finish(
        "unmapped",
        `no sequence mapped for form_slug:${input.form_slug}`,
        { contact_id: contactId },
        String(verifyStatus),
      );
    }
    const seq = await env.DB.prepare("SELECT * FROM sequences WHERE id=?")
      .bind(sequenceId)
      .first<SequenceRow>();
    if (!seq) {
      return finish(
        "unmapped",
        `mapped sequence ${sequenceId} not found for form_slug:${input.form_slug}`,
        { contact_id: contactId, sequence_id: sequenceId },
        String(verifyStatus),
      );
    }

    // 7. A definitive verification failure (invalid/disposable/gibberish, or a
    //    risky address we will not send to) is captured but NOT enrolled.
    if (vr.kind === "checked" && isSendBlocked(vr.status)) {
      return finish(
        "not_enrolled",
        `not_enrolled:verification:${vr.status}`,
        { contact_id: contactId, sequence_id: seq.id },
        String(verifyStatus),
      );
    }

    // 8. Enrol with restart (the owner's choice): a repeat submitter restarts.
    //    Into a draft sequence this captures-and-holds (clock NULL) - see
    //    enrollContacts / releaseHeldEnrollments.
    if (contactId == null) {
      return finish("error", "contact_upsert_failed", { sequence_id: seq.id }, String(verifyStatus));
    }
    await enrollContacts(env, seq, [{ id: contactId, email }], "restart", now);
    const enrollment = await env.DB.prepare(
      "SELECT id FROM sequence_enrollments WHERE sequence_id=? AND contact_id=?",
    )
      .bind(seq.id, contactId)
      .first<{ id: number }>();
    const enrollmentId = enrollment?.id ?? null;

    // Consent event in the sequence history (wording + timestamp), when enrolled.
    if (enrollmentId != null) {
      await env.DB.prepare(
        `INSERT INTO sequence_events (sequence_id, enrollment_id, contact_id, type, detail)
         VALUES (?,?,?, 'consent', ?)`,
      )
        .bind(
          seq.id,
          enrollmentId,
          contactId,
          JSON.stringify({
            accepted: input.consent?.accepted ?? null,
            at: input.consent?.at ?? null,
            text: input.consent?.text ?? null,
          }),
        )
        .run();
    }

    const held = seq.status === "draft";
    const reasons: string[] = [];
    if (held) reasons.push("captured_and_held:awaiting_activation");
    if (verifyFallback) reasons.push(verifyFallback);
    const status = held ? "held" : "enrolled";
    const result = await finish(
      status,
      reasons.length ? reasons.join(";") : null,
      { contact_id: contactId, sequence_id: seq.id, enrollment_id: enrollmentId },
      String(verifyStatus),
    );
    result.verify_credits_spent = creditsSpent;
    return result;
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    console.error("form-submission processing failed", message);
    return finish("error", message, {}, null);
  }
}

async function duplicateResult(
  env: Env,
  submissionId: string,
  email: string,
): Promise<FormSubmissionResult> {
  const row = await env.DB.prepare("SELECT * FROM form_submissions WHERE submission_id=?")
    .bind(submissionId)
    .first<SubmissionRow>();
  const status = row?.status ?? "unknown";
  return {
    ok: true,
    duplicate: true,
    submission_id: submissionId,
    email: row?.email ?? email,
    status,
    reason: row?.reason ?? null,
    email_status: row?.verify_status ?? null,
    contact_id: row?.contact_id ?? null,
    sequence_id: row?.sequence_id ?? null,
    enrollment_id: row?.enrollment_id ?? null,
    enrolled: status === "enrolled" || status === "held",
    held: status === "held",
    verify_credits_spent: 0,
  };
}
