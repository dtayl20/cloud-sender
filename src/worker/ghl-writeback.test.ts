// GHL engagement write-back — POST /api/webhooks/smtp2go mirrors an open/click
// onto the GHL contact as a tag + a note.
//
// These run the real route against an in-memory SQLite database built from the
// real migration files (0001..0014), with the GHL HTTP calls stubbed at `fetch`.
// The assertions are on the exact requests that would have left and on the row
// state that decides whether a repeat open writes again.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { Env } from "./types";
import { webhooksRoutes } from "./webhooks";
import { GHL_DEFAULTS, engagementNote, formatUtc, ghlConfig } from "./ghl";

const MIGRATIONS = [
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
  "0012_contact_rate.sql",
  "0013_ghl_send_template.sql",
  "0014_ghl_engagement_writeback.sql",
  "0015_ghl_tag_trigger_campaign.sql",
  "0016_email_verification.sql",
  "0017_email_verification_backfill.sql",
  "0018_email_verify_queue.sql",
];

const TOKEN = "webhook-token";

interface GhlCall {
  method: string;
  url: string;
  body: any;
}

interface StubOptions {
  search?: any;
  list?: any;
  tagsStatus?: number;
  notesStatus?: number;
  notesBody?: any;
  throwOn?: (url: string) => boolean;
}

/**
 * Stub `fetch` for the GHL API and record every call. Only the four GHL
 * endpoints the write-back uses are answered; anything else is a test failure.
 */
function stubGhl(opts: StubOptions = {}): GhlCall[] {
  const calls: GhlCall[] = [];
  vi.stubGlobal("fetch", async (url: unknown, init: any = {}) => {
    const u = String(url);
    if (opts.throwOn?.(u)) throw new Error("network down");
    const method = String(init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url: u, body });

    const json = (obj: any, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(obj),
    });

    if (u.includes("/contacts/search/")) return json(opts.search ?? { contacts: [] });
    if (u.includes("/contacts/?locationId=")) return json(opts.list ?? { contacts: [] });
    if (/\/contacts\/[^/]+\/tags$/.test(u)) return json({ tags: [] }, opts.tagsStatus ?? 201);
    if (/\/contacts\/[^/]+\/notes$/.test(u))
      return json(opts.notesBody ?? { note: { id: "n1" } }, opts.notesStatus ?? 201);
    return json({ error: "unexpected url", url: u }, 404);
  });
  return calls;
}

function makeApp(overrides: Partial<Env> = {}) {
  const d1: TestD1 = createTestD1();
  applyMigrations(d1, MIGRATIONS);
  const env = {
    DB: d1,
    SMTP2GO_API_KEY: "test-key",
    WEBHOOK_TOKEN: TOKEN,
    GHL_API_KEY: "pit-test-token",
    ...overrides,
  } as unknown as Env;

  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/webhooks", webhooksRoutes);

  const post = (event: unknown, token: string | null = TOKEN) =>
    app.fetch(
      new Request(`http://test/api/webhooks/smtp2go${token ? `?token=${token}` : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      }),
      env,
    );

  return { env, d1, app, post };
}

function seedSend(
  d1: TestD1,
  opts: { email: string; smtp2goId: string; ghlContactId?: string | null; contactId?: number | null },
): number {
  d1.sql(
    "INSERT INTO sends (campaign_id, contact_id, email, status, smtp2go_id, ghl_contact_id) VALUES (NULL,?,?, 'sent', ?, ?)",
    opts.contactId ?? null,
    opts.email,
    opts.smtp2goId,
    opts.ghlContactId ?? null,
  );
  const row = d1.sql<{ id: number }>("SELECT id FROM sends ORDER BY id DESC LIMIT 1")[0];
  return row.id;
}

const sendRow = (d1: TestD1, id: number) =>
  d1.sql<{
    ghl_contact_id: string | null;
    ghl_open_noted_at: number | null;
    ghl_click_noted_at: number | null;
  }>("SELECT ghl_contact_id, ghl_open_noted_at, ghl_click_noted_at FROM sends WHERE id=?", id)[0];

const openEvent = (over: Record<string, unknown> = {}) => ({
  event: "open",
  rcpt: "manager@clinic.com.au",
  email_id: "e1",
  subject: "Please verify your details",
  "opened-at": "2026-10-08T00:39:56Z",
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("open -> note + tag", () => {
  it("writes email_opened and a dated note, then stamps the send", async () => {
    const calls = stubGhl({ search: { contacts: [{ id: "ghl_1", email: "Manager@Clinic.com.au" }] } });
    const { post, d1 } = makeApp();
    const id = seedSend(d1, { email: "manager@clinic.com.au", smtp2goId: "e1" });

    const res = await post(openEvent());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const tag = calls.find((c) => c.url.endsWith("/contacts/ghl_1/tags"));
    expect(tag?.method).toBe("POST");
    expect(tag?.body).toEqual({ tags: ["email_opened"] });

    const note = calls.find((c) => c.url.endsWith("/contacts/ghl_1/notes"));
    expect(note?.method).toBe("POST");
    expect(note?.body.body).toBe('Opened "Please verify your details" — 2026-10-08 00:39 UTC');

    const row = sendRow(d1, id);
    expect(row.ghl_open_noted_at).not.toBeNull();
    expect(row.ghl_contact_id).toBe("ghl_1"); // resolved id remembered
  });

  it("uses the send's GHL contact id without an email lookup", async () => {
    const calls = stubGhl();
    const { post, d1 } = makeApp();
    const id = seedSend(d1, { email: "a@b.com", smtp2goId: "e2", ghlContactId: "ghl_direct" });

    await post(openEvent({ rcpt: "a@b.com", email_id: "e2" }));

    expect(calls.some((c) => c.url.includes("/contacts/search/"))).toBe(false);
    expect(calls.some((c) => c.url.endsWith("/contacts/ghl_direct/notes"))).toBe(true);
    expect(sendRow(d1, id).ghl_open_noted_at).not.toBeNull();
  });
});

describe("click -> note + tag", () => {
  it("writes email_clicked and a note carrying the URL", async () => {
    const calls = stubGhl({ search: { contacts: [{ id: "ghl_9", email: "a@b.com" }] } });
    const { post, d1 } = makeApp();
    const id = seedSend(d1, { email: "a@b.com", smtp2goId: "e3" });

    const res = await post(
      openEvent({
        event: "click",
        rcpt: "a@b.com",
        email_id: "e3",
        url: "https://localdentists.au/dentist/3795",
        subject: "Your report",
      }),
    );
    expect(res.status).toBe(200);

    const tag = calls.find((c) => c.url.endsWith("/contacts/ghl_9/tags"));
    expect(tag?.body).toEqual({ tags: ["email_clicked"] });
    const note = calls.find((c) => c.url.endsWith("/contacts/ghl_9/notes"));
    expect(note?.body.body).toBe('Clicked https://localdentists.au/dentist/3795 in "Your report"');

    const row = sendRow(d1, id);
    expect(row.ghl_click_noted_at).not.toBeNull();
    expect(row.ghl_open_noted_at).toBeNull(); // an open flag is not set by a click
  });
});

describe("duplicate suppression", () => {
  it("does not write a second note or tag on a repeat open", async () => {
    const calls = stubGhl({ search: { contacts: [{ id: "ghl_1", email: "a@b.com" }] } });
    const { post, d1 } = makeApp();
    seedSend(d1, { email: "a@b.com", smtp2goId: "e1" });

    await post(openEvent({ rcpt: "a@b.com" }));
    const afterFirst = calls.filter((c) => c.url.endsWith("/notes")).length;
    expect(afterFirst).toBe(1);

    await post(openEvent({ rcpt: "a@b.com" })); // repeat open
    await post(openEvent({ rcpt: "a@b.com" }));
    expect(calls.filter((c) => c.url.endsWith("/notes")).length).toBe(1);
    expect(calls.filter((c) => c.url.endsWith("/tags")).length).toBe(1);
  });

  it("still allows the click write-back after an open on the same send", async () => {
    const calls = stubGhl({ search: { contacts: [{ id: "ghl_1", email: "a@b.com" }] } });
    const { post, d1 } = makeApp();
    seedSend(d1, { email: "a@b.com", smtp2goId: "e1" });

    await post(openEvent({ rcpt: "a@b.com" }));
    await post(openEvent({ event: "click", rcpt: "a@b.com", url: "https://x/y" }));

    expect(calls.filter((c) => c.url.endsWith("/notes")).length).toBe(2);
    expect(
      calls.filter((c) => c.url.endsWith("/tags")).map((c) => c.body.tags[0]),
    ).toEqual(["email_opened", "email_clicked"]);
  });
});

describe("no contact found", () => {
  it("returns ok, writes nothing, and stamps the direction (no repeated lookups)", async () => {
    const calls = stubGhl(); // search + list both empty
    const { post, d1 } = makeApp();
    const id = seedSend(d1, { email: "stranger@example.com", smtp2goId: "e1" });

    const res = await post(openEvent({ rcpt: "stranger@example.com" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(calls.some((c) => c.url.endsWith("/notes"))).toBe(false);
    expect(sendRow(d1, id).ghl_open_noted_at).not.toBeNull();
  });

  it("falls back from the search endpoint to the list endpoint", async () => {
    const calls = stubGhl({ search: { contacts: [] }, list: { contacts: [{ id: "ghl_list", email: "a@b.com" }] } });
    const { post, d1 } = makeApp();
    seedSend(d1, { email: "a@b.com", smtp2goId: "e1" });

    await post(openEvent({ rcpt: "a@b.com" }));
    expect(calls.some((c) => c.url.includes("/contacts/?locationId="))).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/contacts/ghl_list/notes"))).toBe(true);
  });

  it("ignores a fuzzy search hit that is not the exact address", async () => {
    const calls = stubGhl({ search: { contacts: [{ id: "ghl_wrong", email: "someoneelse@b.com" }] } });
    const { post, d1 } = makeApp();
    seedSend(d1, { email: "a@b.com", smtp2goId: "e1" });

    await post(openEvent({ rcpt: "a@b.com" }));
    expect(calls.some((c) => c.url.includes("ghl_wrong"))).toBe(false);
  });
});

describe("GHL failures never break the webhook", () => {
  it("returns ok and leaves the flag unset when the note POST fails", async () => {
    stubGhl({ search: { contacts: [{ id: "ghl_1", email: "a@b.com" }] }, notesStatus: 500 });
    const { post, d1 } = makeApp();
    const id = seedSend(d1, { email: "a@b.com", smtp2goId: "e1" });

    const res = await post(openEvent({ rcpt: "a@b.com" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sendRow(d1, id).ghl_open_noted_at).toBeNull(); // retryable
  });

  it("returns ok when the GHL call throws (network)", async () => {
    const calls = stubGhl({ search: { contacts: [{ id: "ghl_1", email: "a@b.com" }] }, throwOn: (u) => u.endsWith("/notes") });
    const { post, d1 } = makeApp();
    const id = seedSend(d1, { email: "a@b.com", smtp2goId: "e1" });

    const res = await post(openEvent({ rcpt: "a@b.com" }));
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.url.endsWith("/tags"))).toBe(true);
    expect(sendRow(d1, id).ghl_open_noted_at).toBeNull();
  });

  it("is a no-op when GHL_API_KEY is not configured", async () => {
    const calls = stubGhl();
    const { post, d1 } = makeApp({ GHL_API_KEY: "" });
    const id = seedSend(d1, { email: "a@b.com", smtp2goId: "e1" });

    const res = await post(openEvent({ rcpt: "a@b.com" }));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
    expect(sendRow(d1, id).ghl_open_noted_at).toBeNull();
  });
});

describe("scope", () => {
  it("does not touch GHL for a non open/click event", async () => {
    const calls = stubGhl();
    const { post, d1 } = makeApp();
    seedSend(d1, { email: "a@b.com", smtp2goId: "e1" });

    const res = await post({ event: "delivered", rcpt: "a@b.com", email_id: "e1" });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("leaves a send row with no matching smtp2go id alone", async () => {
    const calls = stubGhl({ search: { contacts: [{ id: "ghl_1", email: "a@b.com" }] } });
    const { post, d1 } = makeApp();
    const id = seedSend(d1, { email: "a@b.com", smtp2goId: "other" });

    await post(openEvent({ rcpt: "a@b.com", email_id: "e1" }));
    expect(calls.some((c) => c.url.endsWith("/notes"))).toBe(false);
    expect(sendRow(d1, id).ghl_open_noted_at).toBeNull();
  });

  it("refuses a bad token and never calls GHL", async () => {
    const calls = stubGhl();
    const { post } = makeApp();
    const res = await post(openEvent(), "wrong");
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe("configuration", () => {
  it("honours GHL_API_BASE, location and tag overrides", async () => {
    const calls = stubGhl({ search: { contacts: [{ id: "ghl_x", email: "a@b.com" }] } });
    const { post, d1 } = makeApp({
      GHL_API_BASE: "https://ghl.example.test",
      GHL_LOCATION_ID: "loc_123",
      GHL_OPEN_TAG: "opened_v2",
    });
    seedSend(d1, { email: "a@b.com", smtp2goId: "e1" });

    await post(openEvent({ rcpt: "a@b.com" }));

    const search = calls.find((c) => c.url.includes("/contacts/search/"));
    expect(search?.url.startsWith("https://ghl.example.test")).toBe(true);
    expect(search?.body.locationId).toBe("loc_123");
    expect(calls.find((c) => c.url.endsWith("/tags"))?.body.tags).toEqual(["opened_v2"]);
  });

  it("falls back to the committed defaults", () => {
    const cfg = ghlConfig({} as Env);
    expect(cfg).toEqual({
      base: GHL_DEFAULTS.base,
      locationId: GHL_DEFAULTS.locationId,
      openTag: "email_opened",
      clickTag: "email_clicked",
    });
  });

  it("builds the note text and timestamp", () => {
    expect(formatUtc(0)).toBe("1970-01-01 00:00 UTC");
    expect(engagementNote("open", "Hi", null, 0)).toBe('Opened "Hi" — 1970-01-01 00:00 UTC');
    expect(engagementNote("open", "", null, 0)).toBe("Opened an email — 1970-01-01 00:00 UTC");
    expect(engagementNote("click", "Hi", "https://x/y", 0)).toBe('Clicked https://x/y in "Hi"');
    expect(engagementNote("click", "Hi", null, 0)).toBe('Clicked a link in "Hi"');
  });
});
