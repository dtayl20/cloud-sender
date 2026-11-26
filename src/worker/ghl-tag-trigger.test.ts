// GHL tag-triggered sends land in one shared container campaign, "GHL tag
// triggers", so they and their opens/clicks are visible in the UI.
//
// These run the real routes against an in-memory SQLite database built from the
// real migration files (0001..0015). The point of the set is the two halves of
// the feature that can regress independently:
//   * the webhook attaches every send to ONE reusable container, and a repeat
//     send to the same contact is still recorded (0015 relaxes the campaign
//     UNIQUE for tag sends);
//   * the every-minute dispatcher never treats that container as a blast, even
//     if its status/schedule are changed by hand.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { Env, SendJob } from "./types";
import { webhooksRoutes } from "./webhooks";
import { campaignsRoutes, dispatchDueCampaigns, enqueueCampaign } from "./routes/campaigns";
import {
  GHL_TAG_TRIGGER_CAMPAIGN,
  ensureGhlTagTriggerCampaign,
  isGhlTagTriggerCampaign,
} from "./ghlCampaign";

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

function stubSmtp() {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ request_id: "req-1", data: { succeeded: 1, email_id: "e1" } }),
  }));
}

function makeApp(overrides: Partial<Env> = {}) {
  const d1: TestD1 = createTestD1();
  applyMigrations(d1, MIGRATIONS);
  const queued: SendJob[] = [];
  const env = {
    DB: d1,
    SMTP2GO_API_KEY: "test-key",
    WEBHOOK_TOKEN: TOKEN,
    DEFAULT_FROM_EMAIL: "listing@localdentists.au",
    DEFAULT_FROM_NAME: "LocalDentists.au",
    SEND_TIMEZONE: "Australia/Brisbane",
    SEND_QUEUE: {
      sendBatch: async (msgs: { body: SendJob }[]) => {
        for (const m of msgs) queued.push(m.body);
      },
    },
    ...overrides,
  } as unknown as Env;

  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/webhooks", webhooksRoutes);
  app.route("/api/campaigns", campaignsRoutes);

  const post = (path: string, body: unknown) =>
    app.fetch(
      new Request(`http://test${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(body),
      }),
      env,
    );

  return { env, d1, queued, app, post };
}

const valid = {
  ghl_contact_id: "ghl_123",
  email: "manager@clinic.com.au",
  first_name: "Sam",
  clinic_name: "Harbourview Dental",
  tag: "send_playbook",
};

const containerId = (d1: TestD1): number =>
  Number(d1.sql<{ id: number }>("SELECT id FROM campaigns WHERE name='GHL tag triggers'")[0]?.id);

const containerRow = (d1: TestD1): any =>
  d1.sql<any>("SELECT * FROM campaigns WHERE name='GHL tag triggers'")[0];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the container campaign", () => {
  it("creates it once, named exactly, in a shape the dispatcher ignores", async () => {
    stubSmtp();
    const { d1 } = makeApp();
    const id = await ensureGhlTagTriggerCampaign({ DB: d1 } as unknown as Env);

    const row = containerRow(d1);
    expect(row).toBeDefined();
    expect(row.name).toBe(GHL_TAG_TRIGGER_CAMPAIGN);
    expect(row.name).toBe("GHL tag triggers");
    // Not scheduled, no window, no plan - exactly what the dispatcher skips.
    expect(row.status).toBe("draft");
    expect(row.scheduled_at).toBeNull();
    expect(row.daily_cap).toBeNull();
    expect(row.send_days).toBeNull();
    expect(row.send_time).toBeNull();
    expect(isGhlTagTriggerCampaign(row)).toBe(true);
    expect(id).toBe(Number(row.id));
  });

  it("reuses the same row on a second call (no duplicates)", async () => {
    stubSmtp();
    const { d1 } = makeApp();
    const first = await ensureGhlTagTriggerCampaign({ DB: d1 } as unknown as Env);
    const second = await ensureGhlTagTriggerCampaign({ DB: d1 } as unknown as Env);
    expect(second).toBe(first);
    expect(
      d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM campaigns WHERE name='GHL tag triggers'")[0].n,
    ).toBe(1);
  });
});

describe("a webhook send attaches to the container", () => {
  it("points the send at the container instead of NULL", async () => {
    stubSmtp();
    const { post, d1 } = makeApp();
    const res = await post("/api/webhooks/send-template", valid);
    expect(res.status).toBe(200);

    const rows = d1.sql<{ campaign_id: number | null; ghl_contact_id: string | null }>(
      "SELECT * FROM sends",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].campaign_id).toBe(containerId(d1));
    expect(rows[0].ghl_contact_id).toBe("ghl_123");
  });

  it("reuses the container across repeated sends to different contacts", async () => {
    stubSmtp();
    const { post, d1 } = makeApp();
    expect((await post("/api/webhooks/send-template", valid)).status).toBe(200);
    expect(
      (await post("/api/webhooks/send-template", { ...valid, email: "other@clinic.com.au", ghl_contact_id: "ghl_999" }))
        .status,
    ).toBe(200);

    const id = containerId(d1);
    expect(Number.isFinite(id)).toBe(true);
    const campaigns = d1.sql<{ id: number }>("SELECT id FROM campaigns WHERE name='GHL tag triggers'");
    expect(campaigns).toHaveLength(1);
    expect(d1.sql<{ campaign_id: number }>("SELECT campaign_id FROM sends").every((s) => s.campaign_id === id)).toBe(
      true,
    );
  });

  it("still records a repeat send to the SAME contact", async () => {
    stubSmtp();
    const { post, d1 } = makeApp();
    expect((await post("/api/webhooks/send-template", valid)).status).toBe(200);
    expect((await post("/api/webhooks/send-template", valid)).status).toBe(200);

    const id = containerId(d1);
    const rows = d1.sql<{ campaign_id: number }>("SELECT campaign_id FROM sends");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.campaign_id === id)).toBe(true);
    expect(d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM campaigns WHERE name='GHL tag triggers'")[0].n).toBe(1);
  });
});

describe("the dispatcher never sends the container", () => {
  it("skips it even when its status and schedule are forced to look due", async () => {
    stubSmtp();
    const { d1, queued } = makeApp();
    // Two active recipients, so an unguarded dispatch would have something to do.
    d1.exec("INSERT INTO contacts (email, email_status) VALUES ('a@example.com','valid'), ('b@example.com','valid')");
    d1.exec(
      "INSERT INTO templates (source, name, subject, html) VALUES ('local','Base','Hello','<p>Hi</p>')",
    );

    // A normal one-shot campaign, due now - the control that must still send.
    d1.exec(
      `INSERT INTO campaigns (name, template_id, from_email, status, scheduled_at)
       VALUES ('Real blast', 1, 'listing@localdentists.au', 'scheduled', 1)`,
    );

    // The container, adversarially forced to look exactly like a due one-shot:
    // scheduled, in the past, with a template and from address. The name guard
    // (and only the guard) is what keeps it out now.
    const id = await ensureGhlTagTriggerCampaign({ DB: d1 } as unknown as Env);
    d1.exec(
      `UPDATE campaigns SET status='scheduled', scheduled_at=1, template_id=1,
              from_email='listing@localdentists.au' WHERE id=${id}`,
    );

    const result = await dispatchDueCampaigns({ DB: d1, SEND_QUEUE: { sendBatch: async (msgs: { body: SendJob }[]) => { for (const m of msgs) queued.push(m.body); } } } as unknown as Env, 10);

    // The control ran; the container produced no send rows and no queue jobs.
    expect(result.failed).toBe(0);
    expect(d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM sends WHERE campaign_id=?", id)[0].n).toBe(0);
    expect(queued.every((j) => j.campaign_id !== id)).toBe(true);
    expect(queued.length).toBeGreaterThan(0);
    // The container is untouched by the pass.
    expect(containerRow(d1).status).toBe("scheduled");
  });

  it("refuses an explicit send of the container", async () => {
    stubSmtp();
    const { d1 } = makeApp();
    const id = await ensureGhlTagTriggerCampaign({ DB: d1 } as unknown as Env);
    await expect(enqueueCampaign({ DB: d1 } as unknown as Env, id)).rejects.toThrow(
      /container for GHL tag-triggered sends/,
    );
  });
});
