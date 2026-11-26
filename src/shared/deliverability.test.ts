// DNS deliverability checks.
//
// The point of these tests is twofold:
//   1. the parsing rules are right (SPF, DKIM, DMARC, MX, alignment), and
//   2. the honesty contract holds — a lookup that FAILED is reported as
//      `unknown`, never as a missing record, because a resolver outage must not
//      read as "your SPF record is gone".

import { describe, expect, it } from "vitest";
import {
  SMTP2GO_DKIM_TARGET,
  SMTP2GO_RPATH_TARGET,
  SMTP2GO_SPF_INCLUDE,
  SPF_LOOKUP_LIMIT,
  alignmentCheck,
  buildDeliverability,
  cnameTargetMatches,
  countSpfLookups,
  decodeTxt,
  dkimCheck,
  dkimExpectations,
  dmarcCheck,
  domainOfEmail,
  failureLines,
  mxCheck,
  normalizeSmtp2goDomain,
  parseDmarc,
  parseDohResponse,
  parseMx,
  parseSpf,
  resolveDkimRecord,
  spfCheck,
  type DeliverabilityCheck,
  type DkimExpectation,
  type DnsResult,
} from "./deliverability";

const found = (...records: string[]): DnsResult => ({ state: "found", records });
const ABSENT: DnsResult = { state: "absent" };
const FAILED: DnsResult = { state: "unknown", reason: "the DNS lookup timed out after 5s" };

/** The example sender-domain entry from SMTP2GO's /domain/view docs. */
const SMTP2GO_DOMAINS_RESPONSE = {
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
        trackers: [
          {
            fulldomain: "link.example.com",
            subdomain: "link",
            domain: "example",
            suffix: "com",
            cname_verified: true,
            cname_status: "",
            cname_value: "track.smtp2go.net",
            enabled: true,
          },
        ],
        subaccount_access: { subaccounts: [], future_subaccounts: false },
      },
    ],
  },
};

function sampleSenderDomain() {
  const raw = (SMTP2GO_DOMAINS_RESPONSE.data.domains[0] as unknown);
  const d = normalizeSmtp2goDomain(raw);
  if (!d) throw new Error("fixture did not normalise");
  return d;
}

/* ───────────────────────────────── SPF ───────────────────────────────── */

describe("SPF parsing", () => {
  it("finds the SMTP2GO include mechanism", () => {
    const d = parseSpf([`v=spf1 include:${SMTP2GO_SPF_INCLUDE} ~all`]);
    expect(d.records).toHaveLength(1);
    expect(d.smtp2goInclude).toBe(true);
    expect(d.multiple).toBe(false);
  });

  it("matches the include case-insensitively and only as a whole host", () => {
    expect(parseSpf(["v=spf1 INCLUDE:SPF.SMTP2GO.COM -all"]).smtp2goInclude).toBe(true);
    // A lookalike host must not count as SMTP2GO authorisation.
    expect(parseSpf(["v=spf1 include:not-spf.smtp2go.com.evil.test -all"]).smtp2goInclude).toBe(false);
    expect(parseSpf(["v=spf1 include:_spf.google.com -all"]).smtp2goInclude).toBe(false);
  });

  it("ignores TXT records that are not SPF records", () => {
    const d = parseSpf(["google-site-verification=abc", `v=spf1 include:${SMTP2GO_SPF_INCLUDE} -all`, "hello"]);
    expect(d.records).toHaveLength(1);
  });

  it("reads the all qualifier", () => {
    expect(parseSpf(["v=spf1 ~all"]).allQualifier).toBe("~all");
    expect(parseSpf(["v=spf1 -all"]).allQualifier).toBe("-all");
    expect(parseSpf(["v=spf1 include:x.test"]).allQualifier).toBeNull();
  });

  it("counts lookup-costing mechanisms but not ip4/ip6/all", () => {
    expect(countSpfLookups("v=spf1 ip4:10.0.0.0/8 ip6:2001:db8::/32 -all")).toBe(0);
    expect(countSpfLookups("v=spf1 include:a.test include:b.test redirect=c.test mx a -all")).toBe(5);
    // A qualified mechanism still costs a lookup.
    expect(countSpfLookups("v=spf1 -include:a.test ~mx -all")).toBe(2);
  });
});

describe("the SPF check", () => {
  it("passes when the record authorises SMTP2GO", () => {
    const c = spfCheck(found(`v=spf1 include:${SMTP2GO_SPF_INCLUDE} ~all`));
    expect(c.state).toBe("pass");
    expect(c.summary).toContain(SMTP2GO_SPF_INCLUDE);
    expect(c.fix).toBeNull();
  });

  it("errors on more than one SPF record, because that breaks SPF outright", () => {
    const c = spfCheck(
      found(`v=spf1 include:${SMTP2GO_SPF_INCLUDE} ~all`, "v=spf1 include:_spf.google.com -all"),
    );
    expect(c.state).toBe("fail");
    expect(c.summary).toMatch(/2 SPF records/);
    expect(c.fix).toMatch(/single v=spf1 record/);
    expect(c.details).toHaveLength(2);
  });

  it("reports a genuinely missing record as a failure", () => {
    const c = spfCheck(ABSENT);
    expect(c.state).toBe("fail");
    expect(c.summary).toMatch(/No SPF record/);
    expect(c.fix).toContain(SMTP2GO_SPF_INCLUDE);
  });

  it("flags a lookup count that looks like it will exceed the 10-lookup limit", () => {
    const includes = Array.from({ length: 12 }, (_, i) => `include:s${i}.test`).join(" ");
    const c = spfCheck(found(`v=spf1 ${includes} -all`));
    expect(c.state).toBe("fail");
    expect(c.summary).toContain(`over ${SPF_LOOKUP_LIMIT}`);
    expect(c.fix).toMatch(/permerror|flatten/i);
  });

  it("does not flag a lookup count at exactly the limit", () => {
    const includes = Array.from({ length: 10 }, (_, i) => `include:s${i}.test`).join(" ");
    const c = spfCheck(found(`v=spf1 ${includes} -all`));
    // The authorisation is missing, but the lookup count itself is not the reason.
    expect(c.summary).not.toContain(`over ${SPF_LOOKUP_LIMIT}`);
  });

  it("fails a present record that does not authorise SMTP2GO either way", () => {
    const c = spfCheck(found("v=spf1 include:_spf.google.com -all"));
    expect(c.state).toBe("fail");
    expect(c.fix).toContain(SMTP2GO_SPF_INCLUDE);
  });

  it("accepts SMTP2GO's return-path CNAME in place of the TXT include", () => {
    const c = spfCheck(found("v=spf1 include:_spf.google.com -all"), { returnPathCnameResolves: true });
    expect(c.state).toBe("pass");
    expect(c.details.join(" ")).toMatch(/return-path CNAME is in place/);
  });

  it("reports a failed lookup as unknown, not as a missing record", () => {
    const c = spfCheck(FAILED);
    expect(c.state).toBe("unknown");
    expect(c.summary).toContain("Could not be checked");
    expect(c.summary).toContain("timed out");
    expect(c.summary).not.toMatch(/No SPF record/);
    expect(c.fix).toBeNull();
  });
});

/* ──────────────────────────────── DMARC ──────────────────────────────── */

describe("DMARC parsing", () => {
  it("reads the policy and the rua reporting address", () => {
    const d = parseDmarc(["v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com,mailto:other@example.com"]);
    expect(d.present).toBe(true);
    expect(d.policy).toBe("quarantine");
    expect(d.hasRua).toBe(true);
    expect(d.rua).toEqual(["mailto:dmarc@example.com", "mailto:other@example.com"]);
  });

  it("is case-insensitive and tolerates missing tags", () => {
    expect(parseDmarc(["v=dmarc1; P=REJECT"]).policy).toBe("reject");
    const bare = parseDmarc(["v=DMARC1; p=none"]);
    expect(bare.policy).toBe("none");
    expect(bare.hasRua).toBe(false);
    expect(bare.rua).toEqual([]);
  });

  it("ignores non-DMARC TXT records at _dmarc", () => {
    expect(parseDmarc(["some-other-txt"]).present).toBe(false);
  });

  it("detects a duplicate DMARC record", () => {
    expect(parseDmarc(["v=DMARC1; p=none", "v=DMARC1; p=reject"]).multiple).toBe(true);
  });
});

describe("the DMARC check", () => {
  it("fails when no record is published", () => {
    const c = dmarcCheck(ABSENT, { domain: "example.com" });
    expect(c.state).toBe("fail");
    expect(c.summary).toContain("_dmarc.example.com");
    expect(c.fix).toMatch(/v=DMARC1/);
  });

  it("passes a monitoring policy but says it is monitoring only", () => {
    const c = dmarcCheck(found("v=DMARC1; p=none; rua=mailto:dmarc@example.com"));
    expect(c.state).toBe("pass");
    expect(c.details.join(" ")).toMatch(/Monitoring only/);
  });

  it("flags p=reject with neither SPF nor DKIM in place", () => {
    const c = dmarcCheck(found("v=DMARC1; p=reject; rua=mailto:dmarc@example.com"), {
      spfOk: false,
      dkimOk: false,
    });
    expect(c.state).toBe("fail");
    expect(c.summary).toMatch(/p=reject with neither SPF nor DKIM/);
    expect(c.fix).toMatch(/quarantine|p=none/);
  });

  it("does not flag p=reject once SPF or DKIM is in place", () => {
    expect(dmarcCheck(found("v=DMARC1; p=reject"), { spfOk: true, dkimOk: false }).state).toBe("pass");
    expect(dmarcCheck(found("v=DMARC1; p=reject"), { spfOk: false, dkimOk: true }).state).toBe("pass");
  });

  it("reports a failed lookup as unknown, not as missing", () => {
    const c = dmarcCheck(FAILED, { spfOk: false, dkimOk: false });
    expect(c.state).toBe("unknown");
    expect(c.summary).not.toMatch(/No DMARC record/);
  });

  it("notices when rua reporting is absent", () => {
    const c = dmarcCheck(found("v=DMARC1; p=quarantine"));
    expect(c.state).toBe("pass");
    expect(c.details.join(" ")).toMatch(/rua.*not set/i);
  });
});

/* ───────────────────────────────── MX ───────────────────────────────── */

describe("MX parsing and check", () => {
  it("parses preference-ordered exchangers", () => {
    const d = parseMx(["20 mail2.example.com.", "10 mail.example.com."]);
    expect(d.hosts).toEqual([
      { preference: 10, host: "mail.example.com" },
      { preference: 20, host: "mail2.example.com" },
    ]);
    expect(d.nullMx).toBe(false);
  });

  it("recognises a null MX", () => {
    expect(parseMx(["0 ."]).nullMx).toBe(true);
  });

  it("passes when the domain can receive replies", () => {
    const c = mxCheck(found("10 mail.example.com."));
    expect(c.state).toBe("pass");
    expect(c.details[0]).toBe("10 mail.example.com");
  });

  it("fails when there is no MX, and says it is about replies not sending", () => {
    const c = mxCheck(ABSENT);
    expect(c.state).toBe("fail");
    expect(c.summary).toMatch(/cannot receive replies/);
    expect(c.details.join(" ")).toMatch(/Sending is unaffected/);
  });

  it("fails on an explicit null MX", () => {
    const c = mxCheck(found("0 ."));
    expect(c.state).toBe("fail");
    expect(c.summary).toMatch(/null MX/);
  });

  it("reports a failed lookup as unknown, not as missing", () => {
    const c = mxCheck(FAILED);
    expect(c.state).toBe("unknown");
    expect(c.summary).not.toMatch(/No MX record/);
  });
});

/* ───────────────────────────── DKIM / SMTP2GO ───────────────────────────── */

describe("DKIM expectations from the SMTP2GO domains API", () => {
  it("normalises the nested sender-domain shape", () => {
    const d = sampleSenderDomain();
    expect(d.fulldomain).toBe("example.com");
    expect(d.dkimSelector).toBe("s123456");
    expect(d.dkimValue).toBe(SMTP2GO_DKIM_TARGET);
    expect(d.dkimVerified).toBe(true);
    expect(d.rpathSelector).toBe("em744766");
    expect(d.rpathValue).toBe(SMTP2GO_RPATH_TARGET);
    expect(d.rpathVerified).toBe(true);
    expect(d.trackerHost).toBe("link.example.com");
  });

  it("derives exactly the CNAME records SMTP2GO asks for", () => {
    const exps = dkimExpectations(sampleSenderDomain());
    expect(exps).toEqual([
      { host: "s123456._domainkey.example.com", target: SMTP2GO_DKIM_TARGET, kind: "dkim" },
      { host: "em744766.example.com", target: SMTP2GO_RPATH_TARGET, kind: "return-path" },
      { host: "link.example.com", target: "track.smtp2go.net", kind: "tracking" },
    ]);
  });

  it("handles the older flat shape and rejects entries with no domain", () => {
    const flat = normalizeSmtp2goDomain({ domain: "legacy.example", dkim_verified: false });
    expect(flat?.fulldomain).toBe("legacy.example");
    expect(flat?.dkimVerified).toBe(false);
    expect(normalizeSmtp2goDomain({ status: "verified" })).toBeNull();
    expect(normalizeSmtp2goDomain(null)).toBeNull();
  });

  it("compares CNAME targets ignoring case and the trailing dot", () => {
    expect(cnameTargetMatches("DKIM.SMTP2GO.NET.", "dkim.smtp2go.net")).toBe(true);
    expect(cnameTargetMatches("something.else.test", "dkim.smtp2go.net")).toBe(false);
    expect(cnameTargetMatches(null, "dkim.smtp2go.net")).toBe(false);
  });
});

describe("resolving each expected DKIM CNAME", () => {
  const exp: DkimExpectation = {
    host: "s123456._domainkey.example.com",
    target: SMTP2GO_DKIM_TARGET,
    kind: "dkim",
  };

  it("passes when it resolves to the asked-for target", () => {
    const r = resolveDkimRecord(exp, found("dkim.smtp2go.net."));
    expect(r.state).toBe("pass");
    expect(r.detail).toContain("s123456._domainkey.example.com → dkim.smtp2go.net.");
  });

  it("fails when the name is genuinely not published", () => {
    const r = resolveDkimRecord(exp, ABSENT);
    expect(r.state).toBe("fail");
    expect(r.detail).toMatch(/is not published/);
  });

  it("fails when it points somewhere else, and says where", () => {
    const r = resolveDkimRecord(exp, found("wrong.target.test."));
    expect(r.state).toBe("fail");
    expect(r.detail).toContain("points to wrong.target.test. instead of dkim.smtp2go.net");
  });

  it("is unknown — not a failure — when the lookup failed", () => {
    const r = resolveDkimRecord(exp, FAILED);
    expect(r.state).toBe("unknown");
    expect(r.detail).toContain("Could not be checked");
  });
});

describe("the DKIM check", () => {
  const sd = sampleSenderDomain();
  const pass = resolveDkimRecord(
    { host: "s123456._domainkey.example.com", target: SMTP2GO_DKIM_TARGET, kind: "dkim" },
    found("dkim.smtp2go.net."),
  );

  it("passes when every record resolves and SMTP2GO reports the domain verified", () => {
    const c = dkimCheck({ senderDomain: sd, records: [pass] });
    expect(c.state).toBe("pass");
    expect(c.summary).toMatch(/verified/);
    expect(c.details.join(" ")).toMatch(/DKIM: verified/);
  });

  it("fails when a record does not resolve", () => {
    const bad = resolveDkimRecord(pass, ABSENT);
    const c = dkimCheck({ senderDomain: sd, records: [pass, bad] });
    expect(c.state).toBe("fail");
    expect(c.summary).toMatch(/1 of 2/);
  });

  it("says the SMTP2GO half could not be checked when the API is unreadable", () => {
    const c = dkimCheck({
      senderDomain: null,
      records: [],
      error: "the SMTP2GO API could not be read (SMTP2GO 500: boom)",
    });
    expect(c.state).toBe("unknown");
    expect(c.summary).toMatch(/Could not be checked/);
    expect(c.state).not.toBe("fail");
  });

  it("fails only when SMTP2GO answered and the domain is not on the account", () => {
    const c = dkimCheck({ senderDomain: null, records: [], notRegistered: true });
    expect(c.state).toBe("fail");
    expect(c.summary).toMatch(/not registered/);
  });

  it("is unknown, not failed, when some lookups failed and none failed hard", () => {
    const unknown = resolveDkimRecord(pass, FAILED);
    const c = dkimCheck({ senderDomain: sd, records: [pass, unknown] });
    expect(c.state).toBe("unknown");
  });

  it("asks SMTP2GO to verify when its own state still says unverified", () => {
    const unverified = { ...sd, dkimVerified: false, rpathVerified: false };
    const c = dkimCheck({ senderDomain: unverified, records: [pass] });
    expect(c.state).toBe("pass");
    expect(c.fix).toMatch(/Verify/);
  });
});

/* ──────────────────────────── alignment ──────────────────────────── */

describe("From / DKIM alignment", () => {
  it("passes when the From domain is the signed domain", () => {
    const c = alignmentCheck("example.com", "example.com");
    expect(c.state).toBe("pass");
  });

  it("fails when the From domain is not the domain SMTP2GO signs as", () => {
    const c = alignmentCheck("mail.example.com", "example.com");
    expect(c.state).toBe("fail");
    expect(c.summary).toMatch(/DMARC alignment fails/);
    expect(c.fix).toContain("mail.example.com");
  });

  it("is unknown when either domain is not known", () => {
    expect(alignmentCheck(null, "example.com").state).toBe("unknown");
    expect(alignmentCheck("example.com", null).state).toBe("unknown");
  });
});

describe("domainOfEmail", () => {
  it("reads a bare address and a display-name form", () => {
    expect(domainOfEmail("hello@LocalDentists.au")).toBe("localdentists.au");
    expect(domainOfEmail("Test <test@example.com>")).toBe("example.com");
  });

  it("returns null when there is no address", () => {
    expect(domainOfEmail("")).toBeNull();
    expect(domainOfEmail(null)).toBeNull();
    expect(domainOfEmail("not-an-address")).toBeNull();
  });
});

/* ───────────────────────── DoH wire parsing ───────────────────────── */

describe("parsing the Cloudflare DoH response", () => {
  it("reads TXT answers and joins quoted chunks into the record they represent", () => {
    const r = parseDohResponse(
      {
        Status: 0,
        Answer: [
          { name: "example.com", type: 16, data: '"v=spf1 include:spf.smtp2go.com " "~all"' },
        ],
      },
      16,
    );
    expect(r).toEqual({ state: "found", records: ["v=spf1 include:spf.smtp2go.com ~all"] });
  });

  it("treats NOERROR with no answers of the type as a genuine absence", () => {
    expect(parseDohResponse({ Status: 0, Answer: [{ type: 5, data: "x.test." }] }, 16)).toEqual({
      state: "absent",
    });
    expect(parseDohResponse({ Status: 0 }, 16)).toEqual({ state: "absent" });
  });

  it("treats NXDOMAIN as a genuine absence", () => {
    expect(parseDohResponse({ Status: 3 }, 16)).toEqual({ state: "absent" });
  });

  it("treats SERVFAIL and other statuses as a failed lookup, quoting the resolver", () => {
    const r = parseDohResponse({ Status: 2, Comment: ["EDE(18): Prohibited"] }, 16);
    expect(r.state).toBe("unknown");
    if (r.state === "unknown") {
      expect(r.reason).toContain("SERVFAIL");
      expect(r.reason).toContain("Prohibited");
    }
  });

  it("treats an unreadable body as a failed lookup", () => {
    expect(parseDohResponse(null, 16).state).toBe("unknown");
    expect(parseDohResponse("nope", 16).state).toBe("unknown");
    expect(parseDohResponse({}, 16).state).toBe("unknown");
  });

  it("decodes a TXT RDATA into the record it represents", () => {
    expect(decodeTxt('"v=spf1 -all"')).toBe("v=spf1 -all");
    expect(decodeTxt("v=spf1 -all")).toBe("v=spf1 -all");
    expect(decodeTxt('"part1" "part2"')).toBe("part1part2");
  });
});

/* ─────────────────────────── the whole result ─────────────────────────── */

describe("buildDeliverability", () => {
  const healthy = buildDeliverability({
    domain: "example.com",
    fromDomain: "example.com",
    spf: found(`v=spf1 include:${SMTP2GO_SPF_INCLUDE} ~all`),
    dmarc: found("v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"),
    mx: found("10 mail.example.com."),
    dkim: {
      senderDomain: sampleSenderDomain(),
      records: [
        resolveDkimRecord(
          { host: "s123456._domainkey.example.com", target: SMTP2GO_DKIM_TARGET, kind: "dkim" },
          found("dkim.smtp2go.net."),
        ),
        resolveDkimRecord(
          { host: "em744766.example.com", target: SMTP2GO_RPATH_TARGET, kind: "return-path" },
          found("return.smtp2go.net."),
        ),
      ],
    },
    checkedAt: 1_700_000_000,
  });

  it("passes every check on a fully configured domain", () => {
    expect(healthy.checks.map((c) => c.state)).toEqual(["pass", "pass", "pass", "pass", "pass"]);
    expect(healthy.failures).toEqual([]);
    expect(healthy.complete).toBe(true);
    expect(healthy.checkedAt).toBe(1_700_000_000);
  });

  it("is ordered SPF, DKIM, DMARC, MX, alignment", () => {
    expect(healthy.checks.map((c) => c.id)).toEqual(["spf", "dkim", "dmarc", "mx", "alignment"]);
  });

  it("collects the failures and the checks it could not make", () => {
    const r = buildDeliverability({
      domain: "example.com",
      fromDomain: "other.test",
      spf: ABSENT,
      dmarc: ABSENT,
      mx: FAILED,
      dkim: { senderDomain: null, records: [], error: "SMTP2GO is not configured (SMTP2GO_API_KEY unset)" },
    });
    expect(r.failures.map((c) => c.id)).toEqual(["spf", "dmarc"]);
    // Alignment needs the DKIM-signed domain, so an unreadable SMTP2GO half
    // leaves it unknown rather than guessing a mismatch.
    expect(r.checks.find((c) => c.id === "alignment")!.state).toBe("unknown");
    expect(r.complete).toBe(false);
    expect(r.notChecked.length).toBeGreaterThan(0);
    expect(r.notChecked.join(" ")).toMatch(/SMTP2GO/);
  });

  it("does not let an outage read as missing records anywhere in the result", () => {
    const r = buildDeliverability({
      domain: "example.com",
      fromDomain: "example.com",
      spf: FAILED,
      dmarc: FAILED,
      mx: FAILED,
      dkim: { senderDomain: null, records: [], error: "the SMTP2GO API could not be read (500)" },
    });
    expect(r.failures).toEqual([]);
    expect(r.checks.every((c) => c.state === "unknown")).toBe(true);
    expect(r.checks.map((c) => c.summary).join(" ")).not.toMatch(/No SPF record|No DMARC record|No MX record/);
  });

  it("renders failures as confirm-dialog lines", () => {
    const lines = failureLines(healthy);
    expect(lines).toEqual([]);
    const failing: DeliverabilityCheck = {
      id: "spf",
      title: "SPF",
      state: "fail",
      summary: "No SPF record published at the sending domain.",
      fix: "Publish one.",
      details: [],
    };
    expect(failureLines({ ...healthy, failures: [failing] })).toEqual([
      "• SPF: No SPF record published at the sending domain.",
    ]);
  });
});
