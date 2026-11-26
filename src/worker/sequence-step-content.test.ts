// A sequence step owns its own email copy (0024).
//
// Seeding a step from a template copies the content in; editing the step must
// NOT touch the template, and editing the template must NOT change the step.
// The step's copy is what actually goes out.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ALL_MIGRATIONS, applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { Env, SendJob } from "./types";
import { sequencesRoutes } from "./routes/sequences";
import { templatesRoutes } from "./routes/templates";
import { processSendBatch } from "./consumer";

function freshDb(): TestD1 {
  const d1 = createTestD1();
  applyMigrations(d1, ALL_MIGRATIONS);
  return d1;
}

function jsonResp(body: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as any;
}

function makeEnv(d1: TestD1) {
  const jobs: { body: SendJob }[] = [];
  const sends: any[] = [];
  vi.stubGlobal(
    "fetch",
    (async (url: unknown, init: any) => {
      const u = String(url);
      if (u.includes("/email/send")) {
        sends.push(init?.body ? JSON.parse(String(init.body)) : {});
        return jsonResp({ request_id: "req-1", data: { succeeded: 1, email_id: "msg-1" } });
      }
      return jsonResp({ data: { results: [] } });
    }) as any,
  );
  const env = {
    DB: d1,
    SMTP2GO_API_KEY: "test-key",
    SEND_QUEUE: {
      send: async (body: SendJob) => jobs.push({ body }),
      sendBatch: async () => {},
    },
    SEND_TIMEZONE: "Australia/Brisbane",
    DEFAULT_FROM_EMAIL: "from@localdentists.au",
    DEFAULT_FROM_NAME: "LocalDentists.au",
    WEBHOOK_TOKEN: "tok",
  } as unknown as Env;
  return { env, jobs, sends };
}

function makeApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/sequences", sequencesRoutes);
  app.route("/api/templates", templatesRoutes);
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await app.fetch(
      new Request(`http://test${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
      env,
    );
    return { status: r.status, json: (await r.json()) as any };
  };
  return {
    post: (p: string, b?: unknown) => call("POST", p, b),
    patch: (p: string, b?: unknown) => call("PATCH", p, b),
    get: (p: string) => call("GET", p),
  };
}

/** Insert a queued sequence send for the given step and drain the queue. */
async function sendStep(env: Env, d1: TestD1, seqId: number, stepId: number) {
  d1.sql("INSERT INTO contacts (email, status, email_status) VALUES ('c@example.com','active','valid') ON CONFLICT(email) DO NOTHING");
  const contactId = Number(d1.sql<{ id: number }>("SELECT id FROM contacts WHERE email='c@example.com'")[0].id);
  d1.sql(
    "INSERT OR IGNORE INTO sequence_enrollments (sequence_id, contact_id, email, status, enrolled_at, last_sent_position, last_sent_at) VALUES (?,?,?,'active',1,0,1)",
    seqId,
    contactId,
    "c@example.com",
  );
  const eid = Number(
    d1.sql<{ id: number }>("SELECT id FROM sequence_enrollments WHERE sequence_id=? AND contact_id=?", seqId, contactId)[0].id,
  );
  const step = d1.sql<any>("SELECT * FROM sequence_steps WHERE id=?", stepId)[0];
  const r = d1.sql<{ id: number }>(
    "INSERT INTO sequence_sends (sequence_id, enrollment_id, step_id, step_position, contact_id, email, status) VALUES (?,?,?,?,?,?,'queued') RETURNING id",
    seqId,
    eid,
    stepId,
    step.position,
    contactId,
    "c@example.com",
  )[0];
  const sendId = Number(d1.sql<{ id: number }>("SELECT id FROM sequence_sends ORDER BY id DESC LIMIT 1")[0].id);
  void r;
  const messages = [
    { body: { sequence_id: seqId, sequence_send_id: sendId, contact_id: contactId, email: "c@example.com" } as SendJob, ack: vi.fn(), retry: vi.fn() },
  ];
  await processSendBatch({ messages } as any, env);
  return sendId;
}

afterEach(() => vi.unstubAllGlobals());

describe("step copy independence", () => {
  it("seeds from a template, then edits freely without touching the template", async () => {
    const d1 = freshDb();
    const { env } = makeEnv(d1);
    const app = makeApp(env);

    const tpl = await app.post("/api/templates", {
      name: "Reusable",
      subject: "Original subject",
      html: "<p>ORIGINAL body</p>",
      source: "local",
    });
    const tplId = Number(tpl.json.id);

    const seq = await app.post("/api/sequences", { name: "Seq", from_email: "from@localdentists.au" });
    const seqId = Number(seq.json.id);
    const s1 = await app.post(`/api/sequences/${seqId}/steps`, { name: "Step 1", wait_minutes: 0 });
    const s2 = await app.post(`/api/sequences/${seqId}/steps`, { name: "Step 2", wait_minutes: 60 });
    const step1 = Number(s1.json.id);
    const step2 = Number(s2.json.id);

    // "Insert from template" — a COPY into the step.
    const tplRow = (await app.get(`/api/templates/${tplId}`)).json.row;
    await app.patch(`/api/sequences/${seqId}/steps/${step1}`, {
      subject: tplRow.subject,
      content_html: tplRow.html,
      content_text: tplRow.text ?? "",
      seeded_from_template_id: tplId,
    });
    let step = d1.sql<any>("SELECT * FROM sequence_steps WHERE id=?", step1)[0];
    expect(step.content_html).toBe("<p>ORIGINAL body</p>");
    expect(Number(step.seeded_from_template_id)).toBe(tplId);

    // Edit the step's copy.
    await app.patch(`/api/sequences/${seqId}/steps/${step1}`, {
      subject: "Edited subject",
      content_html: "<p>EDITED body</p>",
    });
    step = d1.sql<any>("SELECT * FROM sequence_steps WHERE id=?", step1)[0];
    expect(step.content_html).toBe("<p>EDITED body</p>");

    // The template is untouched...
    const tplAfter = d1.sql<any>("SELECT * FROM templates WHERE id=?", tplId)[0];
    expect(tplAfter.html).toBe("<p>ORIGINAL body</p>");
    expect(tplAfter.subject).toBe("Original subject");

    // ...and step 2 was never affected by step 1's edits.
    const other = d1.sql<any>("SELECT * FROM sequence_steps WHERE id=?", step2)[0];
    expect(other.content_html).toBeNull();

    // Editing the TEMPLATE does not change the step's copy.
    await app.patch(`/api/templates/${tplId}`, { html: "<p>TEMPLATE v2</p>" });
    step = d1.sql<any>("SELECT * FROM sequence_steps WHERE id=?", step1)[0];
    expect(step.content_html).toBe("<p>EDITED body</p>");
  });

  it("sends the step's OWN copy, not the template's current body", async () => {
    const d1 = freshDb();
    const { env, sends } = makeEnv(d1);
    const app = makeApp(env);

    const tpl = await app.post("/api/templates", { name: "T", subject: "S", html: "<p>ORIGINAL</p>", source: "local" });
    const tplId = Number(tpl.json.id);
    const seq = await app.post("/api/sequences", { name: "Seq", from_email: "from@localdentists.au" });
    const seqId = Number(seq.json.id);
    const s1 = await app.post(`/api/sequences/${seqId}/steps`, { name: "Step", wait_minutes: 0 });
    const step1 = Number(s1.json.id);

    await app.patch(`/api/sequences/${seqId}/steps/${step1}`, {
      subject: "Step subject",
      content_html: "<p>STEP COPY</p>",
      seeded_from_template_id: tplId,
    });
    // Change the template AFTER seeding.
    await app.patch(`/api/templates/${tplId}`, { html: "<p>TEMPLATE CHANGED</p>", subject: "Changed" });
    // The sequence must be active for its steps to send.
    d1.sql("UPDATE sequences SET status='active' WHERE id=?", seqId);

    await sendStep(env, d1, seqId, step1);

    expect(sends.length).toBe(1);
    expect(String(sends[0].html_body)).toContain("STEP COPY");
    expect(String(sends[0].html_body)).not.toContain("ORIGINAL");
    expect(String(sends[0].html_body)).not.toContain("TEMPLATE CHANGED");
    expect(String(sends[0].subject)).toBe("Step subject");
  });
});
