/**
 * Campaign variable mapping — shared by the Worker send path (src/worker/render.ts)
 * and the campaign editor (src/web/pages/CampaignEdit.tsx) so both sides agree on
 * what a mapping entry means. No Worker, React or DB imports here.
 *
 * Storage shape (campaigns.var_mapping, a JSON object):
 *
 *   {
 *     "fname":        "first_name",                  // legacy: contact field path
 *     "promo":        "attributes.promo_code",
 *     "button_label": { "value": "Book now" },       // static literal
 *     "button_url":   { "value": "https://…" },
 *     "greeting":     { "field": "first_name", "value": "Hi" }
 *   }
 *
 * A string entry keeps working exactly as before, so existing campaigns render
 * byte-identically and no migration is needed. The object form carries a static
 * `value`, a contact `field`, or both — when both are present the STATIC VALUE
 * WINS (see resolveMappingEntry in src/worker/render.ts).
 */

export interface MappingEntryObject {
  field?: string | null;
  value?: string | null;
}

export type MappingEntry = string | MappingEntryObject | null | undefined;

export type VarMapping = Record<string, MappingEntry>;

/** Schemes a static value may use when it ends up in an href. */
export const SAFE_URL_SCHEMES = ["http", "https", "mailto"];

export function isMappingEntryObject(entry: MappingEntry): entry is MappingEntryObject {
  return typeof entry === "object" && entry !== null;
}

/** True when the entry is the object form carrying a static value key. */
export function hasStaticValue(entry: MappingEntry): boolean {
  return isMappingEntryObject(entry) && "value" in entry;
}

/** Contact field path an entry points at ("" when it carries none). */
export function entryField(entry: MappingEntry): string {
  if (!isMappingEntryObject(entry)) return typeof entry === "string" ? entry : "";
  return typeof entry.field === "string" ? entry.field : "";
}

/** Static literal an entry carries ("" when it carries none). */
export function entryStaticValue(entry: MappingEntry): string {
  if (!isMappingEntryObject(entry)) return "";
  return typeof entry.value === "string" ? entry.value : "";
}

/** True when a URI scheme is allowed in a static value (href-safe). */
export function isSafeUrlScheme(scheme: string): boolean {
  return SAFE_URL_SCHEMES.includes(String(scheme ?? "").toLowerCase());
}

/**
 * Guard a static value that may be dropped into an href.
 *
 * A value that looks like an absolute URI is only allowed through when its
 * scheme is http/https/mailto; anything else (javascript:, data:, vbscript:,
 * file: …) is neutralised to "". The value is returned otherwise unchanged —
 * escaping is the renderer's job (Mustache's {{var}} escaping).
 *
 * Two details keep this from eating ordinary prose:
 *   * control characters are stripped before the check, because browsers ignore
 *     them when parsing a scheme ("java\tscript:" still runs); and
 *   * RFC 3986 says a scheme is followed immediately by a non-space character,
 *     so a label like "Note: see below" is never mistaken for a URI.
 */
export function sanitizeStaticValue(value: unknown): string {
  const s = String(value ?? "");
  // Browsers ignore control characters (tab, newline, NUL …) when parsing a
  // scheme, so drop them before testing — but keep spaces, because a space
  // after the colon is what makes something prose rather than a URI.
  const probe = s.replace(/\p{Cc}/gu, "").trimStart();
  const m = /^([a-z][a-z0-9+.-]*):\S/i.exec(probe);
  if (!m) return s;
  return isSafeUrlScheme(m[1]) ? s : "";
}

/** True when sanitizeStaticValue() would drop the value (unsafe URL scheme). */
export function isUnsafeStaticValue(value: unknown): boolean {
  const s = String(value ?? "");
  return sanitizeStaticValue(s) !== s;
}

/* ────────────────────────── Hybrid static values ────────────────────────── */

/**
 * A HYBRID value is an ordinary static `value` that also contains
 * {{contact.field}} placeholders, e.g.
 *
 *   { "value": "https://localdentists.au/setup-profile?api_key={{attributes.api_key}}" }
 *
 * The literal text is the same for everyone; each placeholder is resolved per
 * recipient against CONTACT FIELDS ONLY. A placeholder can therefore never pull
 * in another variable's resolved value: a value cannot reference itself and
 * there is no chain to loop on (one pass, no re-scan of what was substituted).
 *
 * Values with no placeholder keep the old pure-literal path exactly.
 */

/** Placeholder syntax inside a static value: {{field}} or {{attributes.field}}. */
const HYBRID_PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;

/** A value that is nothing but one placeholder (a whole URL, not a URL part). */
const SOLE_PLACEHOLDER = /^\s*\{\{\s*[A-Za-z_][A-Za-z0-9_.]*\s*\}\}\s*$/;

/** Fresh regex per call: a shared /g/ regex leaks lastIndex between calls. */
function hybridPlaceholderRe(): RegExp {
  return new RegExp(HYBRID_PLACEHOLDER.source, "g");
}

/** True when a static value carries at least one {{contact.field}} placeholder. */
export function hasHybridPlaceholder(value: unknown): boolean {
  return hybridPlaceholderRe().test(String(value ?? ""));
}

/**
 * True when a value's own literal text is already an absolute URI whose scheme
 * is allowed (http/https/mailto). Such a value is being used as a link even
 * when the renderer has no template HTML to inspect (an SMTP2GO template
 * renders its own body), so its interpolated parts get URL-context treatment.
 */
export function isUrlShapedStaticValue(value: unknown): boolean {
  const probe = String(value ?? "").replace(/\p{Cc}/gu, "").trimStart();
  const m = /^([a-z][a-z0-9+.-]*):\S/i.exec(probe);
  return !!m && isSafeUrlScheme(m[1]);
}

/**
 * Interpolate the {{contact.field}} placeholders of a static value, ONE pass.
 *
 * `resolve` is handed the placeholder's contact-field path and returns that
 * recipient's value ("" when the field is missing or there is no contact).
 *
 * `urlContext: true` means the result lands in an href, so each substituted
 * part is URL-encoded — a value containing & ? / or a space then cannot break
 * or reshape the URL — while the literal text around it stays exactly as typed.
 * One exception: a value that is ONLY a placeholder (`{{booking_url}}`) is a
 * whole URL rather than a URL component, so encoding it would destroy it; the
 * scheme rule still runs afterwards.
 *
 * A placeholder that resolves to nothing in a URL context fails the WHOLE value
 * safe ("") so a half-built URL is never emitted. In a text context a missing
 * field just substitutes as empty, the same as any unset variable.
 *
 * One spelling detail: in a mailto: value the "@" of an interpolated address is
 * left alone (it is the address separator there, and %40 means the same thing to
 * every mail client).
 */
export function interpolateStaticValue(
  value: unknown,
  resolve: (path: string) => unknown,
  opts: { urlContext?: boolean } = {},
): string {
  const s = String(value ?? "");
  const urlContext = !!opts.urlContext;
  const solePlaceholder = urlContext && SOLE_PLACEHOLDER.test(s);
  // An email in a mailto: keeps its "@": there it is the address separator, not
  // data that can break the URL, and %40 is the uglier spelling of the same thing.
  const isMailto = /^\s*mailto:/i.test(s);
  let unresolved = false;
  const out = s.replace(hybridPlaceholderRe(), (_m, path: string) => {
    const raw = resolve(path);
    const text = raw == null ? "" : String(raw);
    if (!text) {
      unresolved = true;
      return "";
    }
    if (!urlContext || solePlaceholder) return text;
    const encoded = encodeURIComponent(text);
    return isMailto ? encoded.replace(/%40/gi, "@") : encoded;
  });
  if (urlContext && unresolved) return "";
  return out;
}

/**
 * Names of the variables a document uses inside an href attribute, e.g.
 * `<a href="https://x/?k={{api_key}}">`. Those variables are rendered in URL
 * context, so a hybrid part of them is URL-encoded (interpolateStaticValue).
 * Quoted attributes only: an unquoted href holding a {{variable}} is not valid
 * HTML in the first place.
 */
export function findUrlContextVars(html: string | null | undefined): Set<string> {
  const names = new Set<string>();
  const src = String(html ?? "");
  if (!src) return names;
  const attr = /href\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let m: RegExpExecArray | null;
  while ((m = attr.exec(src)) !== null) {
    const inner = m[2] ?? m[3] ?? "";
    const varRe = /\{\{\{?\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}?\}\}/g;
    let v: RegExpExecArray | null;
    while ((v = varRe.exec(inner)) !== null) names.add(v[1]);
  }
  return names;
}

/** Editor row: one variable plus the source the operator chose for it. */
export type VarRowSource = "field" | "static";

export interface VarRow {
  name: string;
  source: VarRowSource;
  /** Contact field path when source === "field". */
  field: string;
  /** Literal value when source === "static". */
  value: string;
}

/** Load a stored entry into an editor row. */
export function toVarRow(name: string, entry: MappingEntry): VarRow {
  if (hasStaticValue(entry)) {
    return { name, source: "static", field: entryField(entry), value: entryStaticValue(entry) };
  }
  return { name, source: "field", field: entryField(entry), value: "" };
}

/** Serialize an editor row back into a stored entry. */
export function fromVarRow(row: VarRow): MappingEntry {
  return row.source === "static"
    ? { value: String(row.value ?? "") }
    : String(row.field ?? "").trim();
}

/** Parse a var_mapping JSON column into a plain object. */
export function parseVarMapping(raw: string | null | undefined): VarMapping | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === "object" && !Array.isArray(o)) return o as VarMapping;
  } catch {
    return null;
  }
  return null;
}
