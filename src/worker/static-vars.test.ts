// Static (hard-coded) campaign variables.
//
// A var_mapping entry can be a contact-field path (the original shape) or an
// object carrying a literal `value`. These tests pin the render rules and the
// API round-trip, including the security rule for values that look like URLs.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { ContactRow, Env } from "./types";
import { campaignsRoutes } from "./routes/campaigns";
import { mappedVars, render, renderBody, resolveMappingEntry } from "./render";
import { sanitizeStaticValue } from "../shared/varMapping";

const FRESH = [
  "0001_init.sql",
  "0002_segments.sql",
  "0003_campaign_var_mapping.sql",
  "0004_source_sync.sql",
  "0005_campaign_body.sql",
  "0006_campaign_tags.sql",
  "0007_campaign_subject.sql",
  "0009_campaign_send_plan.sql",
  "0010_campaign_send_ramp.sql",
  "0011_campaign_send_spread.sql",
  "0016_email_verification.sql",
  "0017_email_verification_backfill.sql",
  "0018_email_verify_queue.sql",
];

function contactRow(overrides: Partial<ContactRow> = {}): ContactRow {
  return {
    id: 1,
    email: "alex@example.com",
    first_name: "Alex",
    last_name: "Nguyen",
    practice_name: "Riverside Dental",
    attributes: JSON.stringify({ promo_code: "SAVE10" }),
    status: "active",
    source: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

describe("static variables resolve", () => {
  it("resolves a static value as the literal", () => {
    const vars = mappedVars(contactRow(), { button_label: { value: "Book an appointment" } });

    expect(vars.button_label).toBe("Book an appointment");
    expect(render("<a>{{button_label}}</a>", vars)).toBe("<a>Book an appointment</a>");
  });

  it("resolves a static value even with no contact row", () => {
    const vars = mappedVars(null, { button_url: { value: "https://localdentists.au/book" } });

    expect(vars.button_url).toBe("https://localdentists.au/book");
    // email stays available for convenience, as before
    expect(vars.email).toBe("");
  });

  it("gives the static value to every recipient (same literal, different contacts)", () => {
    const mapping = { button_label: { value: "Book now" } };

    expect(mappedVars(contactRow({ first_name: "Alex" }), mapping).button_label).toBe("Book now");
    expect(mappedVars(contactRow({ first_name: "Sam" }), mapping).button_label).toBe("Book now");
  });

  it("mixes static and field entries in one mapping", () => {
    const vars = mappedVars(contactRow(), {
      first_name: "first_name",
      button_label: { value: "Book now" },
      promo: "attributes.promo_code",
    });

    expect(vars).toMatchObject({
      first_name: "Alex",
      button_label: "Book now",
      promo: "SAVE10",
    });
  });
});

describe("existing mappings are unchanged", () => {
  it("still resolves a contact field path written as a string", () => {
    const vars = mappedVars(contactRow(), { fname: "first_name", promo: "attributes.promo_code" });

    expect(vars.fname).toBe("Alex");
    expect(vars.promo).toBe("SAVE10");
  });

  it("resolves the object {field} form exactly like the string form", () => {
    const contact = contactRow();

    expect(resolveMappingEntry(contact, { field: "practice_name" })).toBe("Riverside Dental");
    expect(resolveMappingEntry(contact, "practice_name")).toBe("Riverside Dental");
    expect(resolveMappingEntry(null, { field: "practice_name" })).toBe("");
  });

  it("keeps the no-mapping legacy fallback byte-identical", () => {
    const contact = contactRow();

    expect(mappedVars(contact, null)).toEqual({
      email: "alex@example.com",
      first_name: "Alex",
      last_name: "Nguyen",
      practice_name: "Riverside Dental",
      promo_code: "SAVE10",
    });
    expect(mappedVars(contact, {})).toEqual(mappedVars(contact, null));
    expect(mappedVars(null, null, "to@example.com")).toEqual({ email: "to@example.com" });
  });
});

describe("precedence when an entry has both a field and a static value", () => {
  it("lets the static value win over the contact field", () => {
    const contact = contactRow();
    const entry = { field: "practice_name", value: "Riverside Dental (static)" };

    expect(resolveMappingEntry(contact, entry)).toBe("Riverside Dental (static)");

    const vars = mappedVars(contact, { practice_name: entry });
    expect(vars.practice_name).toBe("Riverside Dental (static)");
  });

  it("treats an explicitly blank static value as static (no fall-through to the field)", () => {
    expect(resolveMappingEntry(contactRow(), { field: "first_name", value: "" })).toBe("");
  });
});

describe("unset variables stay empty", () => {
  it("resolves a variable with no contact row to an empty string", () => {
    expect(resolveMappingEntry(null, "first_name")).toBe("");
    expect(mappedVars(null, { first_name: "first_name" }).first_name).toBe("");
  });

  it("resolves an unknown dotted path to an empty string", () => {
    expect(resolveMappingEntry(contactRow(), "attributes.nope")).toBe("");
    expect(resolveMappingEntry(contactRow(), "nope.deep.path")).toBe("");
  });

  it("still renders empty for a variable the mapping never declared", () => {
    expect(render("<p>{{missing}}</p>", {})).toBe("<p></p>");
    expect(render("<p>{{missing}}</p>", mappedVars(contactRow(), { a: "first_name" }))).toBe(
      "<p></p>",
    );
  });
});

describe("static values are escaped, never emitted raw", () => {
  it("escapes HTML in a static value on substitution", () => {
    const vars = mappedVars(null, { label: { value: 'A & B <script>alert("x")</script>' } });

    expect(render("<p>{{label}}</p>", vars)).toBe(
      "<p>A &amp; B &lt;script&gt;alert(&quot;x&quot;)&lt;&#x2F;script&gt;</p>",
    );
  });

  it("escapes a static value used inside an href attribute", () => {
    const vars = mappedVars(null, { q: { value: 'a" onmouseover="evil()' } });

    expect(render('<a href="https://x/?q={{q}}">go</a>', vars)).toBe(
      '<a href="https://x/?q=a&quot; onmouseover&#x3D;&quot;evil()">go</a>',
    );
  });

  it("escapes static values in a base template body render too", () => {
    const out = renderBody(
      '<div class="body">{{content}}</div>',
      mappedVars(null, { label: { value: "<b>&</b>" } }),
      "<p>{{label}}</p>",
    );

    expect(out).toBe('<div class="body"><p>&lt;b&gt;&amp;&lt;&#x2F;b&gt;</p></div>');
  });
});

describe("unsafe URL schemes are neutralised", () => {
  it("drops javascript: / data: / vbscript: / file: values", () => {
    expect(sanitizeStaticValue("javascript:alert(1)")).toBe("");
    expect(sanitizeStaticValue("JavaScript:alert(1)")).toBe("");
    expect(sanitizeStaticValue("  javascript:alert(1)")).toBe("");
    expect(sanitizeStaticValue("java\tscript:alert(1)")).toBe("");
    expect(sanitizeStaticValue("javascript:\nalert(1)")).toBe("");
    expect(sanitizeStaticValue("data:text/html;base64,PHNjcmlwdD4=")).toBe("");
    expect(sanitizeStaticValue("vbscript:msgbox(1)")).toBe("");
    expect(sanitizeStaticValue("file:///etc/passwd")).toBe("");
  });

  it("allows http, https and mailto", () => {
    expect(sanitizeStaticValue("https://localdentists.au/book")).toBe(
      "https://localdentists.au/book",
    );
    expect(sanitizeStaticValue("http://example.com")).toBe("http://example.com");
    expect(sanitizeStaticValue("mailto:hello@localdentists.au")).toBe(
      "mailto:hello@localdentists.au",
    );
  });

  it("leaves values that are not URIs alone (relative paths, prose with a colon)", () => {
    expect(sanitizeStaticValue("/book-now")).toBe("/book-now");
    expect(sanitizeStaticValue("#book")).toBe("#book");
    expect(sanitizeStaticValue("Note: see below")).toBe("Note: see below");
    expect(sanitizeStaticValue("Book now")).toBe("Book now");
    expect(sanitizeStaticValue("Open 7 days: Mon to Sun")).toBe("Open 7 days: Mon to Sun");
    expect(sanitizeStaticValue("")).toBe("");
  });

  it("neutralises the value at render time, including in an href", () => {
    const vars = mappedVars(null, { button_url: { value: "javascript:alert(1)" } });

    expect(vars.button_url).toBe("");
    expect(render('<a href="{{button_url}}">Book</a>', vars)).toBe('<a href="">Book</a>');
  });

  it("does not mutate an allowed URL when it renders", () => {
    const vars = mappedVars(null, {
      button_url: { value: "https://localdentists.au/book?a=1&b=2" },
    });

    expect(render('<a href="{{button_url}}">Book</a>', vars)).toBe(
      '<a href="https:&#x2F;&#x2F;localdentists.au&#x2F;book?a&#x3D;1&amp;b&#x3D;2">Book</a>',
    );
  });
});

describe("var_mapping survives the campaigns API", () => {
  function freshDb(): TestD1 {
    const d1 = createTestD1();
    applyMigrations(d1, FRESH);
    return d1;
  }

  function makeApp(d1: TestD1) {
    const app = new Hono<{ Bindings: Env }>();
    app.route("/api/campaigns", campaignsRoutes);
    const env = { DB: d1 } as unknown as Env;
    const call = (path: string, init?: RequestInit) =>
      app.fetch(new Request(`http://test${path}`, init), env);
    const json = async (path: string, init?: RequestInit) =>
      (await call(path, init)).json() as Promise<{
        id?: number;
        row?: { var_mapping?: string | null };
        error?: unknown;
      }>;
    const post = (path: string, body: unknown) =>
      json(path, { method: "POST", body: JSON.stringify(body) });
    return { call, json, post };
  }

  it("stores and returns a mixed mapping (static + field + legacy string)", async () => {
    const d1 = freshDb();
    const { json, post } = makeApp(d1);

    const created = await post("/api/campaigns", {
      name: "Static vars",
      from_email: "a@b.com",
      var_mapping: {
        fname: "first_name",
        button_label: { value: "Book now" },
        button_url: { value: "https://localdentists.au/book" },
      },
    });
    expect(created.id).toBe(1);

    const row = await json("/api/campaigns/1");
    expect(JSON.parse(row.row!.var_mapping!)).toEqual({
      fname: "first_name",
      button_label: { value: "Book now" },
      button_url: { value: "https://localdentists.au/book" },
    });
  });

  it("still stores a pure contact-field mapping in the original shape", async () => {
    const d1 = freshDb();
    const { json, post } = makeApp(d1);

    await post("/api/campaigns", {
      name: "Legacy",
      from_email: "a@b.com",
      var_mapping: { fname: "first_name", promo: "attributes.promo_code" },
    });

    const row = await json("/api/campaigns/1");
    expect(row.row!.var_mapping).toBe(
      JSON.stringify({ fname: "first_name", promo: "attributes.promo_code" }),
    );
  });

  it("rejects a mapping entry that is neither a string nor an object of strings", async () => {
    const d1 = freshDb();
    const { call, post } = makeApp(d1);

    const bad = await post("/api/campaigns", {
      name: "Bad",
      from_email: "a@b.com",
      var_mapping: { x: { value: 1 } },
    });
    expect(bad.error).toBeTruthy();

    const res = await call("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({
        name: "Bad",
        from_email: "a@b.com",
        var_mapping: { x: { value: 1 } },
      }),
    });
    expect(res.status).toBe(400);
  });
});
