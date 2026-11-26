// Sending-domain rules.
//
// The bug: SMTP2GO's /domain/view record nests `{ fulldomain, subdomain,
// domain, suffix }` under `domain`, where `domain` is the FIRST LABEL. A picker
// that read `domain.domain` (and looked for `suffix` one level too high)
// offered and saved "localdentists" — a name with nothing to look up. These
// tests pin the rule that stops it: a sending domain always has a dot.

import { describe, expect, it } from "vitest";
import {
  domainFromEmail,
  isSendingDomain,
  normalizeSendingDomain,
  sendingDomainFromEmail,
  smtp2goRecordDomain,
} from "./domain";

describe("normalizeSendingDomain", () => {
  it("rejects a bare label — it is not a domain", () => {
    expect(normalizeSendingDomain("localdentists")).toBeNull();
    expect(normalizeSendingDomain("dentalscout")).toBeNull();
    expect(isSendingDomain("localdentists")).toBe(false);
  });

  it("lowercases, trims and strips a trailing dot", () => {
    expect(normalizeSendingDomain("  LocalDentists.AU.  ")).toBe("localdentists.au");
    expect(normalizeSendingDomain("Example.COM")).toBe("example.com");
  });

  it("keeps a multi-part TLD whole", () => {
    expect(normalizeSendingDomain("Something.COM.AU")).toBe("something.com.au");
    expect(normalizeSendingDomain("mail.dentalscout.com.au.")).toBe("mail.dentalscout.com.au");
  });

  it("rejects structural junk", () => {
    expect(normalizeSendingDomain("")).toBeNull();
    expect(normalizeSendingDomain("   ")).toBeNull();
    expect(normalizeSendingDomain(null)).toBeNull();
    expect(normalizeSendingDomain(42)).toBeNull();
    expect(normalizeSendingDomain("a@b.com")).toBeNull();
    expect(normalizeSendingDomain("two  spaces.com")).toBeNull();
    expect(normalizeSendingDomain(".leading.com")).toBeNull();
    expect(normalizeSendingDomain("double..dot.com")).toBeNull();
    expect(normalizeSendingDomain("trailing.")).toBeNull();
  });
});

describe("domainFromEmail", () => {
  it("takes everything after the @", () => {
    expect(domainFromEmail("listing@localdentists.au")).toBe("localdentists.au");
    expect(domainFromEmail("smile@DentalScout.COM.AU")).toBe("dentalscout.com.au");
  });

  it("accepts a display-name form", () => {
    expect(domainFromEmail("LocalDentists.au <listing@localdentists.au>")).toBe("localdentists.au");
  });

  it("returns null when there is no address", () => {
    expect(domainFromEmail("not-an-address")).toBeNull();
    expect(domainFromEmail("")).toBeNull();
    expect(domainFromEmail(null)).toBeNull();
  });

  it("only counts as a sending domain when it has a dot", () => {
    expect(sendingDomainFromEmail("root@localhost")).toBeNull();
    expect(sendingDomainFromEmail("listing@localdentists.au")).toBe("localdentists.au");
  });
});

describe("smtp2goRecordDomain", () => {
  /** The documented /domain/view shape: the parts are nested under `domain`. */
  const documented = {
    domain: {
      fulldomain: "localdentists.au",
      subdomain: null,
      domain: "localdentists", // the first label — never the answer on its own
      suffix: "au",
      dkim_selector: "s123456",
      dkim_verified: true,
    },
    trackers: [],
  };

  it("uses the record's full domain, not its first label", () => {
    expect(smtp2goRecordDomain(documented)).toBe("localdentists.au");
  });

  it("rebuilds from the parts when there is no fulldomain, keeping the whole suffix", () => {
    expect(
      smtp2goRecordDomain({ domain: { subdomain: null, domain: "something", suffix: "com.au" } }),
    ).toBe("something.com.au");
    expect(
      smtp2goRecordDomain({ domain: { subdomain: "link", domain: "something", suffix: "com.au" } }),
    ).toBe("link.something.com.au");
  });

  it("refuses a bare label wherever it appears", () => {
    // A flat `domain` string is only accepted when it is already a domain.
    expect(smtp2goRecordDomain({ domain: "localdentists" })).toBeNull();
    expect(smtp2goRecordDomain("localdentists")).toBeNull();
    // ...but a real flat domain is fine, and normalised.
    expect(smtp2goRecordDomain({ domain: "LocalDentists.AU." })).toBe("localdentists.au");
    expect(smtp2goRecordDomain("example.com.")).toBe("example.com");
  });

  it("reads the flat and domain_name shapes too", () => {
    expect(smtp2goRecordDomain({ fulldomain: "Example.COM" })).toBe("example.com");
    expect(smtp2goRecordDomain({ domain_name: "example.com" })).toBe("example.com");
    expect(smtp2goRecordDomain(null)).toBeNull();
    expect(smtp2goRecordDomain({})).toBeNull();
  });

  it("does not offer the truncation the old picker produced", () => {
    // The exact expression that caused the false alarm:
    //   [d.subdomain, d.domain.domain ?? d.domain, d.suffix].filter(Boolean).join(".")
    // with `suffix` read from the wrong level (it lives under `domain`),
    // yielding just "localdentists".
    const loose = documented as any;
    const old = [loose.subdomain, loose.domain.domain ?? loose.domain, loose.suffix]
      .filter(Boolean)
      .join(".");
    expect(old).toBe("localdentists");
    expect(isSendingDomain(old)).toBe(false);
    expect(smtp2goRecordDomain(documented)).not.toBe(old);
  });
});
