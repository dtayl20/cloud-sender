/**
 * Sample values for the campaign editor.
 *
 * The pre-send spam check and the preview must be able to judge a COMPLETE
 * email, but a contact field has no recipient at check time. Refusing to score
 * (or silently scoring a half-built email that still reads `Hello {{first_name}}`)
 * both lie about the campaign, so instead the editor renders against
 * deterministic SAMPLES:
 *
 *   * a STATIC value is used exactly as typed (after the same href-scheme guard
 *     the send path applies — an ordinary literal comes back unchanged);
 *   * a HYBRID value has each {{contact.field}} placeholder interpolated from
 *     the samples, so `https://x/?key={{attributes.api_key}}` renders whole;
 *   * a CONTACT FIELD resolves to a typed sample — the small map of common
 *     fields first, then a shape-appropriate default chosen from the field name.
 *
 * Nothing here ever reads a contact row. There is no recipient at check time,
 * and real recipient data must never enter a pre-send check; the samples are
 * invented constants. Every sample is deterministic (no Date, no random) so the
 * score does not jitter between runs.
 *
 * A field whose sample cannot be produced (a blank/unset field path) is reported
 * in `unresolved` by name, so the caller can say what it could not judge instead
 * of scoring clean over a variable that was never resolved.
 *
 * No React, Worker or DB imports — the editor and its tests share this module.
 */

import {
  hasHybridPlaceholder,
  interpolateStaticValue,
  sanitizeStaticValue,
  toVarRow,
  type MappingEntry,
  type VarMapping,
  type VarRow,
} from "./varMapping";

/**
 * Length of a hex-id placeholder. The real value's length is unknowable without
 * reading a contact, so a realistic canonical length is used and the placeholder
 * is padded to exactly that many hex characters — the point is that a URL or a
 * column built from it has a realistic shape, and that it is the SAME length on
 * every run.
 */
export const HEX_ID_LENGTH = 32;

/** The fixed date a date-shaped field resolves to (deterministic, never "today"). */
export const SAMPLE_DATE = "2026-01-15";
/** The fixed date-time a time/`_at`-shaped field resolves to. */
export const SAMPLE_DATETIME = "2026-01-15 09:30";

/** A plausible Australian mobile number, for phone-shaped fields. */
export const SAMPLE_PHONE = "0412 345 678";

/**
 * The small map of common fields, keyed by the NORMALISED last path segment
 * (lowercased, non-alphanumerics removed): `business_name` -> `businessname`,
 * `attributes.api_key` -> `apikey`.
 */
const COMMON_SAMPLES: Record<string, string> = {
  firstname: "Alex",
  givenname: "Alex",
  lastname: "Nguyen",
  surname: "Nguyen",
  familyname: "Nguyen",
  fullname: "Alex Nguyen",
  name: "Alex Nguyen",
  businessname: "Sample Dental Care",
  practicename: "Sample Dental Care",
  clinicname: "Sample Dental Care",
  company: "Sample Dental Care",
  companyname: "Sample Dental Care",
  organisation: "Sample Dental Care",
  organization: "Sample Dental Care",
  clinic: "Sample Dental Care",
  email: "sample@example.com",
  emailaddress: "sample@example.com",
  phone: SAMPLE_PHONE,
  phonenumber: SAMPLE_PHONE,
  mobile: SAMPLE_PHONE,
  mobilenumber: SAMPLE_PHONE,
  telephone: SAMPLE_PHONE,
  contactnumber: SAMPLE_PHONE,
  address: "1 Sample Street",
  street: "1 Sample Street",
  streetaddress: "1 Sample Street",
  addressline1: "1 Sample Street",
  suburb: "Sampletown",
  city: "Sampletown",
  town: "Sampletown",
  state: "NSW",
  postcode: "2000",
  zip: "2000",
  country: "Australia",
  website: "https://example.com",
  websiteurl: "https://example.com",
};

/** Last path segment, lowercased, with non-alphanumerics stripped. */
function normField(path: string): string {
  const last = String(path ?? "").split(".").pop() ?? "";
  return last.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Deterministic 32-bit FNV-1a — the only source of "variety" in the samples. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A deterministic, same-length lowercase-hex placeholder derived from the name. */
function hexPlaceholder(seed: string, length = HEX_ID_LENGTH): string {
  let out = "";
  let block = fnv1a(seed);
  while (out.length < length) {
    out += block.toString(16).padStart(8, "0");
    block = fnv1a(`${seed}:${out}`);
  }
  return out.slice(0, length);
}

/** A deterministic small integer, as a string. */
function numberPlaceholder(seed: string): string {
  return String(100 + (fnv1a(seed) % 900));
}

/** "promo_code" -> "promo-code" (used inside a sample URL). */
function slug(path: string): string {
  const last = String(path ?? "").split(".").pop() ?? "";
  const s = last
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "sample";
}

/** "promo_code" -> "Promo Code" (used in the readable fallback). */
function humanize(path: string): string {
  const last = String(path ?? "").split(".").pop() ?? "";
  return last
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Names that should read as an opaque hex id (api_key is the motivating case). */
function looksHexId(norm: string): boolean {
  return (
    norm === "id" ||
    /(?:apikey|key|token|secret|hash|uuid|guid)$/.test(norm)
  );
}

/**
 * A deterministic sample for one contact-field path, or null when none can be
 * produced (a blank path). The common map wins first; then a shape-appropriate
 * default is chosen from the field's name; anything unrecognised still gets a
 * readable `Sample <Field Name>` placeholder rather than one generic string, so
 * a custom column does not block the check.
 */
export function sampleFieldValue(path: string): string | null {
  const raw = String(path ?? "").trim();
  if (!raw) return null;
  const n = normField(raw);
  if (!n) return null;

  const common = COMMON_SAMPLES[n];
  if (common) return common;

  // Order matters: mail before URL (an "email_link" is an address, not a URL),
  // and hex ids before the numeric default.
  if (/(?:email|mail)/.test(n)) return "sample@example.com";
  if (looksHexId(n)) return hexPlaceholder(raw);
  if (/(?:url|link|website|site|href|homepage)/.test(n)) return `https://example.com/${slug(raw)}`;
  if (/(?:count|number|num|qty|quantity|amount|total|age|size|rating|score)/.test(n)) {
    return numberPlaceholder(raw);
  }
  // Date/time shapes look at the RAW path too: normalising "created_at" drops the
  // underscore it is recognised by.
  const rawLower = raw.toLowerCase();
  if (
    /(?:date|dob|birth|created|updated|expires|timestamp|time)$/.test(n) ||
    /[._-](?:at|date|dob|time|timestamp)$/.test(rawLower)
  ) {
    const timeish =
      /(?:time|timestamp)$/.test(n) || /[._-](?:at|time|timestamp)$/.test(rawLower);
    return timeish ? SAMPLE_DATETIME : SAMPLE_DATE;
  }

  const human = humanize(raw);
  return human ? `Sample ${human}` : "Sample value";
}

/** Editor row -> its sample value, or null when it cannot be resolved. */
function sampleForRow(row: VarRow): string | null {
  if (row.source === "static") {
    const literal = String(row.value ?? "");
    if (!hasHybridPlaceholder(literal)) return sanitizeStaticValue(literal);
    let missing = false;
    const out = interpolateStaticValue(literal, (path) => {
      const s = sampleFieldValue(path);
      if (s == null) {
        missing = true;
        return "";
      }
      return s;
    });
    // A hybrid with a placeholder we cannot sample is NOT half-rendered: the
    // whole value is reported unresolved so the caller can name it.
    if (missing) return null;
    return sanitizeStaticValue(out);
  }
  return sampleFieldValue(String(row.field ?? ""));
}

/** Sample values for the mapping, plus the names that could not be resolved. */
export interface SampleResolution {
  /** variable name -> sample value, for every variable that resolved. */
  values: Record<string, string>;
  /** variable names with no resolvable source (an unmapped contact field). */
  unresolved: string[];
}

/**
 * Resolve editor rows to sample values.
 *
 * Duplicate rows for one name are tolerated: a name counts as resolved when any
 * of its rows supplies a value (matching how the save path resolves them), and
 * only a name with NO resolvable row is reported unresolved.
 */
export function resolveSampleVars(
  rows: readonly VarRow[] | null | undefined,
): SampleResolution {
  const resolved = new Map<string, string>();
  const unresolved = new Set<string>();

  for (const row of rows ?? []) {
    const name = String(row?.name ?? "").trim();
    if (!name) continue;
    const value = sampleForRow(row);
    if (value !== null) {
      if (!resolved.has(name)) resolved.set(name, value);
      unresolved.delete(name);
    } else if (!resolved.has(name)) {
      unresolved.add(name);
    }
  }

  const values: Record<string, string> = {};
  for (const [name, value] of resolved) values[name] = value;
  return { values, unresolved: [...unresolved] };
}

/**
 * Sample values for a stored campaign `var_mapping` (campaigns.var_mapping).
 *
 * The mapping is read through `toVarRow` — the same loader the campaign editor
 * uses — so the editor's samples and a test send's fallback samples cannot
 * drift apart: there is one placeholder system, not two.
 */
export function sampleVarsForMapping(
  mapping: VarMapping | null | undefined,
): SampleResolution {
  if (!mapping) return { values: {}, unresolved: [] };
  const rows: VarRow[] = Object.entries(mapping).map(([name, entry]) =>
    toVarRow(name, entry as MappingEntry),
  );
  return resolveSampleVars(rows);
}

/**
 * The variables a legacy (unmapped) contact render exposes, resolved from the
 * samples. A test send with no mapping AND no contact used to fall back to a
 * hardcoded "Test User"/"Test Practice"; these are the shared samples instead,
 * so a preview and a test send show the same shapes the editor does.
 */
export function sampleContactVars(email: string): Record<string, string> {
  return {
    email,
    first_name: sampleFieldValue("first_name") ?? "",
    last_name: sampleFieldValue("last_name") ?? "",
    practice_name: sampleFieldValue("practice_name") ?? "",
  };
}
