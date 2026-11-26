// The Worker-side orchestration: which domain gets checked, and how the DNS and
// SMTP2GO halves are put together. Uses injected fakes for both fetch paths, so
// nothing here touches the network.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DnsResult } from "../shared/deliverability";
import { clearDnsCache, type FetchLike } from "./dns";
import { checkDeliverability, resolveCheckDomain, resolveCheckDomainInfo } from "./deliverability";

/** The example sender-domain payload from SMTP2GO's /domain/view docs. */
const SMTP2GO_DOMAINS_PAYLOAD = {
  request_id: "e023461c-8c86-11e9-b984-408d5cce2644",
  data: {
    domains: [
      {
        domain: {
          fulldomain: "example.com",
          subdomain: null,
          domain: "example",
          suffix: "com",
          dkim_selector: "s123456",
          dkim_verified: true,
          dkim_status: "",
          dkim_value: "dkim.smtp2go.net",
          rpath_selector: "em744766",
          rpath_verified: true,
          rpath_status: "",
          rpath_value: "return.smtp2go.net",
          setup_link: "<url>",
        },
        trackers: [],
        subaccount_access: { subaccounts: [], future_subaccounts: false },
      },
    ],
  },
};

const NO_SMTP2GO = { SMTP2GO_API_KEY: "", DEFAULT_FROM_EMAIL: "hello@example.com" };

/** A DoH fetch that answers by (name, type) from a small table. */
function dohStub(table: Record<string, DnsResult>) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const name = new URL(url).searchParams.get("name") ?? "";
    const entry = table[name];
    if (!entry) return new Response(JSON.stringify({ Status: 3 }), { status: 200 });
    if (entry.state === "unknown") return new Response("boom", { status: 500 });
    const records = entry.state === "found" ? entry.records : [];
    const type = Number(new URL(url).searchParams.get("type"));
    return new Response(
      JSON.stringify({ Status: 0, Answer: records.map((data) => ({ name, type, data })) }),
      { status: 200 },
    );
  };
  return { fetchImpl, calls };
}

beforeEach(() => clearDnsCache());
afterEach(() => vi.unstubAllGlobals());

describe("resolveCheckDomain", () => {
  const env = { DEFAULT_FROM_EMAIL: "hello@default.test" };

  it("prefers the explicit domain", () => {
    expect(resolveCheckDomain(env, { domain: "Explicit.test", fromEmail: "a@other.test" })).toBe(
      "explicit.test",
    );
  });

  it("falls back to the From address's domain", () => {
    expect(resolveCheckDomain(env, { fromEmail: "Test <damon@from.test>" })).toBe("from.test");
  });

  it("falls back to DEFAULT_FROM_EMAIL's domain", () => {
    expect(resolveCheckDomain(env, {})).toBe("default.test");
  });

  it("returns null when there is nothing to check", () => {
    expect(resolveCheckDomain({}, {})).toBeNull();
    expect(resolveCheckDomain({ DEFAULT_FROM_EMAIL: "not-an-address" }, {})).toBeNull();
  });
});

describe("checkDeliverability", () => {
  it("refuses to invent a domain", async () => {
    const r = await checkDeliverability({ SMTP2GO_API_KEY: "", DEFAULT_FROM_EMAIL: "" }, {});
    expect(r).toEqual({ error: expect.stringContaining("no domain to check") });
  });

  it("reports the DKIM half as uncheckable when SMTP2GO is not configured", async () => {
    const { fetchImpl } = dohStub({
      "example.com": { state: "found", records: ['"v=spf1 -all"'] },
      "_dmarc.example.com": { state: "found", records: ['"v=DMARC1; p=none"'] },
    });
    const r = await checkDeliverability(NO_SMTP2GO, { domain: "example.com", fetchImpl });
    if ("error" in r) throw new Error(r.error);
    const dkim = r.checks.find((c) => c.id === "dkim")!;
    expect(dkim.state).toBe("unknown");
    expect(dkim.summary).toMatch(/Could not be checked/);
    // A missing API key must not be dressed up as a failed DKIM setup.
    expect(r.failures.map((c) => c.id)).not.toContain("dkim");
    expect(r.notChecked.join(" ")).toMatch(/SMTP2GO/);
    // MX was not in the table, so it is a genuine absence from the resolver.
    expect(r.checks.find((c) => c.id === "mx")!.state).toBe("fail");
  });

  it("reports the DKIM half as uncheckable when the SMTP2GO API errors", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const { fetchImpl } = dohStub({});
    const r = await checkDeliverability(
      { SMTP2GO_API_KEY: "key", DEFAULT_FROM_EMAIL: "" },
      { domain: "example.com", fetchImpl },
    );
    if ("error" in r) throw new Error(r.error);
    const dkim = r.checks.find((c) => c.id === "dkim")!;
    expect(dkim.state).toBe("unknown");
    expect(dkim.summary).toMatch(/the SMTP2GO API could not be read/);
  });

  it("passes the DKIM check when SMTP2GO's own records resolve", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify(SMTP2GO_DOMAINS_PAYLOAD), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { fetchImpl, calls } = dohStub({
      "example.com": { state: "found", records: ['"v=spf1 include:spf.smtp2go.com ~all"'] },
      "_dmarc.example.com": { state: "found", records: ['"v=DMARC1; p=reject; rua=mailto:d@example.com"'] },
      "s123456._domainkey.example.com": { state: "found", records: ["dkim.smtp2go.net."] },
      "em744766.example.com": { state: "found", records: ["return.smtp2go.net."] },
    });
    const r = await checkDeliverability(
      { SMTP2GO_API_KEY: "key", DEFAULT_FROM_EMAIL: "" },
      { domain: "example.com", fromEmail: "hello@example.com", fetchImpl },
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.checks.map((c) => c.id)).toEqual(["spf", "dkim", "dmarc", "mx", "alignment"]);
    expect(r.checks.find((c) => c.id === "dkim")!.state).toBe("pass");
    expect(r.checks.find((c) => c.id === "spf")!.state).toBe("pass");
    // p=reject is fine here because SPF and DKIM both pass.
    expect(r.checks.find((c) => c.id === "dmarc")!.state).toBe("pass");
    // It really did ask the resolver for the CNAMEs SMTP2GO specified.
    expect(calls.some((u) => u.includes("name=s123456._domainkey.example.com") && u.includes("type=5"))).toBe(true);
  });

  it("fails the DKIM check only when SMTP2GO answered and the domain is absent", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify(SMTP2GO_DOMAINS_PAYLOAD), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { fetchImpl } = dohStub({});
    const r = await checkDeliverability(
      { SMTP2GO_API_KEY: "key", DEFAULT_FROM_EMAIL: "" },
      { domain: "not-registered.test", fetchImpl },
    );
    if ("error" in r) throw new Error(r.error);
    const dkim = r.checks.find((c) => c.id === "dkim")!;
    expect(dkim.state).toBe("fail");
    expect(dkim.summary).toMatch(/not registered/);
  });

  it("keeps a resolver outage out of the failures list", async () => {
    const failing: FetchLike = async (url) => {
      const name = new URL(url).searchParams.get("name")!;
      if (name === "example.com") return new Response("nope", { status: 500 });
      return new Response(JSON.stringify({ Status: 2 }), { status: 200 });
    };
    const r = await checkDeliverability(NO_SMTP2GO, { domain: "example.com", fetchImpl: failing });
    if ("error" in r) throw new Error(r.error);
    expect(r.failures).toEqual([]);
    expect(r.complete).toBe(false);
    expect(r.checks.map((c) => c.summary).join(" ")).not.toMatch(/No SPF record|No DMARC record|No MX record/);
  });
});

describe("a stored value that is not a domain", () => {
  const env = { DEFAULT_FROM_EMAIL: "default@fallback.test" };

  it("is not used as the lookup name — the From domain is used instead", () => {
    expect(
      resolveCheckDomain(env, { domain: "localdentists", fromEmail: "listing@localdentists.au" }),
    ).toBe("localdentists.au");
  });

  it("reports that it fell back, and names the value it rejected", () => {
    expect(
      resolveCheckDomainInfo(env, { domain: "localdentists", fromEmail: "listing@localdentists.au" }),
    ).toEqual({ domain: "localdentists.au", source: "from_email", ignored: "localdentists" });
  });

  it("falls back to the default From domain, and still says so", () => {
    expect(resolveCheckDomainInfo(env, { domain: "localdentists" })).toEqual({
      domain: "fallback.test",
      source: "default_from",
      ignored: "localdentists",
    });
  });

  it("reports the campaign's own value as the source when it is a real domain", () => {
    expect(
      resolveCheckDomainInfo(env, { domain: "LocalDentists.AU.", fromEmail: "a@other.test" }),
    ).toEqual({ domain: "localdentists.au", source: "sending_domain", ignored: null });
  });

  it("checks the real domain end to end, and never the bogus apex", async () => {
    const { fetchImpl, calls } = dohStub({
      "localdentists.au": { state: "found", records: ['"v=spf1 include:spf.smtp2go.com ~all"'] },
      "_dmarc.localdentists.au": { state: "found", records: ['"v=DMARC1; p=quarantine"'] },
    });
    const r = await checkDeliverability(NO_SMTP2GO, {
      domain: "localdentists",
      fromEmail: "listing@localdentists.au",
      fetchImpl,
    });
    if ("error" in r) throw new Error(r.error);

    expect(r.domain).toBe("localdentists.au");
    expect(r.domainSource).toBe("from_email");
    expect(r.ignoredDomain).toBe("localdentists");
    // The three DNS questions were asked about the real domain...
    expect(calls.some((u) => u.includes("name=localdentists.au"))).toBe(true);
    // ...and `_dmarc` was built from the full domain, which is the whole point.
    expect(calls.some((u) => u.includes("name=_dmarc.localdentists.au"))).toBe(true);
    // Nothing was ever asked about the bare label.
    expect(calls.some((u) => /name=(_dmarc\.)?localdentists&/.test(u))).toBe(false);
  });
});
