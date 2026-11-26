/**
 * Campaign variable sources — which document a detected {{variable}} came from.
 *
 * A campaign's variables can be declared in two places:
 *
 *   * the template's own markup / subject (e.g.
 *     href="https://…/setup-profile?api_key={{api}}"), and
 *   * the per-campaign body ("campaign content"), which is merged into a base
 *     template before rendering.
 *
 * The editor shows one list of both, so a name that only exists in the
 * template's markup (like `api`) is easy to mistake for something the operator
 * wrote in the campaign. These helpers tag every detected variable with its
 * origin and phrase the mapping shortfall in plain language, so the warning says
 * where to look. Detection itself is upstream (`extractTemplateVars`) — this
 * module only labels what was found; it never changes what counts as a variable.
 *
 * No Worker, React or DB imports here.
 */

/** Where a detected variable appears: the template, the campaign body, or both. */
export type VarOrigin = "template" | "campaign" | "both";

export interface DetectedVar {
  name: string;
  origin: VarOrigin;
}

/** Editor row shape (VarRow satisfies this); only the source decision matters. */
export interface VarSourceRow {
  name?: string | null;
  source?: string | null;
  field?: string | null;
  /** Static literal when source === "static"; not consulted for the count. */
  value?: string | null;
}

export interface VarMappingSummary {
  /** Every detected variable, in display order, each tagged with its origin. */
  detected: DetectedVar[];
  total: number;
  /** Detected variables whose editor row supplies a source. */
  mapped: number;
  /** Detected variables with no source set — the shortfall. */
  missing: DetectedVar[];
}

/**
 * Merge the variables found in the template and in the campaign body into one
 * ordered list, tagging each with its origin.
 *
 * Order is the order the editor has always shown: template variables first, in
 * the order the template reports them, then variables that appear only in the
 * campaign body, in body order. A name found in both is listed once, as "both".
 */
export function detectVarOrigins(
  templateVars: readonly string[] | null | undefined,
  bodyVars: readonly string[] | null | undefined,
): DetectedVar[] {
  const order: string[] = [];
  const origins = new Map<string, VarOrigin>();
  const mark = (name: unknown, origin: "template" | "campaign") => {
    const key = String(name ?? "").trim();
    if (!key) return;
    const prev = origins.get(key);
    if (prev === undefined) {
      order.push(key);
      origins.set(key, origin);
    } else if (prev !== origin && prev !== "both") {
      origins.set(key, "both");
    }
  };
  for (const v of templateVars ?? []) mark(v, "template");
  for (const v of bodyVars ?? []) mark(v, "campaign");
  return order.map((name) => ({ name, origin: origins.get(name) ?? "template" }));
}

/** Short origin tag for the variable list: template / campaign / template + campaign. */
export function originLabel(origin: VarOrigin): string {
  if (origin === "both") return "template + campaign";
  return origin === "campaign" ? "campaign" : "template";
}

/** Where-clause for the shortfall line, e.g. "used in the template". */
export function originWhere(origin: VarOrigin): string {
  if (origin === "both") return "used in the template and the campaign content";
  return origin === "campaign" ? "used in the campaign content" : "used in the template";
}

/**
 * True when an editor row actually supplies something for its variable.
 * A static row is complete on its name alone — a blank literal is intentional,
 * exactly like an unset variable — while a field row needs a contact-field path.
 */
function rowHasSource(row: VarSourceRow | undefined): boolean {
  if (!row) return false;
  return row.source === "static" || !!String(row.field ?? "");
}

/**
 * Split the detected variables into those with a source and those without.
 * Duplicate rows for one name count as sourced if ANY of them supplies one,
 * matching how the save path resolves them.
 */
export function summarizeVarMapping(
  detected: readonly DetectedVar[],
  rows: readonly VarSourceRow[] | null | undefined,
): VarMappingSummary {
  const best = new Map<string, VarSourceRow>();
  for (const row of rows ?? []) {
    const name = String(row?.name ?? "").trim();
    if (!name) continue;
    const current = best.get(name);
    if (!current || (!rowHasSource(current) && rowHasSource(row))) best.set(name, row);
  }
  const missing = detected.filter((v) => !rowHasSource(best.get(v.name)));
  return {
    detected: [...detected],
    total: detected.length,
    mapped: detected.length - missing.length,
    missing,
  };
}

/**
 * The plain-language shortfall line, e.g.
 *   "4 of 5 variables have a source — no source set for: api (used in the template)"
 * With nothing missing it is just the count: "5 of 5 variables have a source".
 */
export function formatVarMappingLine(summary: VarMappingSummary): string {
  const { mapped, total, missing } = summary;
  const noun = total === 1 ? "variable" : "variables";
  const verb = total === 1 ? "has" : "have";
  let line = `${mapped} of ${total} ${noun} ${verb} a source`;
  if (missing.length) {
    const detail = missing.map((v) => `${v.name} (${originWhere(v.origin)})`).join(", ");
    line += ` — no source set for: ${detail}`;
  }
  return line;
}
