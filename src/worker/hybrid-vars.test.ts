// Hybrid static values: a static `value` that contains {{contact.field}}
// placeholders, resolved per recipient.
//
// These tests pin the four rules that make the feature safe to use:
//   * placeholders resolve CONTACT FIELDS only, one pass — no recursion, no way
//     to reach another variable's value;
//   * in an href the substituted parts are URL-encoded (once), while the literal
//     text around them stays exactly as typed;
//   * the scheme rule runs AFTER interpolation, so a placeholder cannot smuggle
//     javascript:/data: in;
//   * a placeholder that resolves to nothing fails the whole link safe.
// A value with no placeholder must behave exactly as it did before.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { ContactRow, Env } from "./types";
import { campaignsRoutes } from "./routes/campaigns";
import { mappedVars, render, renderBody, resolveMappingEntry, urlContextVars } from "./render";
import { findUrlContextVars, hasHybridPlaceholder } from "../shared/varMapping";

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

/** A LocalDentists.au-style contact: the per-recipient key lives in attributes. */
function contactRow(overrides: Partial<ContactRow> = {}): ContactRow {
  return {
    id: 1,
    email: "alex@example.com",
    first_name: "Alex",
    last_name: "Nguyen",
    practice_name: "Riverside Dental",
    attributes: JSON.stringify({ api_key: "ab12cd34ef56ab78", slug: "riverside-dental" }),
    status: "active",
    source: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

function attrs(extra: Record<string, string>): string {
  return JSON.stringify({ api_key: "ab12cd34ef56ab78", slug: "riverside-dental", ...extra });
}

/**
 * The URL a click actually follows: Mustache HTML-escapes the substituted value
 * (/ and = become entities, as it always has), and a browser decodes entities in
 * an attribute value. Decoding here makes the assertion about the link rather
 * than about the escape spelling.
 */
function hrefOf(html: string): string {
  const m = /href="([^"]*)"/.exec(html);
  return (m?.[1] ?? "")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#x3D;/g, "=")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

const PROFILE_TEMPLATE =
  '<p>Hi {{first_name}}</p><a href="{{button_url}}">Set up your profile</a>';

describe("hybrid values resolve per recipient", () => {
  it("keeps the literal and swaps the field for each recipient", () => {
    const mapping = {
      button_url: { value: "https://localdentists.au/setup-profile?api_key={{attributes.api_key}}" },
    };
    const urlVars = new Set(["button_url"]);

    const alex = mappedVars(contactRow(), mapping, undefined, urlVars).button_url;
    const sam = mappedVars(
      contactRow({ email: "sam@example.com", attributes: attrs({ api_key: "0011223344556677" }) }),
      mapping,
      undefined,
      urlVars,
    ).button_url;

    expect(alex).toBe("https://localdentists.au/setup-profile?api_key=ab12cd34ef56ab78");
    expect(sam).toBe("https://localdentists.au/setup-profile?api_key=0011223344556677");
  });

  it("resolves a plain contact column as well as an attributes.* path", () => {
    const vars = mappedVars(contactRow(), {
      button_url: { value: "https://x.example/welcome/{{first_name}}?k={{attributes.api_key}}" },
    });

    expect(vars.button_url).toBe("https://x.example/welcome/Alex?k=ab12cd34ef56ab78");
  });

  it("treats a value with no placeholder as a pure literal (unchanged path)", () => {
    expect(hasHybridPlaceholder("https://localdentists.au/book")).toBe(false);
    expect(hasHybridPlaceholder("{{attributes.api_key}}")).toBe(true);

    const mapping = { label: { value: "Book now" }, url: { value: "https://x.example/a?b=1&c=2" } };
    const plain = mappedVars(contactRow(), mapping);
    const withUrlVars = mappedVars(contactRow(), mapping, undefined, new Set(["label", "url"]));

    expect(plain).toMatchObject({ label: "Book now", url: "https://x.example/a?b=1&c=2" });
    // urlVars must not change a value that has nothing to interpolate.
    expect(withUrlVars).toEqual(plain);
  });
});

describe("href values encode the substituted part, once", () => {
  it("URL-encodes only the interpolation, leaving the literal as typed", () => {
    const mapping = {
      button_url: { value: "https://x.example/p?k={{attributes.api_key}}&src=email" },
    };
    const vars = mappedVars(
      contactRow({ attributes: attrs({ api_key: "x&admin=1 y/z?" }) }),
      mapping,
      undefined,
      new Set(["button_url"]),
    );

    expect(vars.button_url).toBe("https://x.example/p?k=x%26admin%3D1%20y%2Fz%3F&src=email");
    // encoded exactly once — no %25 (the encoding of "%") anywhere
    expect(String(vars.button_url)).not.toContain("%25");
  });

  it("cannot reshape the URL: an injected & and = stay inside one parameter", () => {
    const vars = mappedVars(
      contactRow({ attributes: attrs({ api_key: "k&admin=1" }) }),
      { button_url: { value: "https://x.example/p?k={{attributes.api_key}}" } },
      undefined,
      new Set(["button_url"]),
    );

    const url = String(vars.button_url);
    expect(url).toBe("https://x.example/p?k=k%26admin%3D1");
    // the literal's own "?" is the only parameter separator
    expect(url.split("?").length).toBe(2);
    expect(url.split("&").length).toBe(1);
  });

  it("does not URL-encode a hybrid value that is plain text", () => {
    const vars = mappedVars(contactRow({ attributes: attrs({ api_key: "a&b c" }) }), {
      note: { value: "Your key is {{attributes.api_key}}" },
    });

    expect(vars.note).toBe("Your key is a&b c");
  });

  it("renders the encoded URL into the href, HTML-escaped by Mustache as before", () => {
    const template = '<a href="{{button_url}}&src=email">Book</a>';
    const vars = mappedVars(
      contactRow({ attributes: attrs({ api_key: "a&b c" }) }),
      { button_url: { value: "https://x.example/p?k={{attributes.api_key}}" } },
      undefined,
      urlContextVars(template, null),
    );

    const out = render(template, vars);
    // the literal text in the template is not escaped; the substituted value is
    expect(out).toBe(
      '<a href="https:&#x2F;&#x2F;x.example&#x2F;p?k&#x3D;a%26b%20c&src=email">Book</a>',
    );
    // …and a browser reads that as the URL we meant, with the key still one parameter
    expect(hrefOf(out)).toBe("https://x.example/p?k=a%26b%20c&src=email");
  });

  it("keeps a whole-URL placeholder intact (a URL is not a URL component)", () => {
    const mapping = { booking_url: { value: "{{attributes.booking_url}}" } };
    const vars = mappedVars(
      contactRow({ attributes: attrs({ booking_url: "https://riverside.example/book?a=1&b=2" }) }),
      mapping,
      undefined,
      new Set(["booking_url"]),
    );

    // encoded as a component this would be https%3A%2F%2F… — it must not be
    expect(vars.booking_url).toBe("https://riverside.example/book?a=1&b=2");
  });
});

describe("the scheme rule still runs, after interpolation", () => {
  it("neutralises a scheme that only a placeholder introduces", () => {
    const contact = contactRow({ attributes: attrs({ proto: "javascript" }) });

    // href context
    expect(
      resolveMappingEntry(contact, { value: "{{attributes.proto}}:alert(1)" }, true),
    ).toBe("");
    // text context — same rule, applied to the interpolated result
    expect(resolveMappingEntry(contact, { value: "{{attributes.proto}}:alert(1)" }, false)).toBe("");
  });

  it("neutralises a data: URL built by interpolation in an href", () => {
    const contact = contactRow({ attributes: attrs({ payload: "text/html;base64,PHNjcmlwdD4=" }) });
    const vars = mappedVars(
      contact,
      { button_url: { value: "data:{{attributes.payload}}" } },
      undefined,
      new Set(["button_url"]),
    );

    expect(vars.button_url).toBe("");
    expect(render('<a href="{{button_url}}">x</a>', vars)).toBe('<a href="">x</a>');
  });

  it("still allows http/https/mailto literals that interpolation extends", () => {
    const vars = mappedVars(
      contactRow(),
      {
        https_url: { value: "https://x.example/p?k={{attributes.api_key}}" },
        mail: { value: "mailto:{{email}}?subject=Hello" },
      },
      undefined,
      new Set(["https_url", "mail"]),
    );

    expect(vars.https_url).toBe("https://x.example/p?k=ab12cd34ef56ab78");
    expect(vars.mail).toBe("mailto:alex@example.com?subject=Hello");
  });

  it("drops a whole-URL placeholder that points at an unsafe scheme", () => {
    const vars = mappedVars(
      contactRow({ attributes: attrs({ booking_url: "javascript:alert(1)" }) }),
      { booking_url: { value: "{{attributes.booking_url}}" } },
      undefined,
      new Set(["booking_url"]),
    );

    expect(vars.booking_url).toBe("");
  });
});

describe("placeholders cannot reach another variable (no recursion)", () => {
  it("treats a placeholder as a contact field, never as another variable's value", () => {
    const vars = mappedVars(contactRow(), {
      a: { value: "prefix-{{b}}" },
      b: { value: "literal-B" },
    });

    // {{b}} is the contact field "b", which does not exist — it must NOT pick up
    // the value of the variable named b.
    expect(vars.a).toBe("prefix-");
    expect(vars.b).toBe("literal-B");
  });

  it("terminates on a self-reference instead of looping", () => {
    const vars = mappedVars(contactRow(), { x: { value: "{{x}}" } });
    expect(vars.x).toBe("");
  });

  it("terminates on a mutually recursive pair", () => {
    const vars = mappedVars(contactRow(), {
      p: { value: "{{q}}" },
      q: { value: "{{p}}" },
    });
    expect(vars).toMatchObject({ p: "", q: "" });
  });

  it("does not re-scan what it substituted (one pass only)", () => {
    // The contact's field contains placeholder-looking text; it is data, not a
    // template, so it must survive verbatim.
    const vars = mappedVars(
      contactRow({ attributes: attrs({ api_key: "{{first_name}}" }) }),
      { button_url: { value: "https://x.example/p?k={{attributes.api_key}}" } },
      undefined,
      new Set(["button_url"]),
    );

    expect(vars.button_url).toBe("https://x.example/p?k=%7B%7Bfirst_name%7D%7D");
  });
});

describe("an unresolved placeholder fails safe", () => {
  it("drops the whole value rather than emitting a half-built URL", () => {
    const vars = mappedVars(
      contactRow(),
      { button_url: { value: "https://x.example/p?k={{attributes.missing}}" } },
      undefined,
      new Set(["button_url"]),
    );

    expect(vars.button_url).toBe("");
    expect(render('<a href="{{button_url}}">Book</a>', vars)).toBe('<a href="">Book</a>');
  });

  it("also fails safe when there is no contact row at all", () => {
    expect(
      resolveMappingEntry(null, { value: "https://x.example/p?k={{attributes.api_key}}" }, true),
    ).toBe("");
  });

  it("leaves a text value as text when the field is missing (an unset variable)", () => {
    const vars = mappedVars(contactRow(), { note: { value: "Key: {{attributes.missing}}" } });
    expect(vars.note).toBe("Key: ");
  });
});

describe("URL context is detected from the document", () => {
  it("collects only the variables used inside an href", () => {
    const vars = findUrlContextVars(PROFILE_TEMPLATE);
    expect([...vars]).toEqual(["button_url"]);
    expect(findUrlContextVars('<p>Hi {{first_name}}</p>').size).toBe(0);
    expect(findUrlContextVars(null).size).toBe(0);
  });

  it("sees links that only exist in the per-campaign body", () => {
    expect([...urlContextVars("<div>{{content}}</div>", PROFILE_TEMPLATE)]).toEqual(["button_url"]);
  });

  it("renders the profile button end to end with the per-recipient key", () => {
    const mapping = {
      first_name: "first_name",
      button_url: { value: "https://localdentists.au/setup-profile?api_key={{attributes.api_key}}" },
    };
    const vars = mappedVars(contactRow(), mapping, undefined, urlContextVars(PROFILE_TEMPLATE, null));

    const out = renderBody(PROFILE_TEMPLATE, vars, null);
    expect(out).toContain("<p>Hi Alex</p>");
    expect(hrefOf(out)).toBe(
      "https://localdentists.au/setup-profile?api_key=ab12cd34ef56ab78",
    );
  });
});

describe("a hybrid value survives the campaigns API", () => {
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
    return { json, post };
  }

  it("stores and returns a hybrid value exactly as typed", async () => {
    const { json, post } = makeApp(freshDb());
    const hybrid = "https://localdentists.au/setup-profile?api_key={{attributes.api_key}}";

    const created = await post("/api/campaigns", {
      name: "Hybrid",
      from_email: "a@b.com",
      var_mapping: { first_name: "first_name", button_url: { value: hybrid } },
    });
    expect(created.id).toBe(1);

    const row = await json("/api/campaigns/1");
    expect(JSON.parse(row.row!.var_mapping!)).toEqual({
      first_name: "first_name",
      button_url: { value: hybrid },
    });
  });
});
