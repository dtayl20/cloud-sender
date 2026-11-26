// CSV export of a list or segment. The sheet is a record dump, so it carries
// every member (any status) plus the verification columns an audit needs, while
// keeping per-clinic credentials out of the file.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { applyMigrations, createTestD1 } from "../test/sqlite-d1";
import type { Env } from "./types";
import { listsRoutes } from "./routes/lists";

function makeApp() {
  const d1 = createTestD1();
  applyMigrations(d1, ["0001_init.sql", "0002_segments.sql", "0016_email_verification.sql"]);
  const env = { DB: d1 } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/lists", listsRoutes);

  const get = (id: number) => app.fetch(new Request(`http://test/api/lists/${id}/export`), env);

  const addContact = (email: string, attributes: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const cols = ["email", "attributes", ...Object.keys(extra)];
    const vals = [email, JSON.stringify(attributes), ...Object.values(extra)];
    return d1.sql<{ id: number }>(
      `INSERT INTO contacts (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) RETURNING id`,
      ...vals,
    )[0].id;
  };

  const addList = (name: string, kind: "static" | "segment" = "static", filter?: unknown) =>
    d1.sql<{ id: number }>(
      "INSERT INTO lists (name, kind, filter_json) VALUES (?, ?, ?) RETURNING id",
      name,
      kind,
      filter ? JSON.stringify(filter) : null,
    )[0].id;

  const addMember = (listId: number, contactId: number) =>
    d1.sql("INSERT INTO list_members (list_id, contact_id) VALUES (?, ?)", listId, contactId);

  return { d1, get, addContact, addList, addMember };
}

async function csv(res: Response) {
  const text = await res.text();
  return { text: text.replace(/^\uFEFF/, ""), lines: text.replace(/^\uFEFF/, "").trimEnd().split("\r\n") };
}

describe("list CSV export", () => {
  it("writes the verification columns and every attribute, quoting safely", async () => {
    const { get, addContact, addList, addMember } = makeApp();
    const list = addList("Dentists — QLD");
    addMember(
      list,
      addContact("clinic@example.com", {
        state: "VIC",
        services: ["implants", "whitening"],
        api_key: "***",
        verification_token: "secret-token",
      }, {
        practice_name: 'Smith, Jones "Dental"',
        first_name: "Ann",
        email_status: "valid",
        email_verified_at: 1767323045,
      }),
    );

    const res = await get(list);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("dentists-qld-");

    const { text, lines } = await csv(res);
    expect(lines[0]).toBe(
      "email,practice_name,first_name,last_name,email_status,email_verified_at,services,state,status,source,source_table,created_at",
    );
    expect(text).toContain("clinic@example.com");
    expect(text).toContain("valid");
    // Quotes are doubled and the whole cell quoted when it holds a comma/quote.
    expect(text).toContain('"Smith, Jones ""Dental"""');
    // Arrays become JSON so the cell stays readable, and stay quoted (commas).
    expect(text).toContain('"[""implants"",""whitening""]"');
    // Credentials never make it into the file.
    expect(text).not.toContain("secret-key");
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("api_key");
    expect(text).not.toContain("verification_token");
  });

  it("includes verification columns even when the contacts have no such data", async () => {
    const { get, addContact, addList, addMember } = makeApp();
    const list = addList("Imported");
    addMember(list, addContact("plain@example.com", { state: "NSW" }));

    const { lines } = await csv(await get(list));
    expect(lines[0]).toContain("email_status,email_verified_at");
  });

  it("exports every member regardless of status — this is a record dump, not a send", async () => {
    const { get, addContact, addList, addMember } = makeApp();
    const list = addList("Mixed");
    addMember(list, addContact("active@example.com", {}, { status: "active" }));
    addMember(list, addContact("gone@example.com", {}, { status: "unsubscribed" }));

    const { text } = await csv(await get(list));
    expect(text).toContain("active@example.com");
    expect(text).toContain("gone@example.com");
  });

  it("resolves a segment's rules to the matching contacts", async () => {
    const { get, addContact, addList } = makeApp();
    const segment = addList("Verified only", "segment", {
      rules: [{ source: "contact", field: "email", op: "contains", value: "yes@" }],
    });
    addContact("yes@example.com", {});
    addContact("no@example.com", {});

    const { text } = await csv(await get(segment));
    expect(text).toContain("yes@example.com");
    expect(text).not.toContain("no@example.com");
  });

  it("404s for a list that does not exist", async () => {
    const { get } = makeApp();
    const res = await get(999);
    expect(res.status).toBe(404);
  });
});
