/**
 * Pure helpers shared by the Worker send path (src/worker/render.ts) and the
 * campaign editor (src/web/pages/CampaignEdit.tsx).
 *
 * Feature: a base template supplies the chrome (header/footer/styles) and marks
 * where the campaign body goes with a {{content}} slot; the campaign supplies
 * the body. Both sides must apply exactly the same merge/convert rules, so the
 * rules live here with no Worker, React or DB imports.
 */

/** Token a base template uses to mark where the campaign body goes. */
export const CONTENT_SLOT = "{{content}}";

/** Matches {{content}}, {{{content}}} and the whitespace variants. */
const CONTENT_SLOT_RE = /\{\{\{?\s*content\s*\}?\}\}/g;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** True when a template marks a place for campaign content. */
export function hasContentSlot(template: string | null | undefined): boolean {
  if (!template) return false;
  CONTENT_SLOT_RE.lastIndex = 0;
  return CONTENT_SLOT_RE.test(template);
}

/** True when a template row is flagged as a base (chrome-only) template. */
export function isBaseTemplate(
  t: { is_base?: number | boolean | null } | null | undefined,
): boolean {
  return !!t && (t.is_base === 1 || t.is_base === true);
}

/** True when a template can receive a per-campaign body. */
export function acceptsCampaignBody(
  t: { is_base?: number | boolean | null; html?: string | null } | null | undefined,
): boolean {
  return !!t && (isBaseTemplate(t) || hasContentSlot(t.html));
}

/**
 * Inject a campaign body at {{content}}.
 *
 * Order is deliberate: this runs BEFORE Mustache, so
 *   * variables written inside the body ({{first_name}}) resolve exactly like
 *     variables in the template, and
 *   * the body's own HTML is template markup rather than a Mustache value, so
 *     it is never HTML-escaped.
 *
 * `body` null/undefined means "no campaign body": the template is returned
 * untouched, which keeps non-base campaigns byte-for-byte identical to before.
 *
 * A template with no {{content}} slot gets the body APPENDED rather than
 * silently dropped. Use hasContentSlot()/acceptsCampaignBody() first when you
 * want to warn the operator about a base template that forgot the slot.
 */
export function mergeBody(template: string, body: string | null | undefined): string {
  if (body == null) return template;
  if (!hasContentSlot(template)) return template + body;
  CONTENT_SLOT_RE.lastIndex = 0;
  // Function form: a body containing "$&" or "$1" must not be re-substituted.
  return template.replace(CONTENT_SLOT_RE, () => body);
}

/**
 * Editor plain text -> minimal HTML. A blank line starts a new paragraph and a
 * single newline is a line break; everything is escaped, so nobody has to write
 * HTML (or can accidentally inject it). {{variables}} survive untouched.
 */
export function plainTextToHtml(text: string | null | undefined): string {
  const blocks = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((b) => b.replace(/[ \t]+$/gm, "").trim())
    .filter(Boolean);
  return blocks.map((b) => `<p>${escapeHtml(b).replace(/\n/g, "<br />")}</p>`).join("\n");
}

/**
 * Dependency-free HTML -> plain text conversion, used to build the text/plain
 * half of a base template (and by the template editor's fallback generator).
 * Mustache variables like {{first_name}} pass through untouched.
 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  let s = html;

  // Drop non-content elements entirely.
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, "");

  // Links: keep the label plus the URL.
  s = s.replace(
    /<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, label: string) => {
      const text = decodeEntities(label.replace(/<[^>]+>/g, "")).trim();
      const url = href.trim();
      if (!url || url.startsWith("#")) return text;
      if (!text) return url;
      if (text === url) return url;
      return `${text} (${url})`;
    },
  );

  // Images -> alt text.
  s = s.replace(/<img\b[^>]*alt\s*=\s*["']([^"']*)["'][^>]*>/gi, "$1");
  s = s.replace(/<img\b[^>]*>/gi, "");

  // Block-level structure -> newlines.
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<hr\s*\/?>/gi, "\n----------\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<\/li>/gi, "");
  s = s.replace(
    /<\/(p|div|tr|table|ul|ol|section|article|header|footer|blockquote|h[1-6])>/gi,
    "\n\n",
  );
  s = s.replace(
    /<(p|div|tr|table|ul|ol|section|article|header|footer|blockquote|h[1-6])\b[^>]*>/gi,
    "\n",
  );
  s = s.replace(/<\/t[dh]>/gi, "  ");

  // Strip everything else.
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);

  // Tidy whitespace.
  s = s.replace(/\r\n?/g, "\n");
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n");
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}
