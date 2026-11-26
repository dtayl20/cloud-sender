// The text/plain half of a campaign renders through RAW substitution.
//
// The bug: the text template was rendered through the same HTML-escaping
// Mustache pass as the HTML body, so every substituted value arrived escaped in
// a part no mail client ever decodes:
//
//   See Your Clinic Report: https:&#x2F;&#x2F;localdentists.au&#x2F;...
//
// These tests pin the fix and its boundaries:
//   * a variable URL in the text body arrives with real `/`, `?`, `=` and no
//     entities;
//   * a value containing `&` and `<` is RAW in text but STILL escaped in HTML;
//   * a value that merely looks like an entity is not decoded either;
//   * the HTML body's output is unchanged for the same input;
//   * the subject is unescaped (a header is neither HTML nor a text part);
//   * the test-send path uses the same fixed rendering, so the bug cannot hide
//     until a real send.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { Env } from "./types";
import { campaignsRoutes } from "./routes/campaigns";
import { renderSubject } from "../shared/subject";
import { render, renderBody, renderText, renderTextBody } from "./render";
import { renderRaw } from "../shared/rawRender";
import { mergeBody } from "../shared/body";

const ENTITY = /&#x([0-9a-fA-F]+);|&#(\d+);|&(amp|lt|gt|quot|apos|#39);/;

describe("the non-escaping text render path", () => {
  it("substitutes a variable URL with real characters, no entities", () => {
    const template = "See Your Clinic Report: {{report_url}}";
    const vars = {
      report_url: "https://localdentists.au/data/clinic-report?key=ac238b&id=42",
    };

    const text = renderText(template, vars);

    expect(text).toBe("See Your Clinic Report: https://localdentists.au/data/clinic-report?key=ac238b&id=42");
    expect(text).not.toMatch(ENTITY);
  });

  it("leaves a value containing & and < raw in text but escapes it in HTML", () => {
    const template = "Hi {{practice_name}}";
    const vars = { practice_name: "Marks & Spencer <Clinic>" };

    expect(renderText(template, vars)).toBe("Hi Marks & Spencer <Clinic>");
    // The HTML path is unchanged: the escaping is a markup-context control.
    expect(render(template, vars)).toBe("Hi Marks &amp; Spencer &lt;Clinic&gt;");
  });

  it("does not decode a value that only looks like an entity", () => {
    const template = "Name: {{practice_name}}";
    const vars = { practice_name: "A &amp; B" };

    // Raw substitution: the literal text is inserted as-is, never re-interpreted.
    expect(renderText(template, vars)).toBe("Name: A &amp; B");
    // HTML escaping still escapes the ampersand of the literal entity.
    expect(render(template, vars)).toBe("Name: A &amp;amp; B");
  });

  it("is the same render renderRaw exposes", () => {
    const vars = { x: "a/b?c=d" };
    expect(renderText("v={{x}}", vars)).toBe(renderRaw("v={{x}}", vars));
  });
});

describe("renderTextBody mirrors renderBody for the text half", () => {
  it("merges the campaign body at {{content}} then substitutes raw", () => {
    const template = "{{content}}\n\n--\nLocalDentists.au\n{{report_url}}";
    const body = "Get your report: {{report_url}}";
    const vars = { report_url: "https://localdentists.au/data/clinic-report?key=ac238b" };

    const out = renderTextBody(template, vars, body);

    expect(out).toBe(
      "Get your report: https://localdentists.au/data/clinic-report?key=ac238b\n\n--\nLocalDentists.au\nhttps://localdentists.au/data/clinic-report?key=ac238b",
    );
    expect(out).not.toMatch(ENTITY);
    // Same merge order as the HTML twin.
    expect(mergeBody(template, body)).toContain("Get your report: {{report_url}}");
  });

  it("appends (never drops) a body when the template has no {{content}} slot", () => {
    expect(renderTextBody("Line one", { x: "1" }, "Body")).toBe("Line oneBody");
  });

  it("leaves the template alone when there is no campaign body", () => {
    expect(renderTextBody("Hi {{first_name}}", { first_name: "Alex" }, null)).toBe("Hi Alex");
  });
});

describe("the HTML body's output is unchanged", () => {
  it("renderBody still escapes a URL variable exactly as before", () => {
    const template = '<a href="{{report_url}}">Report</a>';
    const vars = { report_url: "https://localdentists.au/data/clinic-report?key=ac238b" };

    // Mustache's default HTML escaping, byte-for-byte what shipped before.
    expect(renderBody(template, vars, null)).toBe(
      '<a href="https:&#x2F;&#x2F;localdentists.au&#x2F;data&#x2F;clinic-report?key&#x3D;ac238b">Report</a>',
    );
    // The text twin of the same input is raw.
    expect(renderTextBody(template, vars)).toBe(
      '<a href="https://localdentists.au/data/clinic-report?key=ac238b">Report</a>',
    );
  });
});

describe("the subject is a header, so it is unescaped too", () => {
  it("keeps & and / literal in a substituted subject", () => {
    const out = renderSubject("Update for {{practice_name}}", "Template", {
      practice_name: "Marks & Spencer",
    });
    expect(out).toBe("Update for Marks & Spencer");
    expect(out).not.toMatch(ENTITY);
  });

  it("keeps a URL-shaped subject variable intact", () => {
    const out = renderSubject("Your report: {{report_url}}", "T", {
      report_url: "https://localdentists.au/data/report?key=ac238b",
    });
    expect(out).toBe("Your report: https://localdentists.au/data/report?key=ac238b");
  });
});

// ---------------------------------------------------------------------------
// The test-send path renders the same way, so the fix is visible before send.
// ---------------------------------------------------------------------------

const FRESH = [
  "0001_init.sql",
  "0002_segments.sql",
  "0003_campaign_var_mapping.sql",
  "0004_source_sync.sql",
  "0005_campaign_body.sql",
  "0006_campaign_tags.sql",
  "0007_campaign_subject.sql",
  "0008_campaign_sending_domain.sql",
  "0009_campaign_send_plan.sql",
  "0010_campaign_send_ramp.sql",
  "0011_campaign_send_spread.sql",
  "0016_email_verification.sql",
  "0017_email_verification_backfill.sql",
  "0018_email_verify_queue.sql",
];

const API_KEY = "ab12cd34ef56ab78";
const TEMPLATE_HTML =
  '<p>Hi {{practice_name}}</p><a href="{{report_url}}">See your clinic report</a>';
const TEMPLATE_TEXT =
  "Hi {{practice_name}}\n\nSee Your Clinic Report: {{report_url}}\n\nhttps://localdentists.au/how-it-works";
const MAPPING = {
  practice_name: "practice_name",
  report_url: {
    value: "https://localdentists.au/data/clinic-report?key={{attributes.api_key}}",
  },
};

function freshDb(): TestD1 {
  const d1 = createTestD1();
  applyMigrations(d1, FRESH);
  d1.sql(
    "INSERT INTO templates (source, name, subject, html, text, is_base) VALUES ('local','Report','Report for {{practice_name}}',?,?,0)",
    TEMPLATE_HTML,
    TEMPLATE_TEXT,
  );
  return d1;
}

function templateId(d1: TestD1): number {
  return d1.sql<{ id: number }>("SELECT id FROM templates WHERE name='Report'")[0].id;
}

function addContact(d1: TestD1, opts: { email: string; practice_name: string }): number {
  const r = d1.sql<{ id: number }>(
    `INSERT INTO contacts (email, first_name, practice_name, attributes, status, source)
     VALUES (?,?,?,?, 'active', 'seed') RETURNING id`,
    opts.email,
    "Alex",
    opts.practice_name,
    JSON.stringify({ api_key: API_KEY, slug: "riverside-dental" }),
  );
  return r[0].id;
}

function addCampaign(d1: TestD1): number {
  const r = d1.sql<{ id: number }>(
    `INSERT INTO campaigns (name, template_id, from_email, from_name, status, var_mapping)
     VALUES (?, ?, 'listing@localdentists.au', 'LocalDentists.au', 'draft', ?) RETURNING id`,
    "Clinic outreach",
    templateId(d1),
    JSON.stringify(MAPPING),
  );
  return r[0].id;
}

function stubSmtp() {
  const calls: any[] = [];
  vi.stubGlobal("fetch", async (url: unknown, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ request_id: "req-1", data: { succeeded: 1, email_id: "email-1" } }),
    };
  });
  return calls;
}

function makeApp(d1: TestD1) {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/campaigns", campaignsRoutes);
  const env = {
    DB: d1,
    SMTP2GO_API_KEY: "test-key",
    DEFAULT_FROM_EMAIL: "listing@localdentists.au",
  } as unknown as Env;
  return {
    post: async (path: string, body: unknown) => {
      const res = await app.fetch(
        new Request(`http://test${path}`, { method: "POST", body: JSON.stringify(body) }),
        env,
      );
      return { status: res.status, body: (await res.json()) as any };
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the test-send path uses the fixed text rendering", () => {
  it("sends a raw text_body and a still-escaped html_body", async () => {
    const d1 = freshDb();
    const contactId = addContact(d1, {
      email: "riverside@example.com",
      practice_name: "Marks & Spencer Dental",
    });
    const campaignId = addCampaign(d1);
    const calls = stubSmtp();
    const app = makeApp(d1);

    const { body } = await app.post(`/api/campaigns/${campaignId}/test`, {
      to: ["test@example.com"],
      contact_id: contactId,
    });

    expect(body.results[0].ok).toBe(true);
    expect(calls).toHaveLength(1);

    const text = calls[0].body.text_body as string;
    // The URL from the variable is intact.
    expect(text).toContain(
      `See Your Clinic Report: https://localdentists.au/data/clinic-report?key=${API_KEY}`,
    );
    expect(text).not.toMatch(ENTITY);
    // A `&` in the practice name arrives raw.
    expect(text).toContain("Hi Marks & Spencer Dental");
    // The template's own literal links are untouched, as before.
    expect(text).toContain("https://localdentists.au/how-it-works");

    const html = calls[0].body.html_body as string;
    // The HTML half is unchanged: escaped, as it must be in markup context.
    expect(html).toContain("Hi Marks &amp; Spencer Dental");
    expect(html).toContain(
      `https:&#x2F;&#x2F;localdentists.au&#x2F;data&#x2F;clinic-report?key&#x3D;${API_KEY}`,
    );

    // The subject is a header: raw too.
    expect(calls[0].body.subject).toBe("Report for Marks & Spencer Dental");
    expect(calls[0].body.subject).not.toMatch(ENTITY);
  });
});
