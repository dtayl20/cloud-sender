// The sending-domain fallback, at the shared builder level.
//
// `buildDeliverability` has to carry two extra facts out to the panel: how the
// checked domain was chosen, and the stored value that was rejected because it
// is not a domain. Without those the panel cannot say it fell back, and a
// silent fallback is how the original false alarm stayed invisible.

import { describe, expect, it } from "vitest";
import { buildDeliverability, dmarcCheck } from "./deliverability";

const ABSENT = { state: "absent" } as const;

function result(over: Partial<Parameters<typeof buildDeliverability>[0]> = {}) {
  return buildDeliverability({
    domain: "localdentists.au",
    fromDomain: "localdentists.au",
    spf: ABSENT,
    dmarc: ABSENT,
    mx: ABSENT,
    dkim: { senderDomain: null, records: [], error: "SMTP2GO is not configured" },
    ...over,
  });
}

describe("buildDeliverability domain provenance", () => {
  it("defaults to the campaign's own sending domain", () => {
    const r = result();
    expect(r.domain).toBe("localdentists.au");
    expect(r.domainSource).toBe("sending_domain");
    expect(r.ignoredDomain).toBeNull();
  });

  it("carries the fallback and the rejected value out to the caller", () => {
    const r = result({ domainSource: "from_email", ignoredDomain: "localdentists" });
    expect(r.domain).toBe("localdentists.au");
    expect(r.domainSource).toBe("from_email");
    expect(r.ignoredDomain).toBe("localdentists");
  });
});

describe("DMARC is built from the full domain", () => {
  it("names _dmarc.<full domain>, not the first label", () => {
    const c = dmarcCheck(ABSENT, { domain: "localdentists.au" });
    expect(c.state).toBe("fail");
    expect(c.summary).toContain("_dmarc.localdentists.au");
    expect(c.summary).not.toMatch(/_dmarc\.localdentists\b(?!\.)/);
  });

  it("keeps a multi-part TLD whole", () => {
    expect(dmarcCheck(ABSENT, { domain: "something.com.au" }).summary).toContain(
      "_dmarc.something.com.au",
    );
  });
});
