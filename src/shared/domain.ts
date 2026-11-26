/**
 * Sending-domain rules, shared by the Worker, the campaign picker and the
 * deliverability panel.
 *
 * The bug this module exists to kill: SMTP2GO's `/domain/view` record nests the
 * parts of a domain under `domain` —
 * `{ fulldomain: "localdentists.au", subdomain: null, domain: "localdentists", suffix: "au" }` —
 * where `domain` is the FIRST LABEL. A picker that read the inner `domain`
 * (and looked for `suffix` one level too high, so it had nothing to append)
 * offered and saved "localdentists", which is not a domain. Every check then
 * asked DNS about a name that does not exist, and the Deliverability panel
 * reported four failures for a domain whose DNS was fine.
 *
 * So: a sending domain is never a bare label. If a value has no dot it is not a
 * domain, and callers must either derive a real one (from the From address, or
 * from SMTP2GO's `fulldomain`) or treat the value as absent. A comparison key
 * (if one is ever needed) must be kept separate from the value.
 *
 * Deliberately dependency-free so the Worker and the React app can share it.
 */

/**
 * Normalise a candidate sending domain: trim, lowercase, strip a trailing dot,
 * and require at least one dot. Returns null for anything that is not a domain
 * — including a bare label like "localdentists".
 */
export function normalizeSendingDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase().replace(/\.+$/, "");
  // A bare label is not a domain: without a dot there is nothing to look up.
  if (!s || !s.includes(".")) return null;
  // Structural sanity: no whitespace or "@", no empty label, no leading dot.
  if (/[\s@]/.test(s)) return null;
  if (s.startsWith(".") || s.includes("..")) return null;
  // Must end on a real label, not a trailing hyphen or an empty TLD.
  const tld = s.slice(s.lastIndexOf(".") + 1);
  if (!tld || !/^[a-z0-9-]+$/.test(tld)) return null;
  return s;
}

/** True when the value can be used as a sending domain as-is. */
export function isSendingDomain(value: unknown): boolean {
  return normalizeSendingDomain(value) !== null;
}

/**
 * The domain part of an address, lowercased, with a trailing dot stripped.
 * Accepts "Name <a@b.com>" as well as a bare address. No dot requirement here:
 * this is the raw extraction, and callers that need a real domain run it
 * through `normalizeSendingDomain` (see `domainOfEmail` in deliverability.ts,
 * which keeps the lenient behaviour for DMARC alignment).
 */
export function domainFromEmail(email: unknown): string | null {
  const s = String(email ?? "").trim();
  if (!s) return null;
  const m = /<([^<>@\s]+@[^<>\s]+)>|([^<>\s@]+@[^<>\s]+)\s*$/.exec(s) ?? /@([^<>\s@]+)/.exec(s);
  const addr = m ? (m[1] ?? m[2] ?? s) : s;
  const at = addr.lastIndexOf("@");
  if (at === -1) return null;
  const d = addr.slice(at + 1).trim().toLowerCase().replace(/\.+$/, "");
  return d || null;
}

/** The From address's domain, but only when it is a usable domain. */
export function sendingDomainFromEmail(email: unknown): string | null {
  return normalizeSendingDomain(domainFromEmail(email));
}

/**
 * The full domain of one SMTP2GO sender-domain record, or null when the record
 * carries no usable name.
 *
 * Handles both shapes the API is known to return:
 *   * the documented nested record — `{ domain: { fulldomain } }` (preferred),
 *     falling back to rebuilding `subdomain.domain.suffix`;
 *   * a flat record with `fulldomain` / `domain_name` / a bare `domain` string.
 *
 * `domain` alone is only accepted when it already contains a dot: on the nested
 * shape it is the first label, and returning that is exactly the bug.
 */
export function smtp2goRecordDomain(raw: unknown): string | null {
  if (typeof raw === "string") return normalizeSendingDomain(raw);
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const inner = r.domain && typeof r.domain === "object" ? (r.domain as Record<string, any>) : null;

  const direct =
    pickString(inner?.fulldomain) ??
    pickString(r.fulldomain) ??
    pickString(r.domain_name) ??
    (typeof r.domain === "string" ? pickString(r.domain) : null);
  const directDomain = normalizeSendingDomain(direct);
  if (directDomain) return directDomain;

  // Rebuild from the parts, keeping multi-part TLDs intact: the suffix is the
  // whole tail ("com.au"), so joining on dots yields "something.com.au" and
  // never "com.au" on its own.
  const subdomain = pickString(inner?.subdomain) ?? pickString(r.subdomain);
  const label = pickString(inner?.domain) ?? (typeof r.domain === "string" ? pickString(r.domain) : null);
  const suffix = pickString(inner?.suffix) ?? pickString(r.suffix);
  const joined = [subdomain, label, suffix].filter(Boolean).join(".");
  return normalizeSendingDomain(joined);
}

function pickString(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  return null;
}
