// Collapsed-section summary lines.
//
// The rule these pin: anything needing attention is visible while the section is
// CLOSED — a caution-band score and an unmapped variable above all — because a
// summary that hides the warning is worse than no summary.

import { describe, expect, it } from "vitest";
import {
  spamCollapseSummary,
  spamVerdictSourceLabel,
  tagsCollapseSummary,
  varMappingCollapseSummary,
} from "./collapseSummaries";
import type { SpamCheckResult } from "./spamCheck";
import type { VarMappingSummary } from "./varSources";

function spam(patch: Partial<SpamCheckResult>): SpamCheckResult {
  return {
    score: 100,
    band: "good",
    findings: [],
    penalty: 0,
    checked: ["subject", "body", "structure"],
    skipped: [],
    complete: true,
    ...patch,
  };
}

describe("spamCollapseSummary", () => {
  it("is quiet before anything has been checked", () => {
    expect(spamCollapseSummary(null)).toBe("not checked");
  });

  it("shows band and score", () => {
    expect(spamCollapseSummary(spam({ score: 96, band: "good" }))).toBe("Good (96/100)");
  });

  it("shows a caution band (the one that needs attention)", () => {
    expect(spamCollapseSummary(spam({ score: 72, band: "caution" }))).toBe("Caution (72/100)");
  });

  it("shows a likely-spam band", () => {
    expect(spamCollapseSummary(spam({ score: 40, band: "likely spam" }))).toBe("Likely spam (40/100)");
  });

  it("says so when the campaign could not be fully checked", () => {
    expect(spamCollapseSummary(spam({ score: null, band: null, complete: false, skipped: ["x"] }))).toBe(
      "not fully checked",
    );
  });

  it("tags the verdict with where it came from, so sample and real stay distinct", () => {
    expect(spamCollapseSummary(spam({ score: 96 }), "sample")).toBe("Good (96/100) · sample data");
    expect(spamCollapseSummary(spam({ score: 96 }), "test")).toBe("Good (96/100) · real test send");
  });
});

describe("spamVerdictSourceLabel", () => {
  it("labels the two sources apart and is blank when unknown", () => {
    expect(spamVerdictSourceLabel("sample")).toBe("sample data");
    expect(spamVerdictSourceLabel("test")).toBe("real test send");
    expect(spamVerdictSourceLabel(null)).toBe("");
  });
});

describe("tagsCollapseSummary", () => {
  it("says no tags when none are applied", () => {
    expect(tagsCollapseSummary([])).toBe("no tags");
    expect(tagsCollapseSummary(null)).toBe("no tags");
  });

  it("lists the tags currently applied", () => {
    expect(tagsCollapseSummary(["melbourne", "ortho"])).toBe("melbourne, ortho");
  });

  it("ignores blanks", () => {
    expect(tagsCollapseSummary(["  ", ""])).toBe("no tags");
  });
});

describe("varMappingCollapseSummary", () => {
  function summary(patch: Partial<VarMappingSummary>): VarMappingSummary {
    return { detected: [], total: 0, mapped: 0, missing: [], ...patch };
  }

  it("says no variables when the template declares none", () => {
    expect(varMappingCollapseSummary(summary({}))).toBe("no variables");
    expect(varMappingCollapseSummary(null)).toBe("no variables");
  });

  it("counts the variables that are mapped", () => {
    expect(varMappingCollapseSummary(summary({ total: 6, mapped: 6 }))).toBe("6 variables mapped");
    expect(varMappingCollapseSummary(summary({ total: 1, mapped: 1 }))).toBe("1 variable mapped");
  });

  it("surfaces an unmapped variable while collapsed (the one that needs attention)", () => {
    const s = summary({ total: 6, mapped: 5, missing: [{ name: "api", origin: "template" }] });
    expect(varMappingCollapseSummary(s)).toBe("5 variables mapped · 1 needs a source");
  });

  it("uses the plural when several need a source", () => {
    const s = summary({
      total: 4,
      mapped: 2,
      missing: [
        { name: "api", origin: "template" },
        { name: "chip", origin: "campaign" },
      ],
    });
    expect(varMappingCollapseSummary(s)).toBe("2 variables mapped · 2 need a source");
  });
});
