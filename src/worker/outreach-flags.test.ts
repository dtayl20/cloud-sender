// Outreach flags + boolean-ish attribute matching.
//
// The flags are derived in the worker (D1 cannot join across databases) and
// merged into each mirrored contact's attributes, so the sync itself is run
// here against real SQL: a real emailer DB (migrations applied) and a fake
// SOURCE_DB holding the summary tables.

import { describe, expect, it } from "vitest";
import { applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";
import type { Env } from "./types";
import {
  applyOutreachFlags,
  loadOutreachFlags,
  syncSourceTable,
  type OutreachFlags,
} from "./sync";
import { buildAudienceQuery, countSegment } from "./audience";

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
  "0020_sequences.sql",
  "0021_sequence_timezone_backfill.sql",
];

function emailerDb(): TestD1 {
  const d1 = createTestD1();
  applyMigrations(d1, FRESH);
  d1.exec("INSERT INTO source_tables (id, table_name, email_column) VALUES (1, 'dentists', 'contact_email')");
  return d1;
}

/** A source DB whose scan/thumb tables mirror dental_directory's shape. */
function sourceDb(opts: { withThumbs?: boolean } = { withThumbs: true }): TestD1 {
  const d1 = createTestD1();
  d1.exec(`
    CREATE TABLE dentists (id INTEGER PRIMARY KEY, business_name TEXT, contact_email TEXT);
    CREATE TABLE website_platforms (id INTEGER PRIMARY KEY, platform TEXT, status TEXT);
    CREATE TABLE booking_platforms (id INTEGER PRIMARY KEY, platform TEXT, status TEXT);
  `);
  if (opts.withThumbs !== false) {
    d1.exec("CREATE TABLE clinic_thumbs (id INTEGER PRIMARY KEY, small_bytes INTEGER, updated_at TEXT)");
  }
  return d1;
}

function seedSource(d1: TestD1, opts: { thumbs?: boolean } = { thumbs: true }) {
  // 1 = everything clean   2 = no thumb, clean scan
  // 3 = thumb, failed scan 4 = thumb, website row missing entirely
  d1.exec(`
    INSERT INTO dentists (id, business_name, contact_email) VALUES
      (1, 'Alpha Dental', 'a@alpha.test'),
      (2, 'Bravo Dental', 'b@bravo.test'),
      (3, 'Charlie Dental', 'c@charlie.test'),
      (4, 'Delta Dental', 'd@delta.test');
    INSERT INTO website_platforms (id, platform, status) VALUES
      (1, 'wordpress', '200'), (2, 'wordpress', '200'),
      (3, 'wordpress', '500'), (4, 'wordpress', 'ERROR');
    INSERT INTO booking_platforms (id, platform, status) VALUES
      (1, 'none', '200'), (2, 'none', '200'),
      (3, 'none', '200'), (4, 'none', '200');
  `);
  if (opts.thumbs !== false) {
    d1.exec("INSERT INTO clinic_thumbs (id, small_bytes) VALUES (1, 1000), (3, 1000), (4, 1000)");
  }
}

function attrsOf(d1: TestD1, email: string): Record<string, unknown> {
  const row = d1.sql<{ attributes: string }>(
    "SELECT attributes FROM contacts WHERE email = ?",
    email,
  )[0];
  return JSON.parse(row.attributes);
}

function runSync(emailer: TestD1, source: TestD1) {
  const env = { DB: emailer, SOURCE_DB: source, SEND_QUEUE: {} } as unknown as Env;
  return syncSourceTable(env, { id: 1, table_name: "dentists", email_column: "contact_email" });
}

describe("applyOutreachFlags (pure merge)", () => {
  const loaded: OutreachFlags = {
    thumbsLoaded: true,
    scanLoaded: true,
    thumbIds: new Set([1]),
    scanOkIds: new Set([1]),
  };

  it("is additive and leaves existing attribute keys untouched", () => {
    const extras: Record<string, unknown> = { state: "QLD", priority_level: 3 };
    applyOutreachFlags(extras, 1, loaded);
    expect(extras).toEqual({
      state: "QLD",
      priority_level: 3,
      has_thumb: 1,
      scan_ok: 1,
      outreach_ok: 1,
    });
  });

  it("marks a clinic missing from a source table as 0, never absent", () => {
    const extras: Record<string, unknown> = {};
    applyOutreachFlags(extras, 99, loaded);
    expect(extras).toEqual({ has_thumb: 0, scan_ok: 0, outreach_ok: 0 });
  });

  it("writes nothing at all when there is no source DB", () => {
    const extras: Record<string, unknown> = { state: "TAS" };
    applyOutreachFlags(extras, 1, null);
    expect(extras).toEqual({ state: "TAS" });
    expect("has_thumb" in extras).toBe(false);
  });

  it("leaves an unreadable source table's key absent, and keeps outreach_ok at 0", () => {
    const extras: Record<string, unknown> = {};
    applyOutreachFlags(extras, 1, {
      thumbsLoaded: false,
      scanLoaded: true,
      thumbIds: new Set(),
      scanOkIds: new Set([1]),
    });
    expect(extras).toEqual({ scan_ok: 1, outreach_ok: 0 });
    expect("has_thumb" in extras).toBe(false);
  });
});

describe("syncSourceTable merges the derived flags", () => {
  it("sets has_thumb / scan_ok / outreach_ok per clinic", async () => {
    const emailer = emailerDb();
    const source = sourceDb();
    seedSource(source);

    const r = await runSync(emailer, source);
    expect(r.upserted).toBe(4);

    expect(attrsOf(emailer, "a@alpha.test")).toMatchObject({
      has_thumb: 1,
      scan_ok: 1,
      outreach_ok: 1,
    });
    // thumb missing, scans clean
    expect(attrsOf(emailer, "b@bravo.test")).toMatchObject({
      has_thumb: 0,
      scan_ok: 1,
      outreach_ok: 0,
    });
    // thumb present, scan failed
    expect(attrsOf(emailer, "c@charlie.test")).toMatchObject({
      has_thumb: 1,
      scan_ok: 0,
      outreach_ok: 0,
    });
    // thumb present, website row is an error status
    expect(attrsOf(emailer, "d@delta.test")).toMatchObject({
      has_thumb: 1,
      scan_ok: 0,
      outreach_ok: 0,
    });

    // Mirrored columns survive alongside the flags.
    expect(attrsOf(emailer, "a@alpha.test")).toMatchObject({
      id: 1,
      business_name: "Alpha Dental",
    });
    emailer.close();
    source.close();
  });

  it("still syncs when the clinic_thumbs table is missing (flag stays absent, no throw)", async () => {
    const emailer = emailerDb();
    const source = sourceDb({ withThumbs: false });
    seedSource(source, { thumbs: false });

    const r = await runSync(emailer, source);
    expect(r.upserted).toBe(4);

    const attrs = attrsOf(emailer, "a@alpha.test");
    expect("has_thumb" in attrs).toBe(false);
    expect(attrs.scan_ok).toBe(1);
    expect(attrs.outreach_ok).toBe(0);
    emailer.close();
    source.close();
  });

  it("returns null from loadOutreachFlags when no source DB is bound", async () => {
    const env = { DB: emailerDb() } as unknown as Env;
    expect(await loadOutreachFlags(env)).toBeNull();
  });

  it("reads the source tables once for the whole run, not per contact", async () => {
    const emailer = emailerDb();
    const source = sourceDb();
    seedSource(source);
    // Many clinics: a per-contact read would show up as repeated queries.
    let selects = 0;
    const spy = {
      prepare: (sql: string) => {
        if (/FROM clinic_thumbs|FROM website_platforms|FROM booking_platforms/.test(sql)) selects++;
        return source.prepare(sql);
      },
    };
    const env = { DB: emailer, SOURCE_DB: spy, SEND_QUEUE: {} } as unknown as Env;
    await syncSourceTable(env, { id: 1, table_name: "dentists", email_column: "contact_email" });
    expect(selects).toBe(3);
    emailer.close();
    source.close();
  });
});

describe("boolean-ish attribute matching", () => {
  function seedContacts() {
    const d1 = createTestD1();
    applyMigrations(d1, ["0001_init.sql"]);
    const rows: [string, string][] = [
      ["num1@x.test", '{"outreach_ok":1}'],
      ["num0@x.test", '{"outreach_ok":0}'],
      ["strue@x.test", '{"outreach_ok":"true"}'],
      ["syes@x.test", '{"outreach_ok":"yes"}'],
      ["absent@x.test", '{}'],
      ["other@x.test", '{"outreach_ok":2}'],
    ];
    for (const [email, attributes] of rows) {
      d1.sql("INSERT INTO contacts (email, attributes) VALUES (?, ?)", email, attributes);
    }
    return d1;
  }

  async function emailsFor(value: string, op: "eq" | "neq" = "eq") {
    const d1 = seedContacts();
    const { sql, binds } = buildAudienceQuery(
      { status: ["active"], tag_mode: "any", rules: [{ source: "attribute", field: "outreach_ok", op, value }] },
      false,
    );
    const res = await d1.prepare(sql).bind(...binds).all<{ email: string }>();
    d1.close();
    return res.results.map((r) => r.email).sort();
  }

  it("matches 1, true and yes against a stored 1 (and each other)", async () => {
    for (const spelling of ["1", "true", "yes", "TRUE", "Yes", " true "]) {
      expect(await emailsFor(spelling)).toEqual([
        "num1@x.test",
        "strue@x.test",
        "syes@x.test",
      ]);
    }
  });

  it("matches 0, false and no against a stored 0", async () => {
    for (const spelling of ["0", "false", "no", "FALSE", "No"]) {
      expect(await emailsFor(spelling)).toEqual(["num0@x.test"]);
    }
  });

  it("does not drag a non-boolean value into the boolean match", async () => {
    // 2 is neither truthy nor falsy here, and an absent key never matches eq.
    const matched = await emailsFor("1");
    expect(matched).not.toContain("other@x.test");
    expect(matched).not.toContain("absent@x.test");
  });

  it("uses the normalised CASE expression rather than raw string equality", () => {
    const { sql, binds } = buildAudienceQuery(
      { status: ["active"], tag_mode: "any", rules: [{ source: "attribute", field: "outreach_ok", op: "eq", value: "yes" }] },
      false,
    );
    expect(sql).toContain("CASE lower(trim(CAST(json_extract(c.attributes, '$.outreach_ok') AS TEXT)))");
    expect(binds).toEqual(["active", 1]);
  });

  it("neq keeps missing keys in the result, like a plain attribute neq", async () => {
    const matched = await emailsFor("1", "neq");
    expect(matched).toEqual(["absent@x.test", "num0@x.test", "other@x.test"]);
  });

  it("leaves a non-boolean rule on plain equality", () => {
    const { sql, binds } = buildAudienceQuery(
      { status: ["active"], tag_mode: "any", rules: [{ source: "attribute", field: "state", op: "eq", value: "QLD" }] },
      false,
    );
    expect(sql).toContain("json_extract(c.attributes, '$.state') = ?");
    expect(sql).not.toContain("CASE lower(trim(CAST");
    expect(binds).toEqual(["active", "QLD"]);
  });

  it("counts the audience the segment will use (outreach_ok = 1)", async () => {
    const d1 = seedContacts();
    const { count } = await countSegment(
      { DB: d1 as unknown as D1Database },
      {
        status: ["active"],
        rules: [{ source: "attribute", field: "outreach_ok", op: "eq", value: "1" }],
      },
    );
    expect(count).toBe(3);
    d1.close();
  });
});

