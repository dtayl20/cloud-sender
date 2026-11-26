// Duplicate campaign: the clone carries the SETTINGS and none of the HISTORY,
// and by default targets the contacts the source campaign has not emailed yet.
//
// These run the real routes against an in-memory SQLite database built from the
// real migration files, so the SQL — not just the handler logic — is what gets
// checked. `sends` rows are written by hand here to stand in for the queue
// consumer and the SMTP2GO webhooks, because the rule under test is exactly
// which rows count as "already emailed".

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { Env, SendJob } from "./types";
import { campaignsRoutes } from "./routes/campaigns";
import { listsRoutes } from "./routes/lists";

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
  "0016_email_verification.sql",
  "0017_email_verification_backfill.sql",
  "0018_email_verify_queue.sql",
];

const BNE = "Australia/Brisbane";

function freshDb(): TestD1 {
  const d1 = createTestD1();
  applyMigrations(d1, MIGRATIONS);
  return d1;
}

let emailSeq = 0;
interface Person {
  id: number;
  email: string;
}

function seedContacts(d1: TestD1, n: number): Person[] {
  const out: Person[] = [];
  for (let i = 0; i < n; i++) {
    emailSeq += 1;
    const email = `c${emailSeq}@example.com`;
    d1.exec(`INSERT INTO contacts (email, email_status) VALUES ('${email}', 'valid')`);
    const id = Number(d1.sql<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id);
    out.push({ id, email });
  }
  return out;
}

/** An in-app base template (has a {{content}} slot, so a campaign body is allowed). */
function makeTemplate(d1: TestD1): number {
  d1.exec(
    `INSERT INTO templates (source, name, subject, html)
     VALUES ('local', 'Base', 'Template subject', '<p>Hi</p>{{content}}')`,
  );
  return Number(d1.sql<{ id: number }>("SELECT id FROM templates ORDER BY id DESC LIMIT 1")[0].id);
}

function makeApp(d1: TestD1) {
  const queued: SendJob[] = [];
  const env = {
    DB: d1,
    SEND_QUEUE: {
      sendBatch: async (msgs: { body: SendJob }[]) => {
        for (const m of msgs) queued.push(m.body);
      },
    },
    SEND_TIMEZONE: BNE,
    DEFAULT_FROM_EMAIL: "listing@localdentists.au",
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/campaigns", campaignsRoutes);
  app.route("/api/lists", listsRoutes);
  const call = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://test${path}`, init), env);
  const json = async (path: string, init?: RequestInit) => (await call(path, init)).json() as any;
  return {
    env,
    queued,
    call,
    json,
    get: (p: string) => json(p),
    post: (p: string, b?: unknown) => json(p, { method: "POST", body: JSON.stringify(b ?? {}) }),
    patch: (p: string, b: unknown) => json(p, { method: "PATCH", body: JSON.stringify(b) }),
  };
}

const campaignRow = (d1: TestD1, id: number) =>
  d1.sql<any>("SELECT * FROM campaigns WHERE id=?", id)[0];
const sendsOf = (d1: TestD1, id: number) =>
  d1.sql<{ id: number; status: string; email: string }>(
    "SELECT id, status, email FROM sends WHERE campaign_id=? ORDER BY id",
    id,
  );
const listMembers = (d1: TestD1, listId: number) =>
  d1.sql<{ contact_id: number }>(
    "SELECT contact_id FROM list_members WHERE list_id=? ORDER BY contact_id",
    listId,
  );
const listCount = (d1: TestD1) =>
  Number(d1.sql<{ n: number }>("SELECT COUNT(*) AS n FROM lists")[0].n);

/** Create a plain campaign (template + sender, no audience selection). */
async function makeCampaign(app: ReturnType<typeof makeApp>, d1: TestD1, extra: any = {}) {
  const created = await app.post("/api/campaigns", {
    name: "Spring clinics",
    from_email: "listing@localdentists.au",
    template_id: makeTemplate(d1),
    ...extra,
  });
  expect(created.id).toBeTypeOf("number");
  return created.id as number;
}

/** A send row standing in for a real delivery attempt/outcome. */
function addSend(
  d1: TestD1,
  campaignId: number,
  p: Person,
  status: string,
  opts: { sent_at?: number; smtp2go_id?: string } = {},
) {
  d1.exec(
    `INSERT INTO sends (campaign_id, contact_id, email, status, sent_at, smtp2go_id)
     VALUES (${campaignId}, ${p.id}, '${p.email}', '${status}', ${opts.sent_at ?? "NULL"}, ${
       opts.smtp2go_id ? `'${opts.smtp2go_id}'` : "NULL"
     })`,
  );
}

describe("duplicate: copies the settings, never the history", () => {
  it("copies every setting and resets status, sends and timestamps", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const people = seedContacts(d1, 3);
    const tpl = makeTemplate(d1);

    const src = await app.post("/api/campaigns", {
      name: "Spring clinics",
      template_id: tpl,
      subject: "Hi {{practice_name}}",
      body_html: "<p>Hello {{first_name}}</p>",
      var_mapping: { fname: "first_name", promo: { value: "SAVE10" } },
      tags: ["melbourne", "spring"],
      sending_domain: "localdentists.au",
      from_name: "Damon Taylor",
      from_email: "listing@localdentists.au",
      reply_to: "reply@localdentists.au",
      daily_cap: 50,
      send_days: [1, 2, 3, 4, 5],
      send_time: "10:00",
      send_timezone: BNE,
    });

    // Give the source a life: running, with one delivered and one queued send.
    d1.exec(
      `UPDATE campaigns SET status='sending', scheduled_at=1234567890, started_at=1234500000 WHERE id=${src.id}`,
    );
    addSend(d1, src.id, people[0], "delivered", { sent_at: 1234500001, smtp2go_id: "abc123" });
    addSend(d1, src.id, people[1], "queued");
    const srcBefore = campaignRow(d1, src.id);

    const dup = await app.post(`/api/campaigns/${src.id}/duplicate`, {
      exclude_already_sent: false,
    });
    const clone = campaignRow(d1, dup.id);

    // The settings all come across.
    expect(clone.name).toBe("Copy of Spring clinics");
    expect(clone.template_id).toBe(srcBefore.template_id);
    expect(clone.external_template_id).toBe(srcBefore.external_template_id);
    expect(clone.subject).toBe(srcBefore.subject);
    expect(clone.body_html).toBe(srcBefore.body_html);
    expect(clone.var_mapping).toBe(srcBefore.var_mapping);
    expect(clone.sending_domain).toBe(srcBefore.sending_domain);
    expect(clone.from_name).toBe(srcBefore.from_name);
    expect(clone.from_email).toBe(srcBefore.from_email);
    expect(clone.reply_to).toBe(srcBefore.reply_to);
    expect(clone.daily_cap).toBe(50);
    expect(clone.send_days).toBe("1,2,3,4,5");
    expect(clone.send_time).toBe("10:00");
    expect(clone.send_timezone).toBe(BNE);
    expect(clone.audience_filter).toBe(srcBefore.audience_filter);
    expect((await app.get(`/api/campaigns/${dup.id}/tags`)).tags).toEqual([
      "melbourne",
      "spring",
    ]);

    // The history does not.
    expect(clone.status).toBe("draft");
    expect(clone.scheduled_at).toBeNull();
    expect(clone.started_at).toBeNull();
    expect(clone.finished_at).toBeNull();
    expect(clone.created_at).toBeGreaterThanOrEqual(srcBefore.created_at);
    expect(sendsOf(d1, dup.id)).toEqual([]);
    expect((await app.get(`/api/campaigns/${dup.id}/stats`)).stats).toEqual([]);

    // ...and the original is untouched: still sending, same timestamps, same sends.
    const srcAfter = campaignRow(d1, src.id);
    expect(srcAfter.status).toBe("sending");
    expect(srcAfter.started_at).toBe(srcBefore.started_at);
    expect(sendsOf(d1, src.id)).toHaveLength(2);
  });

  it("defaults the name to 'Copy of <name>' and accepts an explicit one", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    seedContacts(d1, 1);
    const src = await makeCampaign(app, d1);

    const def = await app.post(`/api/campaigns/${src}/duplicate`, {});
    expect(campaignRow(d1, def.id).name).toBe("Copy of Spring clinics");

    const named = await app.post(`/api/campaigns/${src}/duplicate`, {
      name: "Spring clinics v2",
    });
    expect(campaignRow(d1, named.id).name).toBe("Spring clinics v2");
  });

  it("copies a sending plan but leaves it editable (the clone is a draft)", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    seedContacts(d1, 2);
    const src = await makeCampaign(app, d1, {
      daily_cap: 2,
      send_days: [1, 2, 3, 4, 5],
      send_time: "10:00",
      send_timezone: BNE,
    });
    // A running campaign's plan is locked on the source...
    d1.exec(`UPDATE campaigns SET status='sending' WHERE id=${src}`);
    const blocked = await app.call(`/api/campaigns/${src}`, {
      method: "PATCH",
      body: JSON.stringify({ daily_cap: 500 }),
    });
    expect(blocked.status).toBe(400);

    // ...but the clone is a fresh draft, so its plan can still be changed.
    const dup = await app.post(`/api/campaigns/${src}/duplicate`, {});
    expect(campaignRow(d1, dup.id).daily_cap).toBe(2);
    const ok = await app.call(`/api/campaigns/${dup.id}`, {
      method: "PATCH",
      body: JSON.stringify({ daily_cap: 500 }),
    });
    expect(ok.status).toBe(200);
    expect(campaignRow(d1, dup.id).daily_cap).toBe(500);
  });

  it("404s for a campaign that does not exist", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const res = await app.call("/api/campaigns/999/duplicate", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

describe("duplicate: the clone targets the remainder by default", () => {
  it("excludes contacts that were actually emailed and includes never-attempted ones", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const p = seedContacts(d1, 6);
    const src = await makeCampaign(app, d1);

    // p0 sent, p1 delivered+opened, p2 queued (never attempted), p3 failed
    // (provider refused it, nothing delivered), p4 no row at all, p5 bounced
    // (a hard bounce — it did go out, so a retry would be a second copy).
    addSend(d1, src, p[0], "sent", { sent_at: 1000, smtp2go_id: "s0" });
    addSend(d1, src, p[1], "delivered", { sent_at: 1001, smtp2go_id: "s1" });
    d1.exec(`UPDATE sends SET opened_at=1002 WHERE smtp2go_id='s1'`);
    addSend(d1, src, p[2], "queued");
    addSend(d1, src, p[3], "failed");
    addSend(d1, src, p[5], "bounced", { sent_at: 1005, smtp2go_id: "s5" });

    const dup = await app.post(`/api/campaigns/${src}/duplicate`, {});

    expect(dup.exclude_already_sent).toBe(true);
    expect(dup.audience_count).toBe(6);
    expect(dup.remainder_count).toBe(3);
    expect(dup.excluded_already_sent).toBe(3);

    // The clone points at the new static list, and nowhere else.
    const clone = campaignRow(d1, dup.id);
    expect(clone.list_id).toBe(dup.list_id);
    expect(clone.segment_id).toBeNull();
    expect(clone.audience_filter).toBeNull();
    expect(dup.list_name).toBe("Copy of Spring clinics \u2014 not yet emailed (3)");
    expect(
      d1.sql<{ name: string; kind: string }>("SELECT name, kind FROM lists WHERE id=?", dup.list_id)[0],
    ).toEqual({ name: dup.list_name, kind: "static" });

    // Queued, failed and never-attempted contacts are the remainder; the sent,
    // delivered and bounced ones are not.
    expect(listMembers(d1, dup.list_id).map((m) => m.contact_id)).toEqual([
      p[2].id,
      p[3].id,
      p[4].id,
    ]);
  });

  it("keeps suppressed contacts out of the remainder list", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const p = seedContacts(d1, 3);
    const src = await makeCampaign(app, d1);
    // p1 unsubscribed: it must not enter the list even though it has no send row.
    d1.exec(`INSERT INTO suppressions (email, reason) VALUES ('${p[1].email}', 'unsubscribe')`);
    d1.exec(`UPDATE contacts SET status='unsubscribed' WHERE id=${p[1].id}`);

    const dup = await app.post(`/api/campaigns/${src}/duplicate`, {});

    expect(dup.audience_count).toBe(2);
    expect(dup.remainder_count).toBe(2);
    expect(listMembers(d1, dup.list_id).map((m) => m.contact_id)).toEqual([p[0].id, p[2].id]);
    expect(
      d1.sql<{ n: number }>(
        "SELECT COUNT(*) AS n FROM list_members lm JOIN contacts c ON c.id=lm.contact_id WHERE lm.list_id=? AND c.email=?",
        dup.list_id,
        p[1].email,
      )[0].n,
    ).toBe(0);
  });

  it("copies the original audience verbatim when exclude_already_sent is false", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const p = seedContacts(d1, 4);
    const created = await app.post("/api/lists", { name: "SA clinics", kind: "static" });
    await app.post(`/api/lists/${created.id}/members`, { contact_ids: p.map((x) => x.id) });
    const src = await makeCampaign(app, d1, { list_id: created.id });
    addSend(d1, src, p[0], "sent", { sent_at: 1000, smtp2go_id: "s0" });
    const listsBefore = listCount(d1);

    const dup = await app.post(`/api/campaigns/${src}/duplicate`, {
      exclude_already_sent: false,
    });

    const clone = campaignRow(d1, dup.id);
    expect(clone.list_id).toBe(created.id);
    expect(clone.segment_id).toBe(campaignRow(d1, src).segment_id);
    expect(dup.list_id).toBeNull();
    expect(dup.list_name).toBeNull();
    expect(dup.remainder_count).toBe(dup.audience_count);
    // Nothing new was created — the original audience is reused as-is, sent
    // contacts included (that is what "same audience" means).
    expect(listCount(d1)).toBe(listsBefore);
    expect(dup.remainder_count).toBe(4);
  });
});

describe("duplicate: the clone is a usable draft", () => {
  it("is editable and can be started", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const p = seedContacts(d1, 4);
    const src = await makeCampaign(app, d1);
    addSend(d1, src, p[0], "sent", { sent_at: 1000, smtp2go_id: "s0" });

    const dup = await app.post(`/api/campaigns/${src}/duplicate`, {});
    expect(dup.remainder_count).toBe(3);

    // Reword the clone before sending it — that is the whole point of the flow.
    const patched = await app.patch(`/api/campaigns/${dup.id}`, {
      subject: "A better subject",
      body_html: "<p>Hello again {{first_name}}</p>",
    });
    expect(patched.ok).toBe(true);
    expect(campaignRow(d1, dup.id).subject).toBe("A better subject");

    const sent = await app.post(`/api/campaigns/${dup.id}/send`);
    expect(sent.ok).toBe(true);
    expect(sent.enqueued).toBe(3);
    expect(app.queued).toHaveLength(3);
    // The new sends belong to the clone; the source keeps its own one row.
    expect(sendsOf(d1, dup.id)).toHaveLength(3);
    expect(sendsOf(d1, src)).toHaveLength(1);
  });

  it("still works with no audience selection, and never falls back to everyone", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const p = seedContacts(d1, 3);
    const src = await makeCampaign(app, d1); // no list, no segment, no filter
    addSend(d1, src, p[0], "sent", { sent_at: 1000, smtp2go_id: "s0" });
    d1.exec(`INSERT INTO suppressions (email, reason) VALUES ('${p[1].email}', 'manual')`);

    const dup = await app.post(`/api/campaigns/${src}/duplicate`, {});
    const clone = campaignRow(d1, dup.id);

    expect(clone.status).toBe("draft");
    // A list_id, not null: a null one would mean "every active contact".
    expect(clone.list_id).not.toBeNull();
    expect(dup.remainder_count).toBe(1);
    expect(listMembers(d1, dup.list_id).map((m) => m.contact_id)).toEqual([p[2].id]);

    const sent = await app.post(`/api/campaigns/${dup.id}/send`);
    expect(sent.enqueued).toBe(1);
  });

  it("creates an empty list when everyone has already been emailed", async () => {
    const d1 = freshDb();
    const app = makeApp(d1);
    const p = seedContacts(d1, 2);
    const src = await makeCampaign(app, d1);
    addSend(d1, src, p[0], "sent", { sent_at: 1000, smtp2go_id: "s0" });
    addSend(d1, src, p[1], "sent", { sent_at: 1001, smtp2go_id: "s1" });

    const dup = await app.post(`/api/campaigns/${src}/duplicate`, {});

    // Empty list, not an all-contacts clone.
    expect(dup.remainder_count).toBe(0);
    expect(dup.list_id).not.toBeNull();
    expect(listMembers(d1, dup.list_id)).toEqual([]);
    // ...and sending it is refused as empty rather than blasting the database.
    const sent = await app.post(`/api/campaigns/${dup.id}/send`);
    expect(sent.error).toContain("audience is empty");
    expect(app.queued).toHaveLength(0);
  });
});
