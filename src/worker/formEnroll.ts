/**
 * Enrol a form's EXISTING submissions into a sequence.
 *
 * This is the bulk counterpart to the form-submission webhook (formSubmission.ts):
 * where that handles one live submission, this walks the submissions already
 * recorded for a form slug and enrols whichever are *not yet enrolled*.
 *
 * The owner's rules, applied per distinct address:
 *   * only submissions with consent accepted;
 *   * skip suppressed addresses;
 *   * respect sendability — 'valid'/'unknown' send, 'pending'/'invalid' do not;
 *   * never enrol the same contact twice for the same sequence (the "not yet
 *     enrolled" filter — a repeat run enrols nobody);
 *   * mode `restart` on a re-enrol (though the filter already prevents one);
 *   * a DRAFT sequence captures and holds (the clock starts at activation).
 *
 * The preview and the enrol share one analysis so the numbers an operator
 * confirms are exactly the ones acted on.
 */

import type { Env } from "./types";
import { SENDABLE_EMAIL_STATUSES } from "../shared/emailStatus";
import { enrollContacts, type AudienceRow, type SequenceRow } from "./sequences";
import { loadFormSequenceMap } from "./formSubmission";

export interface FormSlugInfo {
  slug: string;
  submission_count: number;
  mapped_sequence_id: number | null;
}

/**
 * The form slugs an operator can enrol from: every slug with recorded
 * submissions, plus every slug configured in `form_sequence_map`. Never throws
 * on an unmigrated DB — the recorded half simply comes back empty.
 */
export async function listFormSlugs(env: Env): Promise<FormSlugInfo[]> {
  const out = new Map<string, FormSlugInfo>();
  try {
    const rows = await env.DB.prepare(
      "SELECT form_slug, COUNT(*) AS n FROM form_submissions WHERE form_slug IS NOT NULL AND form_slug<>'' GROUP BY form_slug ORDER BY form_slug",
    ).all<{ form_slug: string; n: number }>();
    for (const r of rows.results ?? []) {
      out.set(r.form_slug, { slug: r.form_slug, submission_count: Number(r.n ?? 0), mapped_sequence_id: null });
    }
  } catch {
    /* form_submissions not present yet */
  }
  const map = await loadFormSequenceMap(env);
  for (const [slug, seqId] of Object.entries(map)) {
    const cur = out.get(slug) ?? { slug, submission_count: 0, mapped_sequence_id: null };
    cur.mapped_sequence_id = seqId;
    out.set(slug, cur);
  }
  return [...out.values()];
}

/** True when a stored consent blob says the submitter accepted. */
export function consentAccepted(raw: unknown): boolean {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return false;
    }
  }
  if (v === true || v === "true") return true;
  if (v && typeof v === "object") {
    const a = (v as Record<string, unknown>).accepted;
    return a === true || a === "true";
  }
  return false;
}

interface SubmissionRow {
  submission_id: string;
  email: string | null;
  contact_id: number | null;
  consent: string | null;
}

export interface FormEnrollAnalysis {
  submissions_total: number;
  distinct_contacts: number;
  /** Contacts that would be enrolled (not yet enrolled, consenting, sendable). */
  candidates: { contact_id: number; email: string }[];
  /** Skip tallies keyed by reason (e.g. no_consent, already_enrolled, not_sendable:invalid). */
  skipped: Record<string, number>;
  held: boolean;
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/**
 * Analyse a form slug for a sequence. Read-only: nothing is written.
 */
export async function analyzeFormEnrollments(
  env: Env,
  seq: SequenceRow,
  formSlug: string,
): Promise<FormEnrollAnalysis> {
  const skipped: Record<string, number> = {};
  let submissions: SubmissionRow[] = [];
  try {
    const r = await env.DB.prepare(
      "SELECT submission_id, email, contact_id, consent FROM form_submissions WHERE form_slug=?",
    )
      .bind(formSlug)
      .all<SubmissionRow>();
    submissions = r.results ?? [];
  } catch {
    submissions = [];
  }

  // One decision per address: a contact with several submissions is considered
  // once, and counts as consenting when any of their submissions accepted.
  const byEmail = new Map<string, SubmissionRow[]>();
  for (const s of submissions) {
    const email = String(s.email ?? "").trim().toLowerCase();
    if (!email) continue;
    const arr = byEmail.get(email) ?? [];
    arr.push(s);
    byEmail.set(email, arr);
  }

  const candidates: { contact_id: number; email: string }[] = [];
  for (const [email, subs] of byEmail) {
    if (!subs.some((s) => consentAccepted(s.consent))) {
      bump(skipped, "no_consent");
      continue;
    }

    let contactId = subs.map((s) => s.contact_id).find((v) => v != null) ?? null;
    if (contactId == null) {
      const c = await env.DB.prepare("SELECT id FROM contacts WHERE email=?")
        .bind(email)
        .first<{ id: number }>();
      contactId = c?.id ?? null;
    }
    if (contactId == null) {
      bump(skipped, "no_contact");
      continue;
    }

    const sup = await env.DB.prepare("SELECT 1 AS x FROM suppressions WHERE email=?")
      .bind(email)
      .first();
    if (sup) {
      bump(skipped, "suppressed");
      continue;
    }

    // The owner's chosen filter: only the NOT yet enrolled.
    const existing = await env.DB.prepare(
      "SELECT id FROM sequence_enrollments WHERE sequence_id=? AND contact_id=?",
    )
      .bind(seq.id, contactId)
      .first<{ id: number }>();
    if (existing) {
      bump(skipped, "already_enrolled");
      continue;
    }

    const contact = await env.DB.prepare("SELECT email_status FROM contacts WHERE id=?")
      .bind(contactId)
      .first<{ email_status: string | null }>();
    const status = contact?.email_status ?? null;
    if (status == null || !(SENDABLE_EMAIL_STATUSES as readonly string[]).includes(status)) {
      bump(skipped, `not_sendable:${status ?? "unchecked"}`);
      continue;
    }

    candidates.push({ contact_id: contactId, email });
  }

  return {
    submissions_total: submissions.length,
    distinct_contacts: byEmail.size,
    candidates,
    skipped,
    held: seq.status === "draft",
  };
}

export interface FormEnrollPreview extends Omit<FormEnrollAnalysis, "candidates"> {
  form_slug: string;
  sequence_id: number;
  sequence_status: string;
  would_enroll: number;
  skipped_total: number;
}

export async function previewFormEnrollment(
  env: Env,
  seq: SequenceRow,
  formSlug: string,
): Promise<FormEnrollPreview> {
  const a = await analyzeFormEnrollments(env, seq, formSlug);
  return {
    form_slug: formSlug,
    sequence_id: seq.id,
    sequence_status: seq.status,
    submissions_total: a.submissions_total,
    distinct_contacts: a.distinct_contacts,
    would_enroll: a.candidates.length,
    skipped_total: Object.values(a.skipped).reduce((sum, n) => sum + n, 0),
    skipped: a.skipped,
    held: a.held,
  };
}

export interface FormEnrollResult {
  enrolled: number;
  reenrolled: number;
  skipped: number;
  candidates: number;
  skipped_reasons: Record<string, number>;
  held: boolean;
  contacts: number;
}

export async function enrollFormSubmissions(
  env: Env,
  seq: SequenceRow,
  formSlug: string,
  nowSeconds?: number,
): Promise<FormEnrollResult> {
  const a = await analyzeFormEnrollments(env, seq, formSlug);
  if (!a.candidates.length) {
    return {
      enrolled: 0,
      reenrolled: 0,
      skipped: 0,
      candidates: 0,
      skipped_reasons: a.skipped,
      held: a.held,
      contacts: a.distinct_contacts,
    };
  }
  const contacts: AudienceRow[] = a.candidates.map((c) => ({ id: c.contact_id, email: c.email }));
  // `restart` matches the webhook's own choice; the not-yet-enrolled filter
  // means only genuinely new enrolments reach here, so it is idempotent.
  const result = await enrollContacts(env, seq, contacts, "restart", nowSeconds);

  // Stamp the audit rows so a later run can see which submissions this enrol
  // consumed (the sequence_enrollments row is the real idempotency key).
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  for (const c of a.candidates) {
    try {
      await env.DB.prepare(
        "UPDATE form_submissions SET enrollment_id=(SELECT id FROM sequence_enrollments WHERE sequence_id=? AND contact_id=?), updated_at=? WHERE form_slug=? AND email=? AND enrollment_id IS NULL",
      )
        .bind(seq.id, c.contact_id, now, formSlug, c.email)
        .run();
    } catch {
      /* audit only */
    }
  }

  return {
    ...result,
    candidates: contacts.length,
    skipped_reasons: a.skipped,
    held: a.held,
    contacts: a.distinct_contacts,
  };
}
