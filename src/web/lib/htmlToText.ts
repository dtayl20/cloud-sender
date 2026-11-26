import { escapeHtml } from "../../shared/body";

// htmlToText lives in shared/body.ts now: the Worker's text/plain fallback for
// a campaign body needs the same conversion the template editor uses.
export { htmlToText } from "../../shared/body";

export const PLAIN_WRAPPER_START = '<pre style="font-family:inherit;white-space:pre-wrap;margin:0">';
export const PLAIN_WRAPPER_END = "</pre>";

/** Wrap plain text so HTML-only clients still render it correctly. */
export function textToPlainHtml(text: string): string {
  if (!text.trim()) return "";
  return `${PLAIN_WRAPPER_START}${escapeHtml(text)}${PLAIN_WRAPPER_END}`;
}

/** True when the html is empty or is just our plain-text wrapper. */
export function isPlainOnlyHtml(html: string | null | undefined): boolean {
  const h = (html ?? "").trim();
  if (!h) return true;
  return h.startsWith("<pre") && h.endsWith("</pre>") && !/<(?!\/?pre)[a-z]/i.test(h);
}
