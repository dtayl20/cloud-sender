// Sample values for the campaign editor.
//
// The contract being pinned here:
//   * the common map returns the agreed samples;
//   * a hex id is the SAME length every time (so a URL built from it has a
//     realistic shape) and looks like hex;
//   * a field is classified by its name (URL vs email vs number vs date)
//     instead of everything collapsing to one generic string;
//   * statics are used verbatim, hybrids are interpolated, and an unmapped field
//     is NAMED as unresolved rather than quietly resolving to empty;
//   * the whole thing is deterministic — the score must not jitter between runs.

import { describe, expect, it } from "vitest";
import {
  HEX_ID_LENGTH,
  SAMPLE_DATE,
  SAMPLE_DATETIME,
  SAMPLE_PHONE,
  resolveSampleVars,
  sampleFieldValue,
} from "./sampleValues";
import type { VarRow } from "./varMapping";

const HEX_RE = /^[0-9a-f]+$/;

/** A field row with sensible defaults. */
function row(partial: Partial<VarRow>): VarRow {
  return { name: "", source: "field", field: "", value: "", ...partial };
}

describe("the common field map", () => {
  it("returns the agreed sample for the common clinic fields", () => {
    expect(sampleFieldValue("business_name")).toBe("Sample Dental Care");
    expect(sampleFieldValue("practice_name")).toBe("Sample Dental Care");
    expect(sampleFieldValue("first_name")).toBe("Alex");
    expect(sampleFieldValue("email")).toBe("sample@example.com");
  });

  it("resolves the map through a dotted attributes path", () => {
    expect(sampleFieldValue("attributes.business_name")).toBe("Sample Dental Care");
  });

  it("gives a plausible Australian phone number", () => {
    expect(sampleFieldValue("phone")).toBe(SAMPLE_PHONE);
    expect(sampleFieldValue("phone")).toMatch(/^04\d{2} \d{3} \d{3}$/);
  });
});

describe("hex ids are same-length and deterministic", () => {
  it("renders api_key as a same-length hex placeholder", () => {
    const v = sampleFieldValue("api_key");
    expect(v).not.toBeNull();
    expect(v).toMatch(HEX_RE);
    expect(v).toHaveLength(HEX_ID_LENGTH);
  });

  it("treats an attributes.api_key path the same way", () => {
    const v = sampleFieldValue("attributes.api_key");
    expect(v).toMatch(HEX_RE);
    expect(v).toHaveLength(HEX_ID_LENGTH);
  });

  it("is stable across calls", () => {
    expect(sampleFieldValue("api_key")).toBe(sampleFieldValue("api_key"));
  });
});

describe("shape defaults chosen from the field name", () => {
  it("makes URL-shaped fields example.com URLs", () => {
    expect(sampleFieldValue("booking_url")).toBe("https://example.com/booking-url");
    expect(sampleFieldValue("profile_link")).toBe("https://example.com/profile-link");
  });

  it("makes email-shaped fields the sample address", () => {
    expect(sampleFieldValue("billing_email")).toBe("sample@example.com");
  });

  it("makes number-shaped fields a number", () => {
    expect(sampleFieldValue("patient_count")).toMatch(/^\d+$/);
  });

  it("makes date-shaped fields a fixed date, and time-shaped ones a fixed date-time", () => {
    expect(sampleFieldValue("renewal_date")).toBe(SAMPLE_DATE);
    expect(sampleFieldValue("created_at")).toBe(SAMPLE_DATETIME);
  });

  it("falls back to a readable placeholder, not one generic string", () => {
    expect(sampleFieldValue("promo_code")).toBe("Sample Promo Code");
    expect(sampleFieldValue("other_code")).toBe("Sample Other Code");
  });

  it("returns null only for a blank path", () => {
    expect(sampleFieldValue("")).toBeNull();
    expect(sampleFieldValue("   ")).toBeNull();
  });
});

describe("resolveSampleVars", () => {
  it("uses a static value exactly as typed", () => {
    const r = resolveSampleVars([row({ name: "button_label", source: "static", value: "Book now" })]);
    expect(r.values.button_label).toBe("Book now");
    expect(r.unresolved).toEqual([]);
  });

  it("interpolates a hybrid value from the samples", () => {
    const r = resolveSampleVars([
      row({
        name: "profile_url",
        source: "static",
        value: "https://x.test/p?key={{attributes.api_key}}",
      }),
    ]);
    expect(r.values.profile_url).toMatch(/^https:\/\/x\.test\/p\?key=[0-9a-f]{32}$/);
    expect(r.values.profile_url).not.toContain("{{");
  });

  it("resolves a contact field through the sample map", () => {
    const r = resolveSampleVars([row({ name: "first_name", source: "field", field: "first_name" })]);
    expect(r.values.first_name).toBe("Alex");
    expect(r.unresolved).toEqual([]);
  });

  it("names an unmapped field instead of resolving it to empty", () => {
    const r = resolveSampleVars([row({ name: "clinic", source: "field", field: "" })]);
    expect(r.values.clinic).toBeUndefined();
    expect(r.unresolved).toEqual(["clinic"]);
  });

  it("is deterministic", () => {
    const rows = [
      row({ name: "api_key", source: "field", field: "attributes.api_key" }),
      row({ name: "button_label", source: "static", value: "Go" }),
    ];
    expect(resolveSampleVars(rows)).toEqual(resolveSampleVars(rows));
  });

  it("ignores unnamed rows and tolerates missing input", () => {
    expect(resolveSampleVars([row({ name: "  ", source: "field", field: "email" })]).values).toEqual({});
    expect(resolveSampleVars(null)).toEqual({ values: {}, unresolved: [] });
    expect(resolveSampleVars(undefined)).toEqual({ values: {}, unresolved: [] });
  });

  it("treats a name as resolved when any of its rows resolves", () => {
    const r = resolveSampleVars([
      row({ name: "x", source: "field", field: "" }),
      row({ name: "x", source: "static", value: "ok" }),
    ]);
    expect(r.values.x).toBe("ok");
    expect(r.unresolved).toEqual([]);
  });
});
