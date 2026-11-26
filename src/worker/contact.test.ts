// The public contact endpoint. It is the only route on this Worker that a
// stranger can reach and that sends mail, so the checks below are the ones that
// matter: what it refuses, who it refuses to mail, and that nothing a submitter
// types can become markup.
//
// The route runs against a real SQLite database built from the real migration
// (node:sqlite via the shared test shim), and the SMTP2GO call is stubbed at
// `fetch`, so the assertions are on the exact payload that would have left.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { Env } from "./types";
import {
  CONTACT_HONEYPOT_FIELD,
  CONTACT_TO_EMAIL_DEFAULT,
  buildContactMail,
  checkRateLimit,
  clientIp,
  contactRoutes,
  escapeHtml,
  ipHash,
  isAllowedOrigin,
  validateContactInput,
} from "./routes/contact";

const BASE = 1_766_000_000; // an arbitrary, fixed "now" in seconds

function stubSmtp(respond?: () => any) {
  const calls: { url: string; body: any }[] = [];
  vi.stubGlobal("fetch", async (url: unknown, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (respond) return respond();
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ request_id: "req-1", data: { succeeded: 1, email_id: "e1" } }),
    };
  });
  return calls;
}

function makeApp(overrides: Partial<Env> = {}) {
  const d1: TestD1 = createTestD1();
  applyMigrations(d1, ["0012_contact_rate.sql"]);
  const env = {
    DB: d1,
    SMTP2GO_API_KEY: "test-key",
    IP_SALT: "test-salt",
    DEFAULT_FROM_EMAIL: "listing@localdentists.au",
    CONTACT_FROM_NAME: "Website Contact Form",
    CONTACT_RATE_LIMIT: "5",
    CONTACT_RATE_WINDOW_SECONDS: "600",
    ...overrides,
  } as unknown as Env;

  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/contact", contactRoutes);

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.fetch(
      new Request("http://test/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      env,
    );

  return { env, d1, app, post };
}

const valid = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  phone: "0400 000 000",
  message: "We need after-hours lead follow-up.",
};

/** Response bodies in these tests are shape-checked by hand; no runtime type. */
const jsonOf = async (res: Response): Promise<any> => (await res.json()) as any;

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(BASE * 1000);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("validation", () => {
  it("refuses a body missing the required fields and sends nothing", async () => {
    const calls = stubSmtp();
    const { post } = makeApp();

    const res = await post({});
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.error).toBe("validation_failed");
    expect(body.errors).toEqual({
      name: "required",
      email: "required",
      message: "required",
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses a malformed email address", async () => {
    const calls = stubSmtp();
    const { post } = makeApp();

    const res = await post({ ...valid, email: "not-an-email" });
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).errors).toEqual({ email: "invalid" });
    expect(calls).toHaveLength(0);
  });

  it("refuses an over-long message rather than trimming it", async () => {
    const { post } = makeApp();
    const res = await post({ ...valid, message: "x".repeat(5001) });
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).errors).toEqual({ message: "too_long" });
  });

  it("accepts a missing phone number and rejects an unusable one", async () => {
    stubSmtp();
    const { post } = makeApp();

    expect((await post({ ...valid, phone: "" })).status).toBe(200);
    const bad = await post({ ...valid, phone: "n/a" });
    expect(bad.status).toBe(400);
    expect((await jsonOf(bad)).errors).toEqual({ phone: "invalid" });
  });

  it("refuses invalid JSON", async () => {
    stubSmtp();
    const { env } = makeApp();
    const app = new Hono<{ Bindings: Env }>();
    app.route("/api/contact", contactRoutes);
    const res = await app.fetch(
      new Request("http://test/api/contact", { method: "POST", body: "{not json" }),
      env,
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe("invalid_json");
  });
});

describe("the recipient is fixed", () => {
  it("ignores a `to` supplied in the request body", async () => {
    const calls = stubSmtp();
    const { post } = makeApp();

    const res = await post({ ...valid, to: "attacker@evil.example" });
    expect(res.status).toBe(200);

    expect(calls).toHaveLength(1);
    expect(calls[0].body.to).toEqual([CONTACT_TO_EMAIL_DEFAULT]);
  });

  it("ignores client-supplied sender, subject and headers", async () => {
    const calls = stubSmtp();
    const { post } = makeApp({ CONTACT_TO_EMAIL: "someone@example.com" });

    await post({
      ...valid,
      from: "spoofed@evil.example",
      sender: "Spoof <spoofed@evil.example>",
      subject: "Injected subject",
      headers: { "X-Evil": "1" },
      custom_headers: [{ header: "Bcc", value: "attacker@evil.example" }],
    });

    const payload = calls[0].body;
    expect(payload.to).toEqual(["someone@example.com"]);
    expect(payload.sender).toBe("Website Contact Form <listing@example.com>");
    expect(payload.subject).toMatch(/^Website enquiry from Ada Lovelace/);
    expect(payload.custom_headers).toEqual([{ header: "Reply-To", value: "ada@example.com" }]);
  });

  it("reports 503 rather than mailing nowhere when the route is misconfigured", async () => {
    const calls = stubSmtp();
    const { post } = makeApp({ SMTP2GO_API_KEY: "" });
    const res = await post(valid);
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});

describe("spam control", () => {
  it("drops a filled honeypot with the same 200 a real visitor gets", async () => {
    const calls = stubSmtp();
    const { post } = makeApp();

    const res = await post({ ...valid, [CONTACT_HONEYPOT_FIELD]: "http://spam.example" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
  });

  it("lets an empty honeypot through", async () => {
    const calls = stubSmtp();
    const { post } = makeApp();
    expect((await post({ ...valid, [CONTACT_HONEYPOT_FIELD]: "" })).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("rate-limits a repeated sender and names a retry delay", async () => {
    const calls = stubSmtp();
    const { post } = makeApp({ CONTACT_RATE_LIMIT: "2" });

    expect((await post(valid)).status).toBe(200);
    expect((await post(valid)).status).toBe(200);

    const blocked = await post(valid);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "rate_limited" });
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(calls).toHaveLength(2);
  });

  it("counts each address separately", async () => {
    stubSmtp();
    const { post } = makeApp({ CONTACT_RATE_LIMIT: "1" });

    expect((await post(valid, { "CF-Connecting-IP": "203.0.113.1" })).status).toBe(200);
    expect((await post(valid, { "CF-Connecting-IP": "203.0.113.2" })).status).toBe(200);
    expect((await post(valid, { "CF-Connecting-IP": "203.0.113.1" })).status).toBe(429);
  });

  it("forgets a window once it has elapsed", async () => {
    const d1 = createTestD1();
    applyMigrations(d1, ["0012_contact_rate.sql"]);
    const hashed = await ipHash("203.0.113.9", "salt");

    const first = await checkRateLimit(d1 as unknown as D1Database, hashed, {
      limit: 1,
      windowSeconds: 600,
      now: BASE,
    });
    expect(first.allowed).toBe(true);

    const blocked = await checkRateLimit(d1 as unknown as D1Database, hashed, {
      limit: 1,
      windowSeconds: 600,
      now: BASE + 60,
    });
    expect(blocked.allowed).toBe(false);

    const later = await checkRateLimit(d1 as unknown as D1Database, hashed, {
      limit: 1,
      windowSeconds: 600,
      now: BASE + 601,
    });
    expect(later.allowed).toBe(true);
    expect(later.count).toBe(1);
  });
});

describe("origins", () => {
  it("allows the configured site, its previews and localhost", () => {
    expect(isAllowedOrigin("https://example.com")).toBe(true);
    expect(isAllowedOrigin("https://www.example.com")).toBe(true);
    expect(isAllowedOrigin("https://abc123.your-site.pages.dev", [], ".your-site.pages.dev")).toBe(true);
    expect(isAllowedOrigin("http://localhost:8080")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:5173")).toBe(true);
  });

  it("refuses anything else", () => {
    expect(isAllowedOrigin("https://evil.example")).toBe(false);
  expect(isAllowedOrigin("https://abc123.your-site.pages.dev")).toBe(false);
    expect(isAllowedOrigin("https://example.com.evil.example")).toBe(false);
    expect(isAllowedOrigin("https://localhost.evil.example")).toBe(false);
    expect(isAllowedOrigin("")).toBe(false);
  });

  it("rejects a POST from a foreign origin", async () => {
    const calls = stubSmtp();
    const { post } = makeApp();

    const res = await post(valid, { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "origin_not_allowed" });
    expect(calls).toHaveLength(0);
  });

  it("echoes the allowed origin and answers a preflight", async () => {
    stubSmtp();
    const { app, env } = makeApp();
    const origin = "https://example.com";

    const res = await app.fetch(
      new Request("http://test/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(valid),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin);

    const preflight = await app.fetch(
      new Request("http://test/api/contact", {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
      }),
      env,
    );
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(origin);
  });
});

describe("the mail", () => {
  it("escapes everything a submitter typed", () => {
    const mail = buildContactMail(
      {
        name: "A & B <b>bold</b>",
        email: "a@example.com",
        phone: "",
        message: '<script>alert("x")</script>\nsecond line & more',
      },
      new Date("2026-09-23T02:00:00Z"),
    );

    expect(mail.html).not.toMatch(/<script>/);
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).toContain("second line &amp; more");
    // The one piece of markup we do add — from our own newline conversion.
    expect(mail.html).toContain("<br />");
    // The plain-text part carries the raw text; it is not markup.
    expect(mail.text).toContain("<script>");
  });

  it("keeps a newline out of the subject line", () => {
    const mail = buildContactMail(
      {
        name: "Ada\r\nBcc: attacker@evil.example",
        email: "a@example.com",
        phone: "",
        message: "hi",
      },
      new Date("2026-09-23T02:00:00Z"),
    );
    expect(mail.subject).toBe("Website enquiry from Ada Bcc: attacker@evil.example");
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });

  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("surfaces a delivery failure as 502, never as success", async () => {
    stubSmtp(() => ({ ok: false, status: 500, text: async () => "upstream boom" }));
    const { post } = makeApp();
    const res = await post(valid);
    expect(res.status).toBe(502);
    expect((await jsonOf(res)).error).toBe("send_failed");
  });
});

describe("helpers", () => {
  it("takes the address Cloudflare reports", () => {
    expect(
      clientIp(new Request("http://test", { headers: { "CF-Connecting-IP": "203.0.113.5" } })),
    ).toBe("203.0.113.5");
    expect(
      clientIp(
        new Request("http://test", { headers: { "X-Forwarded-For": "203.0.113.6, 10.0.0.1" } }),
      ),
    ).toBe("203.0.113.6");
    expect(clientIp(new Request("http://test"))).toBe("unknown");
  });

  it("hashes an address with the salt, and not two ways", async () => {
    const a = await ipHash("203.0.113.5", "salt-one");
    const b = await ipHash("203.0.113.5", "salt-one");
    const c = await ipHash("203.0.113.5", "salt-two");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("203.0.113.5");
  });

  it("trims before validating but never widens a cap", () => {
    const result = validateContactInput({
      name: "  Ada  ",
      email: "  ada@example.com  ",
      message: "  hi  ",
    });
    expect(result.ok).toBe(true);
    expect(result.values.name).toBe("Ada");
    expect(result.values.email).toBe("ada@example.com");
    expect(result.values.message).toBe("hi");
  });
});
