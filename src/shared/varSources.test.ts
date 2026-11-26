// Variable origins in the campaign editor: a detected {{variable}} can come from
// the template's own markup, from the campaign body, or from both. These tests
// pin the labelling and the plain-language shortfall, using the real case that
// prompted the change: template `LocalDentists.au - Update your profile` links to
// `…/setup-profile?api_key={{api}}`, so `api` is used by the TEMPLATE only.
//
// Detection itself is not re-tested here — it stays upstream in
// extractTemplateVars(); these helpers must only label what was found, never
// change the list or its order.

import { describe, expect, it } from "vitest";
import {
  detectVarOrigins,
  formatVarMappingLine,
  originLabel,
  originWhere,
  summarizeVarMapping,
  type VarSourceRow,
} from "../shared/varSources";

/** The editor's previous inline merge, kept here as the order these must match. */
function oldMerge(own: string[], body: string[]): string[] {
  return [...own, ...body.filter((v) => !own.includes(v))];
}

describe("detectVarOrigins labels where each variable was found", () => {
  it("tags a variable found only in the template", () => {
    const [detected] = detectVarOrigins(["api"], []);
    expect(detected).toEqual({ name: "api", origin: "template" });
  });

  it("tags a variable found only in the campaign body", () => {
    const [detected] = detectVarOrigins([], ["chip"]);
    expect(detected).toEqual({ name: "chip", origin: "campaign" });
  });

  it("tags a variable found in both as 'both'", () => {
    const [detected] = detectVarOrigins(["first_name"], ["first_name"]);
    expect(detected).toEqual({ name: "first_name", origin: "both" });
  });

  it("keeps the old list and order: template first, then body-only, no duplicates", () => {
    const own = ["first_name", "api"];
    const body = ["first_name", "chip"];

    const detected = detectVarOrigins(own, body);

    expect(detected.map((v) => v.name)).toEqual(oldMerge(own, body));
    expect(detected.map((v) => v.origin)).toEqual(["both", "template", "campaign"]);
  });

  it("ignores blank names and tolerates missing inputs", () => {
    const detected = detectVarOrigins(["api", "  ", ""], [""]);
    expect(detected.map((v) => v.name)).toEqual(["api"]);
    expect(detectVarOrigins(null, undefined)).toEqual([]);
  });
});

describe("origin wording", () => {
  it("gives a short tag for the variable list", () => {
    expect(originLabel("template")).toBe("template");
    expect(originLabel("campaign")).toBe("campaign");
    expect(originLabel("both")).toBe("template + campaign");
  });

  it("gives a where-clause for the shortfall line", () => {
    expect(originWhere("template")).toBe("used in the template");
    expect(originWhere("campaign")).toBe("used in the campaign content");
    expect(originWhere("both")).toBe("used in the template and the campaign content");
  });
});

describe("summarizeVarMapping counts what has a source", () => {
  const detected = detectVarOrigins(["first_name", "api"], ["first_name", "chip"]);

  it("treats a contact-field row as a source", () => {
    const rows: VarSourceRow[] = [{ name: "first_name", source: "field", field: "first_name" }];
    expect(summarizeVarMapping(detected, rows).mapped).toBe(1);
  });

  it("treats a static row as a source even with a blank literal", () => {
    const rows: VarSourceRow[] = [{ name: "chip", source: "static", field: "", value: "" }];
    // `chip` is the only one of the three with a row…
    expect(summarizeVarMapping(detected, rows).mapped).toBe(1);
    // …and a static blank is intentional, not a missing source.
    expect(summarizeVarMapping(detected, rows).missing.map((v) => v.name)).toEqual([
      "first_name",
      "api",
    ]);
  });

  it("does not count a field row with no contact field chosen", () => {
    const rows: VarSourceRow[] = [{ name: "api", source: "field", field: "" }];
    const summary = summarizeVarMapping(detected, rows);
    expect(summary.mapped).toBe(0);
    expect(summary.missing.map((v) => v.name)).toEqual(["first_name", "api", "chip"]);
  });

  it("counts a name once even with duplicate rows", () => {
    const rows: VarSourceRow[] = [
      { name: "api", source: "field", field: "" },
      { name: "api", source: "field", field: "attributes.api_key" },
    ];
    const summary = summarizeVarMapping(detected, rows);
    expect(summary.mapped).toBe(1);
    expect(summary.missing.map((v) => v.name)).toEqual(["first_name", "chip"]);
  });

  it("ignores rows with no name and tolerates a missing row list", () => {
    expect(summarizeVarMapping(detected, [{ name: "  ", source: "field", field: "x" }]).mapped).toBe(0);
    expect(summarizeVarMapping(detected, null).mapped).toBe(0);
    expect(summarizeVarMapping(detected, null).total).toBe(3);
  });
});

describe("formatVarMappingLine says where to look", () => {
  it("names the origin of each unsourced variable (the LocalDentists.au case)", () => {
    const detected = detectVarOrigins(
      ["first_name", "api"],
      ["first_name", "chip", "cta_url"],
    );
    const rows: VarSourceRow[] = [
      { name: "first_name", source: "field", field: "first_name" },
      { name: "chip", source: "static", field: "", value: "Book now" },
      { name: "cta_url", source: "static", field: "", value: "https://x.example" },
    ];

    const summary = summarizeVarMapping(detected, rows);

    expect(summary.total).toBe(4);
    expect(summary.mapped).toBe(3);
    expect(formatVarMappingLine(summary)).toBe(
      "3 of 4 variables have a source — no source set for: api (used in the template)",
    );
  });

  it("distinguishes a campaign-body variable from a template one", () => {
    const detected = detectVarOrigins(["api"], ["chip"]);
    const line = formatVarMappingLine(summarizeVarMapping(detected, []));

    expect(line).toBe(
      "0 of 2 variables have a source — no source set for: api (used in the template), chip (used in the campaign content)",
    );
  });

  it("says so when a variable appears in both", () => {
    const detected = detectVarOrigins(["first_name"], ["first_name"]);
    const line = formatVarMappingLine(summarizeVarMapping(detected, []));

    expect(line).toBe(
      "0 of 1 variable has a source — no source set for: first_name (used in the template and the campaign content)",
    );
  });

  it("drops the shortfall clause when everything has a source", () => {
    const detected = detectVarOrigins(["api"], ["chip"]);
    const rows: VarSourceRow[] = [
      { name: "api", source: "field", field: "attributes.api_key" },
      { name: "chip", source: "static", field: "", value: "Book now" },
    ];

    expect(formatVarMappingLine(summarizeVarMapping(detected, rows))).toBe(
      "2 of 2 variables have a source",
    );
  });
});
