/**
 * A Mustache pass that substitutes {{var}} RAW — no HTML escaping.
 *
 * Mustache HTML-escapes every {{var}} by default, which is exactly right for the
 * HTML body (the escaping is a markup-context security control). It is wrong
 * for the text/plain body: a mail client does not decode entities in a
 * text/plain part, so an escaped URL arrives with `&#x2F;` where `/` should be
 * and a practice name with `&` arrives as `&amp;`. The subject has the same
 * problem for the same reason — it is a mail header, not markup.
 *
 * The value is substituted raw rather than decoded afterwards, so a value that
 * merely LOOKS like an entity is never re-interpreted.
 *
 * Used by the Worker send path (worker/render.ts) and the campaign subject
 * (shared/subject.ts). The HTML render path (Mustache.render with its default
 * escaping) is untouched.
 */

import Mustache from "mustache";

/**
 * Mustache render options whose `escape` is the identity function: {{var}}
 * inserts the value as-is. Named so both callers share the one definition.
 */
export const RAW_MUSTACHE: { escape: (value: unknown) => string } = {
  escape: (value) => String(value),
};

/** Render `template` with `vars`, substituting every {{var}} without escaping. */
export function renderRaw(template: string, vars: Record<string, unknown>): string {
  return Mustache.render(template, vars, undefined, RAW_MUSTACHE);
}
