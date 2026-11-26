// The DNS-over-HTTPS client.
//
// The important property here is the one from src/shared/deliverability.ts: a
// lookup that FAILS produces `unknown`, while a resolver that answers "there is
// nothing there" produces `absent`. A network problem must never be reported as
// a missing record.

import { beforeEach, describe, expect, it } from "vitest";
import { DNS_TYPE } from "../shared/deliverability";
import {
  ANSWER_TTL_MS,
  DNS_TIMEOUT_MS,
  FAILURE_TTL_MS,
  clearDnsCache,
  dohLookup,
  normalizeName,
  type FetchLike,
} from "./dns";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/dns-json" },
  });
}

/** A fetch that records its calls and answers from a fixed map. */
function stubFetch(responses: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    return responses(url);
  };
  return { fetchImpl, calls };
}

beforeEach(() => clearDnsCache());

describe("dohLookup", () => {
  it("returns the records a NOERROR answer carries", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({
        Status: 0,
        Answer: [{ name: "example.com", type: 16, data: '"v=spf1 -all"' }],
      }),
    );
    const r = await dohLookup("example.com", DNS_TYPE.TXT, { fetchImpl });
    // Cloudflare quotes TXT RDATA; the client hands back the record itself.
    expect(r).toEqual({ state: "found", records: ["v=spf1 -all"] });
  });

  it("asks Cloudflare for the right name, type and accepted format", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse({ Status: 0 }));
    await dohLookup("_dmarc.Example.com", DNS_TYPE.TXT, { fetchImpl });
    expect(calls[0]).toBe(
      "https://cloudflare-dns.com/dns-query?name=_dmarc.example.com&type=16",
    );
  });

  it("reports NXDOMAIN as absent — a genuine absence, not a failure", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ Status: 3 }));
    expect(await dohLookup("nope.test", DNS_TYPE.TXT, { fetchImpl })).toEqual({ state: "absent" });
  });

  it("reports a network error as unknown, never as absent", async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    const r = await dohLookup("example.com", DNS_TYPE.TXT, { fetchImpl });
    expect(r.state).toBe("unknown");
    if (r.state === "unknown") expect(r.reason).toMatch(/the DNS lookup failed/);
  });

  it("reports an HTTP error as unknown, never as absent", async () => {
    const { fetchImpl } = stubFetch(() => new Response("upstream down", { status: 503 }));
    const r = await dohLookup("example.com", DNS_TYPE.TXT, { fetchImpl });
    expect(r.state).toBe("unknown");
    if (r.state === "unknown") expect(r.reason).toContain("HTTP 503");
  });

  it("reports unreadable JSON as unknown, never as absent", async () => {
    const { fetchImpl } = stubFetch(() => new Response("<html>not json</html>", { status: 200 }));
    const r = await dohLookup("example.com", DNS_TYPE.TXT, { fetchImpl });
    expect(r.state).toBe("unknown");
    if (r.state === "unknown") expect(r.reason).toMatch(/not valid JSON/);
  });

  it("reports a timeout as unknown, with the timeout in the reason", async () => {
    // Mirrors real fetch: the request rejects when the signal aborts.
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    const r = await dohLookup("example.com", DNS_TYPE.TXT, { fetchImpl, timeoutMs: 5 });
    expect(r.state).toBe("unknown");
    if (r.state === "unknown") expect(r.reason).toMatch(/timed out/);
  });

  it("has a sensible default timeout", () => {
    expect(DNS_TIMEOUT_MS).toBe(5000);
  });
});

describe("the isolate cache", () => {
  it("reuses an answer instead of re-asking the resolver", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse({ Status: 0, Answer: [{ type: 16, data: '"v=spf1 -all"' }] }),
    );
    await dohLookup("example.com", DNS_TYPE.TXT, { fetchImpl, now: 1000 });
    await dohLookup("example.com", DNS_TYPE.TXT, { fetchImpl, now: 1000 + 1000 });
    expect(calls).toHaveLength(1);
  });

  it("expires a successful answer after the answer TTL", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse({ Status: 0 }));
    await dohLookup("example.com", DNS_TYPE.TXT, { fetchImpl, now: 1000 });
    await dohLookup("example.com", DNS_TYPE.TXT, { fetchImpl, now: 1000 + ANSWER_TTL_MS + 1 });
    expect(calls).toHaveLength(2);
  });

  it("expires a failure sooner, so a resolver blip clears quickly", async () => {
    const { fetchImpl, calls } = stubFetch(() => {
      throw new Error("network");
    });
    await dohLookup("example.com", DNS_TYPE.TXT, { fetchImpl, now: 1000 });
    // Still cached a minute in, and well before the answer TTL.
    await dohLookup("example.com", DNS_TYPE.TXT, { fetchImpl, now: 1000 + FAILURE_TTL_MS - 1 });
    expect(calls).toHaveLength(1);
    const afterFailureTtl = 1000 + FAILURE_TTL_MS + 1;
    await dohLookup("example.com", DNS_TYPE.TXT, { fetchImpl, now: afterFailureTtl });
    expect(calls).toHaveLength(2);
    expect(afterFailureTtl).toBeLessThan(1000 + ANSWER_TTL_MS);
  });

  it("caches a genuine absence too, since 'nothing published' is also an answer", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse({ Status: 3 }));
    await dohLookup("example.com", DNS_TYPE.TXT, { fetchImpl, now: 1000 });
    await dohLookup("example.com", DNS_TYPE.TXT, { fetchImpl, now: 1000 + 1000 });
    expect(calls).toHaveLength(1);
  });

  it("keeps different record types apart", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse({ Status: 0 }));
    await dohLookup("example.com", DNS_TYPE.TXT, { fetchImpl, now: 1000 });
    await dohLookup("example.com", DNS_TYPE.MX, { fetchImpl, now: 1000 });
    expect(calls).toHaveLength(2);
  });

  it("can be bypassed for a manual re-check", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse({ Status: 0 }));
    await dohLookup("example.com", DNS_TYPE.TXT, { fetchImpl, now: 1000 });
    await dohLookup("example.com", DNS_TYPE.TXT, { fetchImpl, now: 1000, noCache: true });
    expect(calls).toHaveLength(2);
  });
});

describe("normalizeName", () => {
  it("lowercases and strips the trailing root dot", () => {
    expect(normalizeName("  Example.COM. ")).toBe("example.com");
  });

  it("returns an empty string for an empty name, which the caller treats as unknown", async () => {
    expect(normalizeName("")).toBe("");
    const r = await dohLookup("  ", DNS_TYPE.TXT);
    expect(r.state).toBe("unknown");
  });
});
