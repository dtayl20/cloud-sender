// Bulk enrolment of a form's existing submissions (Part C).
//
// Only consent-accepted, non-suppressed, sendable addresses that are NOT yet
// enrolled; the preview states exactly how many enrol and how many skip (and
// why); a repeat is idempotent; a draft sequence captures and holds.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ALL_MIGRATIONS, applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { Env, SendJob } from "./types";
import { sequencesRoutes } from "./routes/sequences";
import { consentAccepted } from "./formEnroll";

function freshDb(): TestD1 {
  const d1 = createTestD1();
  applyMigrations(d1, ALL_MIGRATIONS);
  return d1;
}

function makeEnv(d1: TestD1) {
  const env = {
    DB: d1,
    SEND_QUEUE: { send: async (_b: SendJob) => {}, sendBatch: async () => {} },
    SEND_TIMEZONE: "Australia/Brisbane",
    DEFAULT_FROM_EMAIL: "from@localdentists.au",
    DEFAULT_FROM_NAME: "LocalDentists.au",
    WEBHOOK_TOKEN: "tok",
  } as unknown as Env;
  return { env };
}

function makeApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/sequences", sequencesRoutes);
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await app.fetch(
      new Request(`http://test${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
      env,
    );
    return { status: r.status, json: (await r.json()) as any };
  };
  return {
    post: (p: string, b?: unknown) => call("POST", p, b),
    get: (p: string) => call("GET", p),
  };
}

function addContact(d1: TestD1, email: string, emailStatus: string | null): number {
  d1.sql(
    "INSERT INTO contacts (email, status, email_status) VALUES (?, 'active', ?)",
    email,
    emailStatus,
  );
  return Number(d1.sql<{ id: number }>("SELECT id FROM contacts WHERE email=?", email)[0].id);
}

function addSubmission(d1: TestD1, id: string, email: string, contactId: number | null, accepted: boolean | null) {
  const consent = accepted === null ? null : JSON.stringify({ accepted, text: "I agree", at: "2026-10-08T00:00:00Z" });
  d1.sql(
    "INSERT INTO form_submissions (submission_id, form_slug, email, contact_id, status, consent) VALUES (?,?,?,?, 'enrolled', ?)",
    id,
    "contact-us",
    email,
    contactId,
    consent,
  );
}

function makeSequence(d1: TestD1, status: string): number {
  d1.sql("INSERT INTO sequences (name, status, from_email) VALUES (?,?,?)", "Seq", status, "from@localdentists.au");
  const id = Number(d1.sql<{ id: number }>("SELECT id FROM sequences ORDER BY id DESC LIMIT 1")[0].id);
  d1.sql("INSERT INTO sequence_steps (sequence_id, position, wait_minutes, content_html) VALUES (?,?,?,?)", id, 1000, 0, "<p>hi</p>");
  return id;
}

afterEach(() => vi.unstubAllGlobals());

describe("preview counts and skips", () => {
  it("counts exactly who would enrol and why others are skipped", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const app = makeApp(env);
    const seqId = makeSequence(d1, "active");

    const ok = addContact(d1, "ok@example.com", "valid");
    const unknown = addContact(d1, "unknown@example.com", "unknown");
    const inv = addContact(d1, "inv@example.com", "invalid");
    const pend = addContact(d1, "pend@example.com", "pending");
    const sup = addContact(d1, "sup@example.com", "valid");
    const noconsent = addContact(d1, "noconsent@example.com", "valid");
    const already = addContact(d1, "already@example.com", "valid");

    d1.sql("INSERT INTO suppressions (email, reason) VALUES ('sup@example.com','unsubscribe')");
    d1.sql(
      "INSERT INTO sequence_enrollments (sequence_id, contact_id, email, status, enrolled_at, last_sent_position, next_due_at) VALUES (?,?,?,'active',1,0,1)",
      seqId,
      already,
      "already@example.com",
    );

    addSubmission(d1, "s1", "ok@example.com", ok, true);
    addSubmission(d1, "s2", "unknown@example.com", unknown, true);
    addSubmission(d1, "s3", "inv@example.com", inv, true);
    addSubmission(d1, "s4", "pend@example.com", pend, true);
    addSubmission(d1, "s5", "sup@example.com", sup, true);
    addSubmission(d1, "s6", "noconsent@example.com", noconsent, false);
    addSubmission(d1, "s7", "already@example.com", already, true);
    addSubmission(d1, "s8", "nocontact@example.com", null, true); // no contact row
    addSubmission(d1, "s9", "ok@example.com", ok, true); // duplicate address

    const r = await app.get(`/api/sequences/${seqId}/form-enroll/preview?form_slug=contact-us`);
    expect(r.status).toBe(200);
    expect(r.json.submissions_total).toBe(9);
    expect(r.json.distinct_contacts).toBe(8);
    expect(r.json.would_enroll).toBe(2);
    expect(r.json.skipped["no_consent"]).toBe(1);
    expect(r.json.skipped["suppressed"]).toBe(1);
    expect(r.json.skipped["already_enrolled"]).toBe(1);
    expect(r.json.skipped["no_contact"]).toBe(1);
    expect(r.json.skipped["not_sendable:invalid"]).toBe(1);
    expect(r.json.skipped["not_sendable:pending"]).toBe(1);
    expect(r.json.held).toBe(false);
  });
});

describe("enrol", () => {
  it("enrols the eligible addresses and is idempotent on a repeat", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const app = makeApp(env);
    const seqId = makeSequence(d1, "active");

    const ok = addContact(d1, "ok@example.com", "valid");
    const unknown = addContact(d1, "unknown@example.com", "unknown");
    addSubmission(d1, "s1", "ok@example.com", ok, true);
    addSubmission(d1, "s2", "unknown@example.com", unknown, true);

    const first = await app.post(`/api/sequences/${seqId}/form-enroll`, { form_slug: "contact-us" });
    expect(first.status).toBe(200);
    expect(first.json.enrolled).toBe(2);
    expect(d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM sequence_enrollments WHERE sequence_id=?", seqId)[0].n).toBe(2);

    // A repeat enrols nobody (the "not yet enrolled" filter).
    const second = await app.post(`/api/sequences/${seqId}/form-enroll`, { form_slug: "contact-us" });
    expect(second.json.enrolled).toBe(0);
    expect(second.json.skipped_reasons["already_enrolled"]).toBe(2);
    expect(d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM sequence_enrollments WHERE sequence_id=?", seqId)[0].n).toBe(2);
  });

  it("captures and holds when the sequence is a draft", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const app = makeApp(env);
    const seqId = makeSequence(d1, "draft");

    const ok = addContact(d1, "ok@example.com", "valid");
    addSubmission(d1, "s1", "ok@example.com", ok, true);

    const r = await app.post(`/api/sequences/${seqId}/form-enroll`, { form_slug: "contact-us" });
    expect(r.json.enrolled).toBe(1);
    expect(r.json.held).toBe(true);
    const e = d1.sql<any>("SELECT * FROM sequence_enrollments WHERE sequence_id=?", seqId)[0];
    expect(e.status).toBe("active");
    expect(e.next_due_at).toBeNull(); // clock held until activation
  });
});

describe("consent parsing", () => {
  it("accepts only an explicit accepted=true", () => {
    expect(consentAccepted('{"accepted":true}')).toBe(true);
    expect(consentAccepted('{"accepted":false}')).toBe(false);
    expect(consentAccepted(null)).toBe(false);
    expect(consentAccepted("not json")).toBe(false);
    expect(consentAccepted({ accepted: "true" })).toBe(true);
  });
});
