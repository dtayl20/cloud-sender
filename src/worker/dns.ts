/**
 * DNS-over-HTTPS lookups for the deliverability checks.
 *
 * Cloudflare's JSON API is used directly — no npm DNS library. The only thing
 * that leaves this Worker is a domain name and a record type.
 *
 * The honesty rule from src/shared/deliverability.ts lives here too: a fetch
 * that fails (timeout, non-2xx, unreadable JSON) becomes `unknown`, while a
 * NOERROR/NXDOMAIN answer with no records becomes `absent`. Those are never
 * collapsed into one another.
 *
 * Caching: DNS changes slowly, so answers are held in an isolate-local Map.
 * Successful answers (found OR a genuine absence) are kept for 5 minutes —
 * long enough that clicking around the editor does not hammer the resolver,
 * short enough that a record added while the operator is on the page shows up
 * within one "Check again" cycle. Failures are cached separately for only 60
 * seconds, so a resolver blip does not stick as "could not be checked" for the
 * whole 5 minutes. The cache is per isolate, so it is a best-effort dedupe of
 * repeated lookups rather than a shared cache.
 */

import { parseDohResponse, type DnsResult } from "../shared/deliverability";

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

/** How long a real answer (including "there is nothing published") is reused. */
export const ANSWER_TTL_MS = 5 * 60_000;
/** How long a failed lookup is reused — short, so a blip clears quickly. */
export const FAILURE_TTL_MS = 60_000;
/** Per-request timeout; a hung resolver must not hold the panel open. */
export const DNS_TIMEOUT_MS = 5000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface CacheEntry {
  expires: number;
  result: DnsResult;
}

const cache = new Map<string, CacheEntry>();

/** Drop every cached answer — used by tests, and by a manual cache-buster. */
export function clearDnsCache(): void {
  cache.clear();
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

export interface DohOptions {
  /** Injected in tests; defaults to the platform fetch. */
  fetchImpl?: FetchLike;
  /** Injected in tests, so TTL behaviour is deterministic. */
  now?: number;
  timeoutMs?: number;
  /** Skip the cache for one call (a manual "Check again" can force a refresh). */
  noCache?: boolean;
}

/**
 * Ask the resolver one question. `type` is a numeric DNS type (see DNS_TYPE).
 * Never throws: every failure mode comes back as an `unknown` DnsResult.
 */
export async function dohLookup(
  name: string,
  type: number,
  opts: DohOptions = {},
): Promise<DnsResult> {
  const host = normalizeName(name);
  if (!host) return { state: "unknown", reason: "no domain name was given" };

  const key = `${type}|${host}`;
  const now = opts.now ?? Date.now();
  if (!opts.noCache) {
    const hit = cache.get(key);
    if (hit && hit.expires > now) return hit.result;
  }

  const result = await query(host, type, opts);
  const ttl = result.state === "unknown" ? FAILURE_TTL_MS : ANSWER_TTL_MS;
  cache.set(key, { expires: now + ttl, result });
  return result;
}

async function query(host: string, type: number, opts: DohOptions): Promise<DnsResult> {
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(host)}&type=${type}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DNS_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      headers: { accept: "application/dns-json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { state: "unknown", reason: `the DNS resolver returned HTTP ${res.status}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { state: "unknown", reason: "the DNS response was not valid JSON" };
    }
    return parseDohResponse(body, type);
  } catch (e) {
    const reason = isAbort(e)
      ? `the DNS lookup timed out after ${Math.round((opts.timeoutMs ?? DNS_TIMEOUT_MS) / 1000)}s`
      : `the DNS lookup failed (${e instanceof Error ? e.message : String(e)})`;
    return { state: "unknown", reason };
  } finally {
    clearTimeout(timer);
  }
}

function isAbort(e: unknown): boolean {
  return (
    !!e &&
    typeof e === "object" &&
    ((e as { name?: string }).name === "AbortError" ||
      (e as { name?: string }).name === "TimeoutError")
  );
}
