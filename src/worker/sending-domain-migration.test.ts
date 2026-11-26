// 0008_campaign_sending_domain.sql — the data repair.
//
// The migration is the only part of the fix that touches existing rows, so it
// is tested against the real SQL on a real SQLite engine: which rows it
// rewrites, which it deliberately leaves alone, and that it is safe to re-run.

import { describe, expect, it } from "vitest";
import { applyMigrations, createTestD1, type TestD1 } from "../test/sqlite-d1";

const BEFORE_0008 = [
  "0001_init.sql",
  "0002_segments.sql",
  "0003_campaign_var_mapping.sql",
  "0004_source_sync.sql",
  "0005_campaign_body.sql",
  "0006_campaign_tags.sql",
  "0007_campaign_subject.sql",
];

/** A campaign row as the buggy picker left it. */
function insert(
  d1: TestD1,
  name: string,
  sending_domain: string | null,
  from_email: string | null,
) {
  d1.sql(
    "INSERT INTO campaigns (name, sending_domain, from_email, status) VALUES (?,?,?, 'draft')",
    name,
    sending_domain,
    from_email,
  );
}

function domainOf(d1: TestD1, name: string) {
  const row = d1.sql<{ sending_domain: string | null }>(
    "SELECT sending_domain FROM campaigns WHERE name = ?",
    name,
  )[0];
  return row?.sending_domain ?? null;
}

function seeded() {
  const d1 = createTestD1();
  applyMigrations(d1, BEFORE_0008);
  return d1;
}

describe("0008 sending-domain repair", () => {
  it("derives the real domain from the From address", () => {
    const d1 = seeded();
    insert(d1, "ld", "localdentists", "listing@localdentists.au");
    insert(d1, "ds", "dentalscout", "smile@dentalscout.com.au");
    applyMigrations(d1, ["0008_campaign_sending_domain.sql"]);

    expect(domainOf(d1, "ld")).toBe("localdentists.au");
    expect(domainOf(d1, "ds")).toBe("dentalscout.com.au");
    d1.close();
  });

  it("keeps a multi-part TLD whole instead of cutting it to the last label", () => {
    const d1 = seeded();
    insert(d1, "c", "something", "hello@Something.COM.AU.");
    applyMigrations(d1, ["0008_campaign_sending_domain.sql"]);

    expect(domainOf(d1, "c")).toBe("something.com.au");
    d1.close();
  });

  it("leaves rows alone when the From address cannot supply a domain", () => {
    const d1 = seeded();
    insert(d1, "no-from", "localdentists", null);
    insert(d1, "blank-from", "localdentists", "");
    insert(d1, "not-an-address", "localdentists", "not-an-address");
    insert(d1, "dotless-from", "localdentists", "root@localhost");
    applyMigrations(d1, ["0008_campaign_sending_domain.sql"]);

    // Still un-repaired, so they can be listed and fixed by hand rather than
    // being silently guessed at.
    expect(domainOf(d1, "no-from")).toBe("localdentists");
    expect(domainOf(d1, "blank-from")).toBe("localdentists");
    expect(domainOf(d1, "not-an-address")).toBe("localdentists");
    expect(domainOf(d1, "dotless-from")).toBe("localdentists");
    d1.close();
  });

  it("does not touch a value that is already a domain", () => {
    const d1 = seeded();
    insert(d1, "fine", "localdentists.au", "listing@localdentists.au");
    insert(d1, "other", "example.com", "someone@elsewhere.test");
    applyMigrations(d1, ["0008_campaign_sending_domain.sql"]);

    expect(domainOf(d1, "fine")).toBe("localdentists.au");
    expect(domainOf(d1, "other")).toBe("example.com");
    d1.close();
  });

  it("does not touch an empty or absent value", () => {
    const d1 = seeded();
    insert(d1, "null", null, "listing@localdentists.au");
    insert(d1, "empty", "", "listing@localdentists.au");
    applyMigrations(d1, ["0008_campaign_sending_domain.sql"]);

    expect(domainOf(d1, "null")).toBeNull();
    expect(domainOf(d1, "empty")).toBe("");
    d1.close();
  });

  it("changes only the rows it should, and is safe to re-run", () => {
    const d1 = seeded();
    insert(d1, "a", "localdentists", "listing@localdentists.au");
    insert(d1, "b", "dentalscout", "smile@dentalscout.com.au");
    insert(d1, "c", "localdentists", null);
    insert(d1, "d", "localdentists.au", "listing@localdentists.au");

    applyMigrations(d1, ["0008_campaign_sending_domain.sql"]);
    const after = d1.sql<{ name: string; sending_domain: string | null }>(
      "SELECT name, sending_domain FROM campaigns ORDER BY name",
    );
    expect(after).toEqual([
      { name: "a", sending_domain: "localdentists.au" },
      { name: "b", sending_domain: "dentalscout.com.au" },
      { name: "c", sending_domain: "localdentists" },
      { name: "d", sending_domain: "localdentists.au" },
    ]);

    // A second run is a no-op: every remaining row now has a dot or no From.
    applyMigrations(d1, ["0008_campaign_sending_domain.sql"]);
    expect(
      d1.sql<{ name: string; sending_domain: string | null }>(
        "SELECT name, sending_domain FROM campaigns ORDER BY name",
      ),
    ).toEqual(after);
    d1.close();
  });
});
