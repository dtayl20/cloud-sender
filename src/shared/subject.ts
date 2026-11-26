/**
 * Subject lines. The subject is the one piece of campaign content that lands in
 * a mail HEADER rather than the body, so it gets its own tiny module: the
 * Worker send path (src/worker/render.ts re-exports these), the campaign editor
 * and the test send all need the same rules, and none may import the others.
 *
 * Rules, in order:
 *   1. the campaign's own subject wins when set, otherwise the template's;
 *   2. {{variables}} are substituted with exactly the variables the body uses;
 *   3. control characters are stripped -- CR/LF above all, because a newline in
 *      a header value is SMTP header injection -- and the result is capped.
 *
 * Two caps, for two different jobs:
 *   * MAX_SUBJECT_LENGTH (200) is the hard API guard on the STORED subject: a
 *     subject longer than that is rejected at the door.
 *   * SUBJECT_TARGET_LENGTH (65) is the cap on the RENDERED subject, i.e. after
 *     personalisation. A long business name inside "what we measured on
 *     {{business_name}}'s website" can push an otherwise short subject past 65
 *     characters, where most clients truncate it and it starts to read as bulk
 *     mail. See capRenderedSubject for exactly how it is shortened.
 *
 * Substitution is RAW (see shared/rawRender.ts): a subject is a mail header,
 * not markup, so an `&` in a practice name must stay an `&` and a URL must keep
 * its `/`/`?`/`=` rather than arriving as `&amp;` / `&#x2F;`.
 */

import { renderRaw } from "./rawRender";

/** A subject is one short header line. Longer STORED input is rejected by the API and truncated on the way out. */
export const MAX_SUBJECT_LENGTH = 200;

/**
 * The length a RENDERED subject is capped at, personalisation included. Chosen
 * to sit comfortably inside the ~70 characters most clients show and below our
 * own spam check's "long subject" line (spamCheck.ts: SUBJECT_LONG_AT = 78), so
 * shortening a long name can only improve the score.
 */
export const SUBJECT_TARGET_LENGTH = 65;

/** C0 controls (NUL..US: CR, LF, TAB included), DEL and the C1 controls. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** A plain {{var}} / {{{var}}} placeholder, with or without inner whitespace. */
const VAR_TOKEN_SOURCE = "\\{\\{\\{?\\s*([A-Za-z_][A-Za-z0-9_.]*)\\s*\\}?\\}\\}";

/** A Mustache section/partial/comment token: the placeholder model below does not describe these. */
const MUSTACHE_SPECIAL = /\{\{\s*[#/^!>=]/;

/** Words kept in a personalisation when it has to be shortened (2 = never a lone half-name). */
const MIN_NAME_WORDS = 2;

/**
 * Strip control characters, collapse whitespace runs, trim. Never throws; a
 * non-string (null, undefined, a number from JSON) becomes "".
 *
 * A control character is replaced by a SPACE rather than deleted, so
 * "Hi\nWorld" sanitises to "Hi World" instead of "HiWorld".
 */
export function sanitizeSubject(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

/** True when the sanitized subject is longer than a stored header value should be. */
export function subjectTooLong(raw: unknown): boolean {
  return sanitizeSubject(raw).length > MAX_SUBJECT_LENGTH;
}

/** Last line of defence: never emit a header longer than the stored cap. */
export function clampSubject(value: string): string {
  return value.length > MAX_SUBJECT_LENGTH ? value.slice(0, MAX_SUBJECT_LENGTH).trim() : value;
}

/**
 * Which text the subject comes from, before substitution: the campaign's own
 * subject when it has one, else the template's. Either may be blank.
 * The editor uses this to say plainly which one will send.
 */
export function subjectSource(
  campaignSubject: string | null | undefined,
  templateSubject: string | null | undefined,
): string {
  const own = sanitizeSubject(campaignSubject);
  return own || sanitizeSubject(templateSubject);
}

interface SubjectToken {
  start: number;
  end: number;
  name: string;
}

/** The {{var}} placeholders in a subject source, in order. */
function subjectTokens(source: string): SubjectToken[] {
  const re = new RegExp(VAR_TOKEN_SOURCE, "g");
  const out: SubjectToken[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, name: m[1] });
  }
  return out;
}

/** Rebuild the subject from its tokens, looking each value up by name. */
function renderTokens(
  source: string,
  tokens: SubjectToken[],
  value: (name: string) => string,
): string {
  let out = "";
  let pos = 0;
  for (const t of tokens) {
    out += source.slice(pos, t.start) + value(t.name);
    pos = t.end;
  }
  return out + source.slice(pos);
}

/** Cut at the last whole word inside the target, never leaving a stray possessive. */
function truncateToTarget(rendered: string): string {
  const s = sanitizeSubject(rendered);
  if (s.length <= SUBJECT_TARGET_LENGTH) return s;
  let cut = s.slice(0, SUBJECT_TARGET_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  cut = cut
    .trim()
    // A cut that lands after "Name's" would leave the possessive dangling.
    .replace(/['\u2019]s?$/, "")
    .trim();
  return cut || s.slice(0, SUBJECT_TARGET_LENGTH).trim();
}

/**
 * Drop the personalisation cleanly: the token (and a possessive attached to it)
 * becomes a neutral word, so a name that cannot fit still leaves a subject a
 * person could have written -- "what we measured on your website", not
 * "what we measured on 's website".
 */
function withoutPersonalisation(source: string): string {
  return source.replace(
    new RegExp(`${VAR_TOKEN_SOURCE}(['\u2019]s\\b)?`, "g"),
    (_m, _name, possessive) => (possessive ? "your" : "you"),
  );
}

/**
 * Bring a rendered subject down to SUBJECT_TARGET_LENGTH.
 *
 * A subject that already fits is returned untouched -- the cap only ever fires
 * on the personalisation that pushed it over, which is the long business name.
 * In order of preference:
 *
 *   1. shorten the variable VALUE at a word boundary, longest value first, so
 *      the name loses whole trailing words and the possessive in the template
 *      around it stays intact ("... Comfort Dental Gymea's website");
 *   2. if the value cannot keep at least two whole words, drop the
 *      personalisation entirely rather than ship a mangled half-name;
 *   3. if there is no variable to blame, cut the subject at a whole word.
 *
 * `resolve` returns the value for a variable, or null when the token should
 * stay visible (the editor preview keeps an undeclared variable as {{name}}).
 */
export function capRenderedSubject(
  rendered: string,
  source: string,
  resolve: (name: string) => string | null,
): string {
  const clean = sanitizeSubject(rendered);
  if (clean.length <= SUBJECT_TARGET_LENGTH) return clean;
  if (!source) return truncateToTarget(clean);

  const tokens = subjectTokens(source);
  // A Mustache section is beyond the plain-placeholder model here; fall back.
  const personalisable = tokens.length > 0 && !MUSTACHE_SPECIAL.test(source);

  if (personalisable) {
    const values = new Map<string, string>();
    for (const t of tokens) {
      if (values.has(t.name)) continue;
      const v = resolve(t.name);
      // An unresolved variable is a literal token, not a name we can shorten.
      values.set(t.name, v == null ? `{{${t.name}}}` : v);
    }
    const build = () => renderTokens(source, tokens, (n) => values.get(n) ?? "");

    let current = build();
    while (current.length > SUBJECT_TARGET_LENGTH) {
      const target = pickLongestTrimmable(values);
      if (!target) break;
      values.set(target, trimLastWord(values.get(target) ?? ""));
      current = build();
    }
    if (current.length <= SUBJECT_TARGET_LENGTH) return sanitizeSubject(current);

    // No name can be shortened to fit: the skeleton itself is what is long.
  }

  if (personalisable) {
    const neutral = sanitizeSubject(withoutPersonalisation(source));
    if (neutral && neutral.length <= SUBJECT_TARGET_LENGTH) return neutral;
    if (neutral) return truncateToTarget(neutral);
  }
  return truncateToTarget(clean);
}

/** The value with the most room to give: words beyond the floor, longest first. */
function pickLongestTrimmable(values: Map<string, string>): string | null {
  let best: string | null = null;
  let bestLen = 0;
  for (const [name, value] of values) {
    if (wordCount(value) <= MIN_NAME_WORDS) continue;
    if (value.length > bestLen) {
      best = name;
      bestLen = value.length;
    }
  }
  return best;
}

function wordCount(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

function trimLastWord(value: string): string {
  const words = value.split(/\s+/).filter(Boolean);
  return words.slice(0, -1).join(" ");
}

/**
 * The subject a send will actually use: pick the source, substitute
 * {{variables}} exactly like the body does, make it header-safe, then cap the
 * rendered line. Substitution is the RAW render (shared/rawRender.ts), so the
 * value goes in unescaped -- a header is not markup.
 */
export function renderSubject(
  campaignSubject: string | null | undefined,
  templateSubject: string | null | undefined,
  vars: Record<string, unknown>,
): string {
  const source = subjectSource(campaignSubject, templateSubject);
  const rendered = sanitizeSubject(renderRaw(source, vars));
  return capRenderedSubject(rendered, source, (name) =>
    name in vars && vars[name] != null ? String(vars[name]) : "",
  );
}

/**
 * The subject the campaign editor shows. Same source resolution and same cap as
 * the send, but a variable with no sample value stays visible as {{name}}
 * instead of vanishing, so the operator can see what is still unmapped. The
 * cap is applied to the same raw render the send uses, so the preview cannot
 * disagree with what goes out.
 */
export function previewSubjectLine(
  campaignSubject: string | null | undefined,
  templateSubject: string | null | undefined,
  values: Record<string, unknown>,
): string {
  const source = subjectSource(campaignSubject, templateSubject);
  const resolve = (name: string) =>
    name in values && values[name] != null ? String(values[name]) : null;
  const rendered = sanitizeSubject(
    renderTokens(source, subjectTokens(source), (name) => resolve(name) ?? `{{${name}}}`),
  );
  return capRenderedSubject(rendered, source, resolve);
}
