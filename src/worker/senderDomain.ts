/**
 * The sending-domain rule, in one place.
 *
 * The owner only ever sends through SMTP2Go, and SMTP2Go signs a message with
 * one of the account's *verified* sending domains. A From address whose domain
 * is not a verified sending domain is exactly the failure this module exists to
 * stop: `something@example.com` while the send would actually go out over
 * a different verified domain.
 *
 * So the rule is: the domain of a resolved From address MUST be one of the
 * SMTP2Go account's verified sending domains.
 *
 * * Save time (routes/senderIdentities.ts, routes/campaigns.ts): checked LIVE
 *   against the SMTP2Go API. If the API cannot be read the save is refused
 *   (fail closed) rather than trusting a domain we could not confirm.
 *
 * * Send time (consumer.ts): checked deterministically against the identity's
 *   stored `sending_domain` (a mismatch is impossible to miss without a network
 *   call), and against the cached verified-domain snapshot when one exists. If
 *   the snapshot has never been written the membership check is skipped so a
 *   deploy cannot brick sending from a set that was never read — the identity's
 *   own bound domain is still enforced.
 *
 * The cache lives in `settings` under `smtp2go_verified_domains`, written by
 * `refreshVerifiedDomains` (called from the Settings page's sync button and the
 * sender-identities list). It is a snapshot: `synced_at` says when it was read.
 */

import type { Env } from "./types";
import { smtp2goListDomains } from "./smtp2go";
import { domainFromEmail, normalizeSendingDomain, smtp2goRecordDomain } from "../shared/domain";

/** settings key holding the last read of SMTP2Go's sender domains. */
export const VERIFIED_DOMAINS_SETTING = "smtp2go_verified_domains";

/** One sender domain as reported by SMTP2Go, reduced to what the rule needs. */
export interface SenderDomainRecord {
  domain: string;
  verified: boolean;
  dkim_verified: boolean | null;
  rpath_verified: boolean | null;
  status: string | null;
}

export interface VerifiedDomainsSnapshot {
  /** The verified domains only (the sendable set). */
  domains: string[];
  /** Every domain SMTP2Go returned, with its per-record status. */
  records: SenderDomainRecord[];
  synced_at: number;
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  return null;
}
function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/**
 * Reduce one `/domain/search` (or `/domain/view`) record to the domain name and
 * whether SMTP2Go reports it verified.
 *
 * The live shape nests the record under `domain` and carries booleans
 * (`dkim_verified`, `rpath_verified`, `trackdomain_verified`); older/flat
 * shapes put them at the top level. A domain counts as verified when SMTP2Go
 * reports ANY of those true (a verified sender domain in the account), or when
 * it carries an explicit `status: "verified"`. An unverified domain reports
 * false/false and is refused.
 */
export function senderDomainRecord(raw: unknown): SenderDomainRecord | null {
  const domain = smtp2goRecordDomain(raw);
  if (!domain) return null;
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const inner = r.domain && typeof r.domain === "object" ? (r.domain as Record<string, any>) : null;
  const dkim = bool(inner?.dkim_verified) ?? bool(r.dkim_verified);
  const rpath = bool(inner?.rpath_verified) ?? bool(r.rpath_verified);
  const track = bool(inner?.trackdomain_verified) ?? bool(r.trackdomain_verified);
  const status = str(inner?.status) ?? str(r.status);
  const verified =
    dkim === true || rpath === true || track === true || (status ?? "").toLowerCase() === "verified";
  return { domain, verified, dkim_verified: dkim, rpath_verified: rpath, status };
}

/** The full domain of a From address, or null when it has none usable. */
export function fromEmailDomain(email: unknown): string | null {
  return normalizeSendingDomain(domainFromEmail(email));
}

export function snapshotFromRecords(records: SenderDomainRecord[], nowSeconds: number): VerifiedDomainsSnapshot {
  const domains = records.filter((r) => r.verified).map((r) => r.domain);
  // De-dupe, stable order.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const d of domains) {
    if (!seen.has(d)) {
      seen.add(d);
      unique.push(d);
    }
  }
  unique.sort();
  return { domains: unique, records, synced_at: nowSeconds };
}

/** Parse a stored snapshot, tolerating an older shape or junk. */
export function parseVerifiedDomains(value: unknown): VerifiedDomainsSnapshot | null {
  let v: unknown = value;
  if (typeof value === "string") {
    try {
      v = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  // Accept a bare array of domain names as well.
  if (Array.isArray(o.domains)) {
    const domains = o.domains.filter((d): d is string => typeof d === "string").map((d) => d.toLowerCase());
    const records = Array.isArray(o.records) ? (o.records as SenderDomainRecord[]) : [];
    return { domains, records, synced_at: Number(o.synced_at ?? 0) };
  }
  return null;
}

/** True when `domain` is in the snapshot's verified set. */
export function snapshotHasDomain(snapshot: VerifiedDomainsSnapshot | null, domain: string | null): boolean {
  if (!snapshot || !domain) return false;
  return snapshot.domains.includes(domain.toLowerCase());
}

/**
 * The send-time rule as a pure function over a (possibly absent) snapshot.
 * Returns a human-readable violation, or null when the send may proceed.
 *
 * `identityDomain` is the identity's own bound sending domain (already validated
 * at save time). When it disagrees with the From address's domain the send is
 * refused regardless of the snapshot — that is the mismatch the owner named.
 */
export function sendDomainViolation(opts: {
  fromEmail: string | null | undefined;
  identityName?: string | null;
  identityDomain?: string | null;
  identityEnabled?: boolean | null;
  snapshot: VerifiedDomainsSnapshot | null;
}): string | null {
  const domain = fromEmailDomain(opts.fromEmail);
  if (!domain) return `From address "${opts.fromEmail ?? ""}" has no usable domain`;
  if (opts.identityDomain) {
    if (opts.identityEnabled === false) {
      return `Sender identity "${opts.identityName ?? ""}" is disabled`;
    }
    if (opts.identityDomain.toLowerCase() !== domain) {
      return `Sender identity "${opts.identityName ?? ""}" is bound to ${opts.identityDomain} but the message would send from ${domain}`;
    }
  }
  // Membership is only enforced once a verified set has actually been read; a
  // never-synced cache must not block every send.
  if (opts.snapshot && !snapshotHasDomain(opts.snapshot, domain)) {
    return `From domain "${domain}" is not a verified SMTP2GO sending domain`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Worker-side helpers (network + cache)
// ---------------------------------------------------------------------------

/** Live read of SMTP2Go's sender domains. Throws when unconfigured or unreachable. */
export async function fetchSenderDomainRecords(apiKey: string | undefined): Promise<SenderDomainRecord[]> {
  const key = (apiKey ?? "").trim();
  if (!key) throw new Error("SMTP2GO_API_KEY is not configured, so sending domains cannot be verified");
  const raw = await smtp2goListDomains(key);
  return (raw ?? [])
    .map((d) => senderDomainRecord(d))
    .filter((d): d is SenderDomainRecord => d !== null);
}

/** Live read + persist the verified-domain snapshot. */
export async function refreshVerifiedDomains(env: Env, nowSeconds?: number): Promise<VerifiedDomainsSnapshot> {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const records = await fetchSenderDomainRecords(env.SMTP2GO_API_KEY);
  const snapshot = snapshotFromRecords(records, now);
  try {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=unixepoch()",
    )
      .bind(VERIFIED_DOMAINS_SETTING, JSON.stringify(snapshot))
      .run();
  } catch {
    /* cache write is best-effort; the live answer is still returned */
  }
  return snapshot;
}

/** The cached snapshot, or null when none has ever been written. */
export async function readVerifiedDomains(env: Env): Promise<VerifiedDomainsSnapshot | null> {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?")
      .bind(VERIFIED_DOMAINS_SETTING)
      .first<{ value: string }>();
    if (!row) return null;
    return parseVerifiedDomains(row.value);
  } catch {
    return null;
  }
}

/**
 * Save-time rule: the From address's domain must be a verified SMTP2Go sender
 * domain. Live, fail closed. Throws with a message meant for the operator.
 */
export async function assertFromEmailVerified(env: Env, fromEmail: string): Promise<SenderDomainRecord> {
  const domain = fromEmailDomain(fromEmail);
  if (!domain) throw new Error(`From address "${fromEmail}" has no usable domain`);
  const records = await fetchSenderDomainRecords(env.SMTP2GO_API_KEY);
  const match = records.find((r) => r.domain === domain);
  if (!match) {
    const known = records.map((r) => r.domain).sort().join(", ") || "(none)";
    throw new Error(
      `From domain "${domain}" is not a sending domain in SMTP2Go. Add and verify it under SMTP2GO → Verified Senders first. Known domains: ${known}`,
    );
  }
  if (!match.verified) {
    throw new Error(
      `Sending domain "${domain}" is not verified in SMTP2Go yet. Verify it under SMTP2GO → Verified Senders before using it.`,
    );
  }
  return match;
}
