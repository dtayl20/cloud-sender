/**
 * One-line summaries for the collapsible builder sections.
 *
 * Each collapsed section must keep saying what matters: the spam band and score,
 * the tags that are applied, and how much of the variable mapping is done.
 * Anything needing attention — a caution-band score, an unmapped variable —
 * therefore has to appear in the collapsed line itself, not only inside the body.
 *
 * These are pure string builders so the wording is testable without rendering a
 * component. No React, Worker or DB imports.
 */

import type { SpamCheckResult } from "./spamCheck";
import type { VarMappingSummary } from "./varSources";

/** Where the spam verdict came from: the sample render, or a real test send. */
export type SpamVerdictSource = "sample" | "test";

/** Short label kept next to a verdict so the two sources are never confused. */
export function spamVerdictSourceLabel(source: SpamVerdictSource | null | undefined): string {
  if (source === "test") return "real test send";
  if (source === "sample") return "sample data";
  return "";
}

function bandLabel(band: SpamCheckResult["band"]): string {
  if (band === "good") return "Good";
  if (band === "caution") return "Caution";
  if (band === "likely spam") return "Likely spam";
  return "not fully checked";
}

/**
 * Spam check collapse line: the band and score, or why there is neither. The
 * source tag keeps a sample-data verdict visibly distinct from a real one.
 */
export function spamCollapseSummary(
  result: SpamCheckResult | null | undefined,
  source: SpamVerdictSource | null = null,
): string {
  if (!result) return "not checked";
  if (!result.complete || result.band === null) return "not fully checked";
  const score = result.score === null ? "" : ` (${result.score}/100)`;
  const tag = spamVerdictSourceLabel(source);
  return `${bandLabel(result.band)}${score}${tag ? ` · ${tag}` : ""}`;
}

/** Tags collapse line: the applied tags, or "no tags". */
export function tagsCollapseSummary(tags: readonly string[] | null | undefined): string {
  const list = (tags ?? []).map((t) => String(t ?? "").trim()).filter(Boolean);
  return list.length ? list.join(", ") : "no tags";
}

/**
 * Template-variable collapse line: the mapping state. With anything unmapped the
 * shortfall is shown too, so a variable with no source is impossible to miss
 * while the section is closed.
 */
export function varMappingCollapseSummary(
  summary: VarMappingSummary | null | undefined,
): string {
  if (!summary || summary.total === 0) return "no variables";
  const { mapped, missing } = summary;
  const head = `${mapped} ${mapped === 1 ? "variable" : "variables"} mapped`;
  if (!missing.length) return head;
  const need = missing.length === 1 ? "1 needs a source" : `${missing.length} need a source`;
  return `${head} · ${need}`;
}
