// Per-campaign subject lines.
//
// The subject is the one campaign field that lands in a mail HEADER, so these
// tests pin both halves of the feature:
//   * precedence -- the campaign's own subject wins, an unset one falls back to
//     the template's exactly as before;
//   * header safety -- control characters (CR/LF above all) are stripped and the
//     value is capped, at the API and again on the way out.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { Env } from "./types";
import { campaignsRoutes } from "./routes/campaigns";
import {
  MAX_SUBJECT_LENGTH,
  SUBJECT_TARGET_LENGTH,
  clampSubject,
  renderSubject,
  sanitizeSubject,
  subjectSource,
  subjectTooLong,
} from "../shared/subject";
import { renderSubject as renderSubjectViaWorker } from "./render";

const FRESH = [
  "0001_init.sql",
  "0002_segments.sql",
  "0003_campaign_var_mapping.sql",
  "0004_source_sync.sql",
  "0005_campaign_body.sql",
  "0006_campaign_tags.sql",
  "0016_email_verification.sql",
  "0017_email_verification_backfill.sql",
  "0018_email_verify_queue.sql",
];

const VARS = { first_name: "Alex", practice_name: "Riverside Dental" };

describe("subject precedence", () => {
  it("uses the campaign's own subject when it is set", () => {
    expect(renderSubject("A campaign subject", "The template subject", {})).toBe(
      "A campaign subject",
    );
  });

  it("falls back to the template's subject when the campaign has none", () => {
    expect(renderSubject(null, "The template subject", {})).toBe("The template subject");
    expect(renderSubject(undefined, "The template subject", {})).toBe("The template subject");
  });

  it("treats a blank or whitespace-only subject as unset", () => {
    expect(renderSubject("", "The template subject", {})).toBe("The template subject");
    expect(renderSubject("   \t  ", "The template subject", {})).toBe("The template subject");
    expect(subjectSource("  ", "Template")).toBe("Template");
  });

  it("sends an empty subject when neither side has one (unchanged behaviour)", () => {
    expect(renderSubject(null, null, {})).toBe("");
    expect(renderSubject(undefined, "", {})).toBe("");
  });

  it("is the single resolution point the Worker re-exports", () => {
    expect(renderSubjectViaWorker).toBe(renderSubject);
  });
});

describe("variables render inside the campaign subject", () => {
  it("substitutes the same variables the body uses", () => {
    expect(renderSubject("Hi {{first_name}} of {{practice_name}}", "Template", VARS)).toBe(
      "Hi Alex of Riverside Dental",
    );
  });

  it("substitutes in the fallback template subject too", () => {
    expect(renderSubject(null, "Update for {{practice_name}}", VARS)).toBe(
      "Update for Riverside Dental",
    );
  });

  it("renders an undeclared variable as empty, exactly like the body", () => {
    expect(renderSubject("Hi {{nobody}}", "T", VARS)).toBe("Hi");
  });
});

describe("header-injection safety: control characters are stripped", () => {
  it("strips CR and LF from a campaign subject", () => {
    const injected = "Hello\r\nBcc: attacker@example.com";

    const out = renderSubject(injected, "Template", {});
    expect(out).toBe("Hello Bcc: attacker@example.com");
    expect(out).not.toMatch(/[\r\n]/);
  });

  it("strips CR, LF and other control characters from the template subject", () => {
    const out = renderSubject(null, "Line one\nLine two\u0000\u0007", {});
    expect(out).toBe("Line one Line two");
  });

  it("strips control characters out of substituted values", () => {
    // A contact field is attacker-influenced data too.
    const out = renderSubject("Hi {{first_name}}", "Template", {
      first_name: "Alex\r\nBcc: evil@example.com",
    });
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).toBe("Hi Alex Bcc: evil@example.com");
  });

  it("sanitizeSubject collapses whitespace and never throws on non-strings", () => {
    expect(sanitizeSubject("  a \n\n b  ")).toBe("a b");
    expect(sanitizeSubject(null)).toBe("");
    expect(sanitizeSubject(42)).toBe("");
  });
});

describe("subject length is capped", () => {
  it("rejects a sanitized subject longer than the cap", () => {
    expect(subjectTooLong("x".repeat(MAX_SUBJECT_LENGTH))).toBe(false);
    expect(subjectTooLong("x".repeat(MAX_SUBJECT_LENGTH + 1))).toBe(true);
    // Length is measured after control characters are removed, so a subject
    // padded with newlines is not falsely rejected.
    expect(subjectTooLong("x".repeat(MAX_SUBJECT_LENGTH) + "\r\n")).toBe(false);
  });

  it("truncates on the way out, so no header can ever exceed the cap", () => {
    const long = "y".repeat(MAX_SUBJECT_LENGTH + 50);

    // The hard cap on the stored subject...
    expect(clampSubject(long)).toHaveLength(MAX_SUBJECT_LENGTH);
    // ...and the tighter cap on the RENDERED line, which is what goes on the
    // wire (see src/worker/subject-cap.test.ts for the shortening rules).
    expect(renderSubject(long, "Template", {})).toHaveLength(SUBJECT_TARGET_LENGTH);
  });

  it("leaves a normal-length subject untouched", () => {
    expect(clampSubject("A normal subject")).toBe("A normal subject");
  });
});

describe("campaign subject survives the campaigns API", () => {
  function freshDb(): TestD1 {
    const d1 = createTestD1();
    applyMigrations(d1, FRESH);
    applyMigrations(d1, ["0007_campaign_subject.sql", "0009_campaign_send_plan.sql", "0010_campaign_send_ramp.sql", "0011_campaign_send_spread.sql"]);
    return d1;
  }

  function makeApp(d1: TestD1) {
    const app = new Hono<{ Bindings: Env }>();
    app.route("/api/campaigns", campaignsRoutes);
    const env = { DB: d1 } as unknown as Env;
    const call = (path: string, init?: RequestInit) =>
      app.fetch(new Request(`http://test${path}`, init), env);
    const json = async (path: string, init?: RequestInit) => (await call(path, init)).json() as any;
    const post = (path: string, body: unknown) =>
      json(path, { method: "POST", body: JSON.stringify(body) });
    const patch = (path: string, body: unknown) =>
      json(path, { method: "PATCH", body: JSON.stringify(body) });
    return { call, json, post, patch };
  }

  it("stores a subject on create and returns it on the campaign GET", async () => {
    const { json, post } = makeApp(freshDb());

    const created = await post("/api/campaigns", {
      name: "Subjected",
      from_email: "a@b.com",
      subject: "Hi {{first_name}}",
    });
    expect(created.id).toBe(1);

    const row = await json("/api/campaigns/1");
    expect(row.row.subject).toBe("Hi {{first_name}}");
  });

  it("stores NULL when the subject is omitted, blank or whitespace-only", async () => {
    const { json, post } = makeApp(freshDb());

    await post("/api/campaigns", { name: "Omitted", from_email: "a@b.com" });
    await post("/api/campaigns", { name: "Blank", from_email: "a@b.com", subject: "" });
    await post("/api/campaigns", { name: "Spaces", from_email: "a@b.com", subject: "   " });

    expect((await json("/api/campaigns/1")).row.subject).toBeNull();
    expect((await json("/api/campaigns/2")).row.subject).toBeNull();
    expect((await json("/api/campaigns/3")).row.subject).toBeNull();
  });

  it("strips control characters before the subject is stored", async () => {
    const { json, post } = makeApp(freshDb());

    await post("/api/campaigns", {
      name: "Injected",
      from_email: "a@b.com",
      subject: "Hello\r\nBcc: attacker@example.com",
    });

    const stored = (await json("/api/campaigns/1")).row.subject;
    expect(stored).toBe("Hello Bcc: attacker@example.com");
    expect(stored).not.toMatch(/[\r\n]/);
  });

  it("rejects an over-length subject on create and on patch", async () => {
    const { call, json, patch, post } = makeApp(freshDb());
    const tooLong = "x".repeat(MAX_SUBJECT_LENGTH + 1);

    const createRes = await call("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({ name: "Long", from_email: "a@b.com", subject: tooLong }),
    });
    expect(createRes.status).toBe(400);
    const createBody = (await createRes.json()) as { error?: string };
    expect(createBody.error).toContain(String(MAX_SUBJECT_LENGTH));

    const created = await post("/api/campaigns", { name: "Ok", from_email: "a@b.com" });
    expect(created.id).toBe(1);

    const patchRes = await call("/api/campaigns/1", {
      method: "PATCH",
      body: JSON.stringify({ subject: tooLong }),
    });
    expect(patchRes.status).toBe(400);

    // The rejected patch changed nothing.
    expect((await json("/api/campaigns/1")).row.subject).toBeNull();
  });

  it("sets, replaces and clears a subject on patch", async () => {
    const { json, patch, post } = makeApp(freshDb());
    await post("/api/campaigns", { name: "Editable", from_email: "a@b.com" });

    await patch("/api/campaigns/1", { subject: "First" });
    expect((await json("/api/campaigns/1")).row.subject).toBe("First");

    await patch("/api/campaigns/1", { subject: "Second" });
    expect((await json("/api/campaigns/1")).row.subject).toBe("Second");

    // Blanking the field goes back to the template's subject.
    await patch("/api/campaigns/1", { subject: "" });
    expect((await json("/api/campaigns/1")).row.subject).toBeNull();

    // A patch that does not mention subject leaves it alone.
    await patch("/api/campaigns/1", { subject: "Kept" });
    await patch("/api/campaigns/1", { name: "Renamed" });
    expect((await json("/api/campaigns/1")).row.subject).toBe("Kept");
  });

  it("leaves a campaign created without a subject sending the template's, unchanged", async () => {
    const d1 = freshDb();
    const { json, post } = makeApp(d1);

    await post("/api/campaigns", { name: "Pre-existing shape", from_email: "a@b.com" });

    const row = (await json("/api/campaigns/1")).row;
    expect(row.subject).toBeNull();
    // NULL subject == the template's, which is what renderSubject resolves to.
    expect(renderSubject(row.subject, "Template subject", VARS)).toBe("Template subject");
  });
});

describe("0007 migration is additive", () => {
  it("adds the column without touching existing campaign rows", () => {
    const d1 = createTestD1();
    applyMigrations(d1, FRESH);
    d1.exec(
      "INSERT INTO campaigns (name, from_email, status) VALUES ('Old campaign', 'a@b.com', 'sent')",
    );

    applyMigrations(d1, ["0007_campaign_subject.sql"]);

    const rows = d1.sql<{ name: string; subject: string | null; status: string }>(
      "SELECT name, subject, status FROM campaigns",
    );
    expect(rows).toEqual([{ name: "Old campaign", subject: null, status: "sent" }]);
  });
});
