/**
 * The Worker half of the deliverability checks: fetch the DNS answers and the
 * SMTP2GO sender-domain state, then hand both to the shared builder in
 * src/shared/deliverability.ts, which does all the judging.
 *
 * Keeping the fetching here and the deciding there means the parsing rules are
 * unit-tested against canned answers, and this file only has to be right about
 * *what* to ask for.
 */

import type { Env } from "./types";
import { smtp2goListDomains } from "./smtp2go";
import { dohLookup, type FetchLike } from "./dns";
import {
  DNS_TYPE,
  buildDeliverability,
  dkimExpectations,
  domainOfEmail,
  normalizeSmtp2goDomain,
  resolveDkimRecord,
  type DeliverabilityResult,
  type DkimCheckInput,
  type DkimRecordOutcome,
  type DomainSource,
  type Smtp2goSenderDomain,
} from "../shared/deliverability";
import { domainFromEmail, normalizeSendingDomain } from "../shared/domain";

export interface DeliverabilityOptions {
  /** The sending domain to check. */
  domain?: string | null;
  /** The campaign's From address — its domain is what DMARC alignment is judged on. */
  fromEmail?: string | null;
  /** Injected in tests. */
  fetchImpl?: FetchLike;
  now?: number;
  /** Force a fresh set of lookups instead of reusing the isolate cache. */
  noCache?: boolean;
}

/**
 * The domain to check, and where it came from.
 *
 * A stored sending-domain value that is not a domain (a bare label like
 * "localdentists", with no dot) is never used as the lookup name: it would make
 * every check fail against a name that does not exist. The From address's
 * domain is used instead, and `ignored` carries the rejected value so the panel
 * can say what it did.
 */
export interface ResolvedCheckDomain {
  domain: string;
  source: DomainSource;
  /** The value that was offered but is not a domain, when there was one. */
  ignored: string | null;
}

/**
 * Which domain to check: the one given (when it is really a domain), else the
 * From address's domain, else the Worker's DEFAULT_FROM_EMAIL domain. Null when
 * none of those exist.
 */
export function resolveCheckDomainInfo(
  env: Pick<Env, "DEFAULT_FROM_EMAIL">,
  opts: DeliverabilityOptions = {},
): ResolvedCheckDomain | null {
  const offered = String(opts.domain ?? "").trim();
  const explicit = normalizeSendingDomain(opts.domain);
  if (explicit) return { domain: explicit, source: "sending_domain", ignored: null };
  const from = normalizeSendingDomain(domainFromEmail(opts.fromEmail));
  if (from) return { domain: from, source: "from_email", ignored: offered || null };
  const fallback = normalizeSendingDomain(domainFromEmail(env.DEFAULT_FROM_EMAIL ?? null));
  if (fallback) return { domain: fallback, source: "default_from", ignored: offered || null };
  return null;
}

/** The domain to check, or null. Kept for callers that only need the name. */
export function resolveCheckDomain(
  env: Pick<Env, "DEFAULT_FROM_EMAIL">,
  opts: DeliverabilityOptions = {},
): string | null {
  return resolveCheckDomainInfo(env, opts)?.domain ?? null;
}

/**
 * Resolve every CNAME SMTP2GO asks for on a sender domain, and report what
 * SMTP2GO itself thinks of the domain.
 */
async function dkimHalf(
  env: Pick<Env, "SMTP2GO_API_KEY">,
  domain: string,
  opts: DeliverabilityOptions,
): Promise<DkimCheckInput> {
  if (typeof env.SMTP2GO_API_KEY !== "string" || !env.SMTP2GO_API_KEY.trim()) {
    return {
      senderDomain: null,
      records: [],
      // Not an error to fix — the DKIM half genuinely cannot be read.
      error: "SMTP2GO is not configured (SMTP2GO_API_KEY unset), so the DKIM and verification half could not be checked",
    };
  }

  let raw: unknown[];
  try {
    raw = await smtp2goListDomains(env.SMTP2GO_API_KEY);
  } catch (e) {
    return {
      senderDomain: null,
      records: [],
      error: `the SMTP2GO API could not be read (${e instanceof Error ? e.message : String(e)}), so the DKIM and verification half could not be checked`,
    };
  }

  const domains = (raw ?? [])
    .map((d) => normalizeSmtp2goDomain(d))
    .filter((d): d is Smtp2goSenderDomain => d !== null);

  const senderDomain = domains.find((d) => d.fulldomain === domain) ?? null;
  if (!senderDomain) {
    return { senderDomain: null, records: [], notRegistered: true };
  }

  const expectations = dkimExpectations(senderDomain);
  const records: DkimRecordOutcome[] = [];
  for (const exp of expectations) {
    const answer = await dohLookup(exp.host, DNS_TYPE.CNAME, {
      fetchImpl: opts.fetchImpl,
      now: opts.now,
      noCache: opts.noCache,
    });
    records.push(resolveDkimRecord(exp, answer));
  }
  return { senderDomain, records };
}

/**
 * Run all five checks for one domain. Never throws — a failure to look
 * something up is carried through as an `unknown` check.
 */
export async function checkDeliverability(
  env: Pick<Env, "SMTP2GO_API_KEY" | "DEFAULT_FROM_EMAIL">,
  opts: DeliverabilityOptions = {},
): Promise<DeliverabilityResult | { error: string }> {
  const resolved = resolveCheckDomainInfo(env, opts);
  if (!resolved) {
    return { error: "no domain to check — give the campaign a sending domain or a From address" };
  }
  const domain = resolved.domain;

  const dnsOpts = { fetchImpl: opts.fetchImpl, now: opts.now, noCache: opts.noCache };
  const [spf, dmarc, mx, dkim] = await Promise.all([
    dohLookup(domain, DNS_TYPE.TXT, dnsOpts),
    dohLookup(`_dmarc.${domain}`, DNS_TYPE.TXT, dnsOpts),
    dohLookup(domain, DNS_TYPE.MX, dnsOpts),
    dkimHalf(env, domain, opts),
  ]);

  return buildDeliverability({
    domain,
    domainSource: resolved.source,
    ignoredDomain: resolved.ignored,
    // Without an explicit From the checked domain stands in for it, so the
    // alignment check compares like with like instead of reporting a gap it
    // cannot see.
    fromDomain: domainOfEmail(opts.fromEmail) ?? domain,
    spf,
    dmarc,
    mx,
    dkim,
    checkedAt: opts.now ? Math.floor(opts.now / 1000) : undefined,
  });
}
