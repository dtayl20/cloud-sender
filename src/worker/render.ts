import Mustache from "mustache";
import type { ContactRow } from "./types";
import { htmlToText, mergeBody } from "../shared/body";
import { renderRaw } from "../shared/rawRender";
import {
  type MappingEntry,
  type VarMapping,
  entryField,
  findUrlContextVars,
  hasHybridPlaceholder,
  hasStaticValue,
  interpolateStaticValue,
  isUrlShapedStaticValue,
  parseVarMapping,
  sanitizeStaticValue,
} from "../shared/varMapping";

// Re-exported so the send path and the editor share one definition of the
// mapping shape.
export type { MappingEntry, VarMapping } from "../shared/varMapping";
export { sanitizeStaticValue } from "../shared/varMapping";

// Re-exported so every send path resolves the subject through one function
// (and one set of header-safety rules). See src/shared/subject.ts.
export {
  MAX_SUBJECT_LENGTH,
  clampSubject,
  renderSubject,
  sanitizeSubject,
  subjectSource,
  subjectTooLong,
} from "../shared/subject";

// Re-exported so the send path has one entry point for the base-template +
// campaign-body rules (shared/body.ts is the single implementation).
export {
  CONTENT_SLOT,
  acceptsCampaignBody,
  hasContentSlot,
  isBaseTemplate,
  mergeBody,
  plainTextToHtml,
} from "../shared/body";

// Re-exported so the send path has one entry point for the non-escaping text
// render (shared/rawRender.ts is the single implementation).
export { renderRaw, RAW_MUSTACHE } from "../shared/rawRender";

export function contactAttrs(c: ContactRow): Record<string, unknown> {
  try {
    return JSON.parse(c.attributes || "{}");
  } catch {
    return {};
  }
}

export function contactVars(c: ContactRow): Record<string, unknown> {
  return {
    email: c.email,
    first_name: c.first_name ?? "",
    last_name: c.last_name ?? "",
    practice_name: c.practice_name ?? "",
    ...contactAttrs(c),
  };
}

/**
 * Resolve a dotted path like "first_name" or "attributes.promo_code"
 * against a contact row.
 */
export function resolveContactPath(c: ContactRow, path: string): unknown {
  if (!path) return "";
  const parts = path.split(".");
  const head = parts[0];
  if (head === "attributes") {
    const attrs = contactAttrs(c);
    let cur: any = attrs;
    for (const p of parts.slice(1)) {
      if (cur == null) return "";
      cur = cur[p];
    }
    return cur ?? "";
  }
  const v = (c as any)[head];
  return v ?? "";
}

/**
 * Resolve one var_mapping entry against a contact.
 *
 *   "first_name"                  -> contact field path (the original format)
 *   { field: "first_name" }       -> contact field path
 *   { value: "Book now" }         -> static literal
 *   { field: "x", value: "y" }    -> BOTH: the static value wins
 *   { value: "https://x/?k={{attributes.api_key}}" } -> hybrid (see below)
 *
 * Static values are the only operator-typed literals in the pipeline, so they
 * pass through sanitizeStaticValue first: a value that looks like an absolute
 * URI is dropped unless its scheme is http/https/mailto, which keeps a
 * javascript:/data: URL from ever reaching an href.
 *
 * A HYBRID value carries {{contact.field}} placeholders. Those resolve per
 * recipient against contact fields only — never against another variable's
 * value — so there is no recursion, and the scheme rule runs AFTER
 * interpolation so a placeholder cannot smuggle a scheme in.
 *
 * `urlContext` says the value lands in an href (the send path derives it from
 * the template; see urlContextVars). There the substituted parts are
 * URL-encoded and an unresolved placeholder fails the whole value safe (""),
 * so a half-built URL is never emitted. A value that is itself an absolute URL
 * is treated as a link even without template HTML (an SMTP2GO template renders
 * its own body), so the same encoding applies.
 */
export function resolveMappingEntry(
  c: ContactRow | null,
  entry: MappingEntry,
  urlContext = false,
): unknown {
  if (entry == null) return "";
  if (typeof entry === "string") return c ? resolveContactPath(c, entry) : "";
  if (hasStaticValue(entry)) {
    const literal = String(entry.value ?? "");
    // A value with no placeholder keeps the original pure-literal path.
    if (!hasHybridPlaceholder(literal)) return sanitizeStaticValue(literal);
    const asUrl = urlContext || isUrlShapedStaticValue(literal);
    const resolved = interpolateStaticValue(
      literal,
      (path) => (c ? resolveContactPath(c, path) : ""),
      { urlContext: asUrl },
    );
    // Scheme rule AFTER interpolation: a scheme introduced by a placeholder is
    // neutralised exactly like one typed into the literal.
    return sanitizeStaticValue(resolved);
  }
  const field = entryField(entry);
  return field && c ? resolveContactPath(c, field) : "";
}

/**
 * Build template_data for SMTP2GO based on the campaign's var_mapping.
 * If no mapping is provided, falls back to the legacy full-contact dump
 * so older campaigns keep working.
 *
 * `urlVars` (see urlContextVars) names the variables the template uses inside
 * an href; only those get URL-context interpolation, so a hybrid value that is
 * plain text is never URL-encoded.
 */
export function mappedVars(
  c: ContactRow | null,
  mapping: VarMapping | null | undefined,
  fallbackEmail?: string,
  urlVars?: Set<string> | null,
): Record<string, unknown> {
  if (!mapping || Object.keys(mapping).length === 0) {
    return c ? contactVars(c) : { email: fallbackEmail ?? "" };
  }
  const out: Record<string, unknown> = {};
  for (const [varName, entry] of Object.entries(mapping)) {
    out[varName] = resolveMappingEntry(c, entry, !!urlVars?.has(varName));
  }
  // Always make {{email}} available for convenience.
  if (!("email" in out)) out.email = c?.email ?? fallbackEmail ?? "";
  return out;
}

/**
 * Which variables a render uses inside an href: the template HTML plus the
 * per-campaign body (the body is merged at {{content}} before the Mustache
 * pass, so it can add links of its own).
 */
export function urlContextVars(
  templateHtml: string | null | undefined,
  bodyHtml?: string | null,
): Set<string> {
  return findUrlContextVars(mergeBody(templateHtml ?? "", bodyHtml ?? null));
}

export function parseMapping(raw: string | null | undefined): VarMapping | null {
  return parseVarMapping(raw);
}

export function render(template: string, vars: Record<string, unknown>): string {
  // Mustache escapes HTML by default; use {{{var}}} to inject raw.
  return Mustache.render(template, vars);
}

/**
 * Render a text/plain document: {{variables}} are substituted RAW.
 *
 * Plain text has no markup context, so the HTML escaping the HTML path wants
 * would corrupt every substituted value — most visibly a URL from a variable,
 * which arrives with `&#x2F;`/`&#x3D;` instead of `/`/`=`, and a `&` in a
 * practice name, which arrives as `&amp;`. There is nothing to escape FROM in
 * text, so the value goes in as-is (never decoded afterwards, so a value that
 * looks like an entity is not re-interpreted).
 */
export function renderText(template: string, vars: Record<string, unknown>): string {
  return renderRaw(template, vars);
}

/**
 * Render one body part of a campaign.
 *
 * Order matters: a campaign body (campaigns.body_html) is merged into the
 * template at {{content}} FIRST, then the existing Mustache pass runs over the
 * merged document, so {{variables}} resolve inside the body exactly like they
 * do in the template. No body (null/undefined) leaves the template untouched.
 */
export function renderBody(
  template: string | null | undefined,
  vars: Record<string, unknown>,
  bodyHtml?: string | null,
): string {
  return render(mergeBody(template ?? "", bodyHtml ?? null), vars);
}

/**
 * The text/plain half of a base template gets the campaign body reduced to
 * plain text. Returns null when there is no campaign body so the template is
 * left alone.
 */
export function bodyPlainText(bodyHtml: string | null | undefined): string | null {
  return bodyHtml == null ? null : htmlToText(bodyHtml);
}

/**
 * Render the text/plain body of a campaign: the campaign body is merged into
 * the template at {{content}} FIRST (same order as renderBody), then the
 * Mustache pass runs with RAW substitution — this is the text twin of
 * renderBody and must be used for text_body everywhere renderBody is used for
 * html_body.
 */
export function renderTextBody(
  template: string | null | undefined,
  vars: Record<string, unknown>,
  bodyText?: string | null,
): string {
  return renderText(mergeBody(template ?? "", bodyText ?? null), vars);
}
