// /api/contacts/fields builds the contact-field picker for campaigns and
// templates. Custom attributes are stored per contact as a JSON blob, so the
// unscoped set is every column anyone ever imported; these checks pin the
// scoping that keeps the picker tied to the audience being addressed.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { applyMigrations, createTestD1 } from "../test/sqlite-d1";
import type { Env } from "./types";
import { contactsRoutes } from "./routes/contacts";

function makeApp() {
  const d1 = createTestD1();
  applyMigrations(d1, ["0001_init.sql", "0002_segments.sql"]);
  const env = { DB: d1 } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/contacts", contactsRoutes);

  const get = async (qs = "") => {
    const res = await app.fetch(new Request(`http://test/api/contacts/fields${qs}`), env);
    expect(res.status).toBe(200);
    return (await res.json()) as any;
  };

  const addContact = (email: string, attributes: Record<string, unknown>) =>
    d1.sql<{ id: number }>(
      "INSERT INTO contacts (email, attributes) VALUES (?, ?) RETURNING id",
      email,
      JSON.stringify(attributes),
    )[0].id;

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

const paths = (payload: any) => (payload.attributes as any[]).map((a) => a.path);

describe("contact fields picker", () => {
  it("without an audience, offers every attribute key (the old behaviour)", async () => {
    const { get, addContact } = makeApp();
    addContact("a@example.com", { plan_type: "gold" });
    addContact("b@example.com", { other_field: "x" });

    const payload = await get();
    expect(payload.scope).toBe("global");
    expect(payload.attributes.map((a: any) => a.path)).toEqual([
      "attributes.other_field",
      "attributes.plan_type",
    ]);
  });

  it("scoped to a static list, offers only that list's import columns", async () => {
    const { get, addContact, addList, addMember } = makeApp();
    const list = addList("Dentists — QLD");
    const inList = addContact("a@example.com", { plan_type: "gold", practice_size: "3" });
    addMember(list, inList);
    // Same database, another import entirely — must not leak into the picker.
    addContact("b@example.com", { unrelated_column: "x" });

    const payload = await get(`?list_id=${list}`);
    expect(payload.scope).toBe("list");
    expect(payload.scope_label).toBe("Dentists — QLD");
    expect(paths(payload).sort()).toEqual(["attributes.plan_type", "attributes.practice_size"]);
    expect(payload.scope_warning).toBeNull();
  });

  it("scoped to a segment, offers only the columns on matching contacts", async () => {
    const { get, addContact, addList } = makeApp();
    const segment = addList("Gold plans", "segment", {
      rules: [{ source: "attribute", field: "plan", op: "eq", value: "gold" }],
    });
    addContact("gold@example.com", { plan: "gold", gold_only: "1" });
    addContact("silver@example.com", { plan: "silver", silver_only: "1" });

    const payload = await get(`?segment_id=${segment}`);
    expect(payload.scope).toBe("segment");
    expect(paths(payload).sort()).toEqual(["attributes.gold_only", "attributes.plan"]);
  });

  it("orders fields by coverage, so what most of the audience has comes first", async () => {
    const { get, addContact, addList, addMember } = makeApp();
    const list = addList("Mixed");
    addMember(list, addContact("a@example.com", { common: "1", rare: "1" }));
    addMember(list, addContact("b@example.com", { common: "1" }));

    const payload = await get(`?list_id=${list}`);
    expect(paths(payload)).toEqual(["attributes.common", "attributes.rare"]);
  });

  it("falls back to all contacts when the audience no longer exists", async () => {
    const { get, addContact } = makeApp();
    addContact("a@example.com", { any_field: "1" });

    const payload = await get("?list_id=999");
    expect(payload.scope).toBe("global");
    expect(payload.scope_warning).toContain("not found");
    expect(paths(payload)).toEqual(["attributes.any_field"]);
  });
});
