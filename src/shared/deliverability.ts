/**
 * DNS deliverability checks — SPF, DKIM, DMARC, MX and From/DKIM alignment.
 *
 * Why this exists: the pre-send spam check (src/shared/spamCheck.ts) can only
 * judge content. Inbox placement is mostly decided by authentication — whether
 * the sending domain authorises SMTP2GO (SPF), whether it is signed (DKIM),
 * whether receivers are told what to do with a failure (DMARC), and whether the
 * From domain and the signed domain line up. Those are all DNS questions, so
 * they are answered here.
 *
 * Two honesty rules run through everything below, and they matter more than the
 * checks themselves:
 *
 *   1. A lookup that FAILS (timeout, SERVFAIL, no network, bad JSON) is
 *      reported as `unknown` — never as a missing record. The `DnsResult` union
 *      exists for exactly this reason: `absent` means "the resolver answered,
 *      and there is genuinely nothing published", which is a real finding.
 *      `unknown` means "we could not ask", which is not.
 *   2. If SMTP2GO is not configured or its API errors, the DKIM/verification
 *      half is reported as not checked, not as failed.
 *
 * No email content is sent anywhere. Only domain names are queried, and only
 * against a DNS-over-HTTPS resolver. There is deliberately no third-party
 * scanning service.
 *
 * No Worker, React or DB imports here, so the Worker route and the React panels
 * share one implementation and the parsing is unit-testable against canned DNS
 * answers.
 */

import { domainFromEmail } from "./domain";

/* ───────────────────────── the DNS answer contract ───────────────────────── */

/**
 * The outcome of one DNS question.
 *
 * `absent` and `unknown` are deliberately different types, not two flavours of
 * an empty list: collapsing them is how a resolver outage turns into a false
 * "your SPF record is missing" alarm.
 */
export type DnsResult =
  | { state: "found"; records: string[] }
  | { state: "absent" }
  | { state: "unknown"; reason: string };

/** Pass / fail / unknown for one check, as the panel shows it. */
export type CheckState = "pass" | "fail" | "unknown";

/**
 * Where the checked domain came from. `sending_domain` is the campaign's own
 * value; the other two are fallbacks, and the panel says so out loud rather
 * than silently checking a name the user did not choose.
 */
export type DomainSource = "sending_domain" | "from_email" | "default_from";

export type DeliverabilityCheckId = "spf" | "dkim" | "dmarc" | "mx" | "alignment";

export interface DeliverabilityCheck {
  id: DeliverabilityCheckId;
  title: string;
  state: CheckState;
  /** One line: what was found. */
  summary: string;
  /** One line: what to do. Null when there is nothing to fix. */
  fix: string | null;
  /** Supporting lines (the record, the mechanism matched, counts). */
  details: string[];
}

export interface DeliverabilityResult {
  /** The domain the records were looked up on (the sending domain). */
  domain: string;
  /** How that domain was chosen (see DomainSource). */
  domainSource: DomainSource;
  /**
   * The stored sending-domain value that was rejected because it is not a
   * domain (no dot), when there was one. The panel names it; null when the
   * checked domain was the one the caller asked for.
   */
  ignoredDomain: string | null;
  /** The From-header domain, when the caller supplied one. */
  fromDomain: string | null;
  checks: DeliverabilityCheck[];
  /** Only the checks that FAILED — the pre-send confirm lists these. */
  failures: DeliverabilityCheck[];
  /** Checks that could not be answered at all, with the reason. */
  notChecked: string[];
  /** True when no check came back `unknown`. */
  complete: boolean;
  /** Unix seconds, so the panel can say when it last looked. */
  checkedAt: number;
}

/* ─────────────────────────── DNS-over-HTTPS parsing ─────────────────────────── */

export const DNS_TYPE = { TXT: 16, MX: 15, CNAME: 5 } as const;

/** The subset of Cloudflare's DNS-over-HTTPS JSON response we rely on. */
export interface DohResponse {
  /** 0 = NOERROR, 2 = SERVFAIL, 3 = NXDOMAIN. */
  Status?: number;
  Answer?: { name?: string; type?: number; TTL?: number; data?: string }[];
  /** Extended DNS Error notes; the resolver's own explanation when it has one. */
  Comment?: string[];
}

/** Cloudflare's wire format for a TXT RDATA is a sequence of quoted chunks. */
export function decodeTxt(data: string): string {
  const chunks: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(data)) !== null) chunks.push(m[1].replace(/\\(.)/g, "$1"));
  return (chunks.length ? chunks.join("") : data).trim();
}

/**
 * Turn a DoH response into a `DnsResult`, keeping "the name does not exist"
 * (NXDOMAIN / NOERROR with no records of this type) apart from "the lookup
 * failed" (anything we cannot read, or a non-NOERROR status other than
 * NXDOMAIN).
 */
export function parseDohResponse(body: unknown, type: number): DnsResult {
  if (!body || typeof body !== "object") {
    return { state: "unknown", reason: "the DNS response was not readable" };
  }
  const res = body as DohResponse;
  const status = res.Status;
  if (typeof status !== "number") {
    return { state: "unknown", reason: "the DNS response had no status" };
  }
  // 3 is NXDOMAIN: the resolver answered, and the name genuinely does not exist.
  // 0 is NOERROR. Anything else (2 SERVFAIL, 5 REFUSED, ...) is a failure.
  if (status !== 0 && status !== 3) {
    const note = res.Comment?.[0] ? ` (${res.Comment[0]})` : "";
    return {
      state: "unknown",
      reason: `the resolver returned ${rcodeName(status)}${note}`,
    };
  }
  if (status === 3) return { state: "absent" };

  const answers = (res.Answer ?? []).filter((a) => a && a.type === type && typeof a.data === "string");
  if (!answers.length) return { state: "absent" };
  // TXT RDATA arrives as quoted chunks on the wire ("part1" "part2"), so it is
  // decoded here and every consumer sees the record itself rather than the
  // wire encoding — a `^v=spf1` match against a leading quote would silently
  // find no SPF record at all.
  const records = answers.map((a) => {
    const data = String(a.data).trim();
    return type === DNS_TYPE.TXT ? decodeTxt(data) : data;
  });
  return { state: "found", records };
}

function rcodeName(status: number): string {
  const names: Record<number, string> = {
    1: "FORMERR",
    2: "SERVFAIL",
    3: "NXDOMAIN",
    4: "NOTIMP",
    5: "REFUSED",
  };
  return names[status] ?? `status ${status}`;
}

/* ──────────────────────────────── SPF ──────────────────────────────── */

/**
 * The include mechanism SMTP2GO documents for an SPF TXT record. Matched
 * case-insensitively as `include:spf.smtp2go.com` (that host publishes its own
 * SPF record — verified live against the resolver). SMTP2GO's *current*
 * documented setup, however, authenticates SPF through a return-path CNAME
 * rather than a TXT include, so a resolving return-path CNAME counts as
 * authorisation too (see SMTP2GO_RPATH_TARGET below).
 */
export const SMTP2GO_SPF_INCLUDE = "spf.smtp2go.com";

/** Target of the return-path CNAME SMTP2GO asks for (`<rpath_selector>.<domain>`). */
export const SMTP2GO_RPATH_TARGET = "return.smtp2go.net";

/** Target of the DKIM CNAME SMTP2GO asks for (`<dkim_selector>._domainkey.<domain>`). */
export const SMTP2GO_DKIM_TARGET = "dkim.smtp2go.net";

/**
 * RFC 7208 §4.6.4: a record may cause at most 10 DNS lookups before it is a
 * permerror. Exceeding it silently breaks SPF for every receiver, so it is
 * reported with the same severity as a missing record.
 */
export const SPF_LOOKUP_LIMIT = 10;

export interface SpfDetails {
  /** Every `v=spf1` TXT record published at the apex. */
  records: string[];
  /** More than one SPF record: SPF then fails outright for every receiver. */
  multiple: boolean;
  /** The SMTP2GO include mechanism was found in the record. */
  smtp2goInclude: boolean;
  /**
   * Lookup-costing mechanisms counted, best-effort. Nested includes are NOT
   * followed, so this is a lower bound — it under-counts, never over-counts.
   */
  lookupCount: number;
  overLookupLimit: boolean;
  /** The all mechanism's qualifier, e.g. "-all", "~all", "?all", "+all". */
  allQualifier: string | null;
}

/** Every TXT record at the apex that is an SPF record (case-insensitive `v=spf1`). */
export function spfRecords(txtRecords: readonly string[]): string[] {
  return txtRecords.filter((r) => /^v=spf1(?:\s|$)/i.test(r.trim()));
}

/**
 * Count the mechanisms that cost a DNS lookup. `include:` and `redirect=` are
 * the two that matter in practice; `exists:`/`a`/`mx`/`ptr` are counted too so
 * a record that leans on them is not reported as cheap. Macros and nested
 * includes are not expanded.
 */
export function countSpfLookups(record: string): number {
  let count = 0;
  for (const token of record.trim().split(/\s+/)) {
    const t = token.replace(/^[+\-~?]/, "");
    if (!t) continue;
    if (/^(?:include|exists):/i.test(t) || /^redirect[=:]/i.test(t)) count++;
    else if (/^(?:a|mx|ptr)(?::|\/|$)/i.test(t)) count++;
    else if (/^(?:a|mx)$/i.test(t)) count++;
  }
  return count;
}

/** Parse the SPF records published at a domain. Takes every TXT record at the apex. */
export function parseSpf(txtRecords: readonly string[]): SpfDetails {
  const records = spfRecords(txtRecords);
  const first = records[0] ?? "";
  const lookupCount = records.reduce((n, r) => n + countSpfLookups(r), 0);
  const all = /([+\-~?])all\b/i.exec(first);
  return {
    records,
    multiple: records.length > 1,
    smtp2goInclude: records.some((r) => /include:spf\.smtp2go\.com\b/i.test(r)),
    lookupCount,
    overLookupLimit: records.length === 1 && lookupCount > SPF_LOOKUP_LIMIT,
    allQualifier: all ? `${all[1]}all` : null,
  };
}

/**
 * The SPF check. `returnPathCnameResolves` is the outcome of the SMTP2GO
 * return-path CNAME lookup (see `deliverability` orchestration): when it is in
 * place SMTP2GO authorises the envelope sender without a TXT include, so a
 * record that omits `include:spf.smtp2go.com` is not reported as a failure.
 */
export function spfCheck(
  dns: DnsResult,
  opts: { returnPathCnameResolves?: boolean } = {},
): DeliverabilityCheck {
  const base = { id: "spf" as const, title: "SPF" };
  if (dns.state === "unknown") {
    return {
      ...base,
      state: "unknown",
      summary: `Could not be checked — ${dns.reason}.`,
      fix: null,
      details: [],
    };
  }
  const details = parseSpf(dns.state === "found" ? dns.records : []);

  if (!details.records.length) {
    return {
      ...base,
      state: "fail",
      summary: "No SPF record published at the sending domain.",
      fix:
        `Publish one TXT record at the domain apex: v=spf1 include:${SMTP2GO_SPF_INCLUDE} ~all ` +
        "(or keep SMTP2GO's return-path CNAME, which authorises the envelope sender instead).",
      details: [],
    };
  }

  if (details.multiple) {
    return {
      ...base,
      state: "fail",
      summary: `${details.records.length} SPF records published — SPF fails whenever more than one exists.`,
      fix: "Merge them into a single v=spf1 record; a domain may only publish one.",
      details: details.records,
    };
  }

  if (details.overLookupLimit) {
    return {
      ...base,
      state: "fail",
      summary: `${details.lookupCount} lookup-costing mechanisms in the record (over ${SPF_LOOKUP_LIMIT}).`,
      fix: "Flatten the record or remove unused includes — over 10 lookups is a permerror, so SPF stops protecting anything.",
      details: [details.records[0], `Qualifier: ${details.allQualifier ?? "none"}`],
    };
  }

  if (!details.smtp2goInclude) {
    if (opts.returnPathCnameResolves) {
      return {
        ...base,
        state: "pass",
        summary: "SPF record published; SMTP2GO authorises the envelope sender through its return-path CNAME.",
        fix: null,
        details: [
          details.records[0],
          `No include:${SMTP2GO_SPF_INCLUDE}, but the SMTP2GO return-path CNAME is in place.`,
        ],
      };
    }
    return {
      ...base,
      state: "fail",
      summary: `The SPF record does not authorise SMTP2GO (no include:${SMTP2GO_SPF_INCLUDE}).`,
      fix: `Add include:${SMTP2GO_SPF_INCLUDE} to the record, or publish SMTP2GO's return-path CNAME.`,
      details: [details.records[0]],
    };
  }

  return {
    ...base,
    state: "pass",
    summary: `SPF record published and authorises SMTP2GO via include:${SMTP2GO_SPF_INCLUDE}.`,
    fix: null,
    details: [
      details.records[0],
      `Qualifier: ${details.allQualifier ?? "none"}`,
      `Lookup-costing mechanisms: ${details.lookupCount} of ${SPF_LOOKUP_LIMIT} (best-effort, nested includes not followed)`,
    ],
  };
}

/* ──────────────────────────────── DMARC ──────────────────────────────── */

export type DmarcPolicy = "none" | "quarantine" | "reject";

export interface DmarcDetails {
  present: boolean;
  record: string | null;
  policy: DmarcPolicy | null;
  /** Reporting URIs from rua=. */
  rua: string[];
  hasRua: boolean;
  /** More than one DMARC record is itself an error. */
  multiple: boolean;
}

/** Parse the TXT records published at `_dmarc.<domain>`. */
export function parseDmarc(txtRecords: readonly string[]): DmarcDetails {
  const records = txtRecords
    .map((r) => r.trim())
    .filter((r) => /^v=DMARC1(?:\s*;|$)/i.test(r));
  const record = records[0] ?? null;
  const policyTag = record ? /(?:^|;)\s*p\s*=\s*(none|quarantine|reject)\b/i.exec(record) : null;
  const ruaTag = record ? /(?:^|;)\s*rua\s*=\s*([^;]+)/i.exec(record) : null;
  const rua = ruaTag
    ? ruaTag[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  return {
    present: records.length > 0,
    record,
    policy: policyTag ? (policyTag[1].toLowerCase() as DmarcPolicy) : null,
    rua,
    hasRua: rua.length > 0,
    multiple: records.length > 1,
  };
}

/**
 * The DMARC check. `spfOk`/`dkimOk` are the *effective* authentication results
 * (a published SPF record, a verified DKIM signing domain) and are used for the
 * one combination that actively hurts: `p=reject` with neither, which rejects
 * legitimate mail as well as forged mail.
 */
export function dmarcCheck(
  dns: DnsResult,
  opts: { spfOk?: boolean; dkimOk?: boolean; domain?: string } = {},
): DeliverabilityCheck {
  const base = { id: "dmarc" as const, title: "DMARC" };
  if (dns.state === "unknown") {
    return { ...base, state: "unknown", summary: `Could not be checked — ${dns.reason}.`, fix: null, details: [] };
  }
  const d = parseDmarc(dns.state === "found" ? dns.records : []);
  const at = opts.domain ? `_dmarc.${opts.domain}` : "_dmarc";

  if (!d.present) {
    return {
      ...base,
      state: "fail",
      summary: `No DMARC record at ${at}.`,
      fix: `Publish a TXT record: v=DMARC1; p=none; rua=mailto:dmarc@your-domain — start in monitoring mode, then tighten.`,
      details: [],
    };
  }

  const policy = d.policy;
  const details = [
    ...(d.record ? [d.record] : []),
    `Policy: ${policy ?? "not set (defaults to none)"}`,
    d.hasRua ? `Reporting (rua): ${d.rua.join(", ")}` : "Reporting (rua): not set",
  ];

  if (policy === "reject" && opts.spfOk === false && opts.dkimOk === false) {
    return {
      ...base,
      state: "fail",
      summary: "p=reject with neither SPF nor DKIM in place — legitimate mail will be rejected too.",
      fix: "Fix SPF and DKIM first, or relax the policy to p=quarantine (or p=none) until both pass.",
      details,
    };
  }

  const notes: string[] = [];
  if (policy === null || policy === "none") {
    notes.push("Monitoring only — receivers take no action on a failure.");
  }
  if (!d.hasRua) {
    notes.push("No rua= address, so you receive no aggregate reports to diagnose from.");
  }
  return {
    ...base,
    state: "pass",
    summary: `DMARC record published with p=${policy ?? "none"}${d.hasRua ? " and reporting enabled" : ""}.`,
    fix: null,
    details: [...details, ...notes],
  };
}

/* ───────────────────────────────── MX ───────────────────────────────── */

export interface MxDetails {
  /** Preference-ordered mail exchangers. */
  hosts: { preference: number; host: string }[];
  /** RFC 7505 "null MX" (a single `0 .`): the domain explicitly accepts no mail. */
  nullMx: boolean;
}

/** Parse the MX records for a domain. */
export function parseMx(records: readonly string[]): MxDetails {
  const hosts: { preference: number; host: string }[] = [];
  for (const raw of records) {
    const m = /^(\d+)\s+(\S+)$/.exec(decodeTxt(raw));
    // The trailing root dot is stripped explicitly: `(\S+)\.?` would otherwise
    // let the greedy group swallow it, and a null MX ("0 .") would then never
    // be recognised as one.
    if (m) hosts.push({ preference: Number(m[1]), host: m[2].replace(/\.$/, "").toLowerCase() });
  }
  hosts.sort((a, b) => a.preference - b.preference);
  return { hosts, nullMx: hosts.length === 1 && hosts[0].host === "" };
}

/**
 * The MX check. This is about receiving replies, not about sending: a missing
 * MX does not stop SMTP2GO delivering, but a reply to the From address bounces.
 */
export function mxCheck(dns: DnsResult): DeliverabilityCheck {
  const base = { id: "mx" as const, title: "MX (reply handling)" };
  if (dns.state === "unknown") {
    return { ...base, state: "unknown", summary: `Could not be checked — ${dns.reason}.`, fix: null, details: [] };
  }
  const d = parseMx(dns.state === "found" ? dns.records : []);
  if (!d.hosts.length) {
    return {
      ...base,
      state: "fail",
      summary: "No MX record — the From domain cannot receive replies.",
      fix: "Add an MX record for the domain, or set the campaign's Reply-To to an address on a domain that can receive mail.",
      details: ["Sending is unaffected; replies to the From address will bounce."],
    };
  }
  if (d.nullMx) {
    return {
      ...base,
      state: "fail",
      summary: "The From domain publishes a null MX (0 .) — it explicitly accepts no mail.",
      fix: "Point Reply-To at a domain that accepts mail, or use a different From domain.",
      details: [],
    };
  }
  return {
    ...base,
    state: "pass",
    summary: `Mail exchangers published (${d.hosts.length}).`,
    fix: null,
    details: d.hosts.map((h) => `${h.preference} ${h.host}`),
  };
}

/* ──────────────────────────── DKIM / SMTP2GO ──────────────────────────── */

/**
 * One sender domain as SMTP2GO describes it. SMTP2GO is the authoritative
 * source for DKIM: it tells us the selector and target it wants published, so
 * the check resolves what SMTP2GO actually asked for rather than guessing.
 */
export interface Smtp2goSenderDomain {
  fulldomain: string;
  dkimSelector: string | null;
  dkimValue: string | null;
  dkimVerified: boolean | null;
  dkimStatus: string | null;
  rpathSelector: string | null;
  rpathValue: string | null;
  rpathVerified: boolean | null;
  rpathStatus: string | null;
  /** A tracking subdomain CNAME, when SMTP2GO link tracking is on. */
  trackerHost: string | null;
  trackerValue: string | null;
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
 * Normalise one entry of the SMTP2GO `/domain/view` response. The live shape
 * nests the records under `domain` (fulldomain, dkim_selector, dkim_value,
 * rpath_selector, rpath_value, ...) with `trackers[]` alongside; older/flat
 * responses carry a bare `domain` string, which is handled too. Returns null
 * when there is no usable domain name.
 */
export function normalizeSmtp2goDomain(raw: unknown): Smtp2goSenderDomain | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const inner = r.domain && typeof r.domain === "object" ? (r.domain as Record<string, any>) : null;

  const fulldomain =
    str(inner?.fulldomain) ??
    str(r.fulldomain) ??
    (typeof r.domain === "string" ? str(r.domain) : null) ??
    str(r.domain_name);
  if (!fulldomain) return null;

  const tracker = Array.isArray(r.trackers)
    ? (r.trackers.find((t: any) => t && (t.fulldomain || t.cname_value)) ?? null)
    : null;

  return {
    fulldomain: fulldomain.toLowerCase().replace(/\.$/, ""),
    dkimSelector: str(inner?.dkim_selector) ?? str(r.dkim_selector),
    dkimValue: str(inner?.dkim_value) ?? str(r.dkim_value),
    dkimVerified: bool(inner?.dkim_verified) ?? bool(r.dkim_verified),
    dkimStatus: str(inner?.dkim_status) ?? str(r.dkim_status),
    rpathSelector: str(inner?.rpath_selector) ?? str(r.rpath_selector),
    rpathValue: str(inner?.rpath_value) ?? str(r.rpath_value),
    rpathVerified: bool(inner?.rpath_verified) ?? bool(r.rpath_verified),
    rpathStatus: str(inner?.rpath_status) ?? str(r.rpath_status),
    trackerHost: tracker ? str(tracker.fulldomain) : null,
    trackerValue: tracker ? str(tracker.cname_value) : null,
  };
}

export interface DkimExpectation {
  host: string;
  target: string;
  kind: "dkim" | "return-path" | "tracking";
}

/** The CNAME records SMTP2GO asks for on a sender domain. */
export function dkimExpectations(d: Smtp2goSenderDomain): DkimExpectation[] {
  const out: DkimExpectation[] = [];
  if (d.dkimSelector && d.dkimValue) {
    out.push({
      host: `${d.dkimSelector}._domainkey.${d.fulldomain}`.toLowerCase(),
      target: d.dkimValue,
      kind: "dkim",
    });
  }
  if (d.rpathSelector && d.rpathValue) {
    out.push({
      host: `${d.rpathSelector}.${d.fulldomain}`.toLowerCase(),
      target: d.rpathValue,
      kind: "return-path",
    });
  }
  if (d.trackerHost && d.trackerValue) {
    out.push({ host: d.trackerHost.toLowerCase(), target: d.trackerValue, kind: "tracking" });
  }
  return out;
}

/** A CNAME host that resolves to the target SMTP2GO asked for. */
export function cnameTargetMatches(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const norm = (s: string) => s.trim().toLowerCase().replace(/\.$/, "");
  return norm(actual) === norm(expected);
}

export interface DkimRecordOutcome extends DkimExpectation {
  state: CheckState;
  /** The CNAME target actually found, when there was one. */
  actual: string | null;
  detail: string;
}

/** Resolve one expected CNAME against a CNAME lookup result. */
export function resolveDkimRecord(exp: DkimExpectation, dns: DnsResult): DkimRecordOutcome {
  if (dns.state === "unknown") {
    return { ...exp, state: "unknown", actual: null, detail: `Could not be checked — ${dns.reason}.` };
  }
  if (dns.state === "absent") {
    return {
      ...exp,
      state: "fail",
      actual: null,
      detail: `${exp.host} is not published (should point to ${exp.target}).`,
    };
  }
  const record = dns.records[0] ?? null;
  if (cnameTargetMatches(record, exp.target)) {
    return { ...exp, state: "pass", actual: record, detail: `${exp.host} → ${record}` };
  }
  return {
    ...exp,
    state: "fail",
    actual: record,
    detail: `${exp.host} points to ${record || "(nothing)"} instead of ${exp.target}.`,
  };
}

export interface DkimCheckInput {
  /** The SMTP2GO sender-domain entry matching the checked domain. */
  senderDomain: Smtp2goSenderDomain | null;
  /** True when SMTP2GO was asked and the domain is not on the account. */
  notRegistered?: boolean;
  records: DkimRecordOutcome[];
  /** Why the SMTP2GO half could not be read at all (unset key, API error). */
  error?: string | null;
}

/**
 * The DKIM check. The authoritative source is SMTP2GO's own domains API: it
 * decides the selector/target, so the DNS half only confirms what SMTP2GO asked
 * for resolves. When SMTP2GO cannot be read the whole check is `unknown` — a
 * missing API key is not a failed DKIM setup.
 */
export function dkimCheck(input: DkimCheckInput): DeliverabilityCheck {
  const base = { id: "dkim" as const, title: "DKIM" };

  if (input.error) {
    return {
      ...base,
      state: "unknown",
      summary: `Could not be checked — ${input.error}.`,
      fix: null,
      details: [],
    };
  }
  if (input.notRegistered || !input.senderDomain) {
    return {
      ...base,
      state: "fail",
      summary: "The sending domain is not registered as a sender domain in SMTP2GO.",
      fix: "Add it under SMTP2GO → Verified Senders → Sender domains, then publish the CNAMEs it gives you.",
      details: [],
    };
  }

  const sd = input.senderDomain;
  const details = input.records.map((r) => `${r.detail}`);
  details.push(
    `SMTP2GO state — DKIM: ${verifiedLabel(sd.dkimVerified, sd.dkimStatus)}, return-path: ${verifiedLabel(sd.rpathVerified, sd.rpathStatus)}`,
  );

  if (!input.records.length) {
    return {
      ...base,
      state: "unknown",
      summary: "SMTP2GO listed the domain but returned no DKIM/return-path selector to check.",
      fix: null,
      details,
    };
  }

  const failed = input.records.filter((r) => r.state === "fail");
  const unknown = input.records.filter((r) => r.state === "unknown");

  if (failed.length) {
    return {
      ...base,
      state: "fail",
      summary: `${failed.length} of ${input.records.length} SMTP2GO CNAME record${input.records.length === 1 ? "" : "s"} do not resolve as asked.`,
      fix: `Publish the missing CNAME record${failed.length === 1 ? "" : "s"} exactly as SMTP2GO lists them on the Sender domains page.`,
      details,
    };
  }
  if (unknown.length) {
    return {
      ...base,
      state: "unknown",
      summary: `Could not be fully checked — ${unknown.length} of ${input.records.length} CNAME lookups failed.`,
      fix: null,
      details,
    };
  }
  return {
    ...base,
    state: "pass",
    summary:
      sd.dkimVerified && sd.rpathVerified
        ? "All SMTP2GO CNAME records resolve and SMTP2GO reports the domain verified."
        : "All SMTP2GO CNAME records resolve, but SMTP2GO still reports the domain unverified.",
    fix: sd.dkimVerified && sd.rpathVerified ? null : "Use SMTP2GO's Verify button to re-run its own check.",
    details,
  };
}

function verifiedLabel(verified: boolean | null, status: string | null): string {
  const state = verified === null ? "unknown" : verified ? "verified" : "unverified";
  return status ? `${state} (${status})` : state;
}

/* ──────────────────────────── From alignment ──────────────────────────── */

/**
 * The domain part of an address, lowercased. Null when there isn't one.
 *
 * Lenient on purpose: DMARC alignment only needs the two domains to be
 * comparable strings. Where a real, lookup-able domain is required (the
 * sending-domain value itself) use `sendingDomainFromEmail` in shared/domain.ts,
 * which additionally requires a dot.
 */
export function domainOfEmail(email: string | null | undefined): string | null {
  return domainFromEmail(email);
}

/**
 * DMARC alignment: receivers check that the From domain lines up with the
 * domain SPF authenticated or the domain DKIM signed. We know the signed domain
 * because SMTP2GO signs with the verified sender domain, so a From domain that
 * differs is a real risk.
 */
export function alignmentCheck(
  fromDomain: string | null,
  signedDomain: string | null,
): DeliverabilityCheck {
  const base = { id: "alignment" as const, title: "From / DKIM alignment" };
  if (!fromDomain || !signedDomain) {
    return {
      ...base,
      state: "unknown",
      summary: "Could not be checked — the From domain or the DKIM-signed domain is not known.",
      fix: null,
      details: [],
    };
  }
  if (fromDomain === signedDomain) {
    return {
      ...base,
      state: "pass",
      summary: `From domain and the DKIM-signed domain are both ${signedDomain} — DMARC alignment holds.`,
      fix: null,
      details: [],
    };
  }
  return {
    ...base,
    state: "fail",
    summary: `From is ${fromDomain} but SMTP2GO signs as ${signedDomain}, so DMARC alignment fails unless SPF aligns on the From domain.`,
    fix: `Send from ${signedDomain}, or add ${fromDomain} as a verified sender domain in SMTP2GO so it is signed too.`,
    details: [],
  };
}

/* ───────────────────────────── orchestration ───────────────────────────── */

export interface DeliverabilityInput {
  domain: string;
  /** Where `domain` came from; defaults to the campaign's own sending domain. */
  domainSource?: DomainSource;
  /** A stored sending-domain value rejected as not a domain, if any. */
  ignoredDomain?: string | null;
  fromDomain: string | null;
  /** TXT records at the domain apex. */
  spf: DnsResult;
  /** TXT records at `_dmarc.<domain>`. */
  dmarc: DnsResult;
  /** MX records for the domain. */
  mx: DnsResult;
  /** The SMTP2GO half; null when it was never attempted. */
  dkim: DkimCheckInput;
  checkedAt?: number;
}

/**
 * Run the five checks over already-fetched answers and assemble the panel's
 * result. Kept separate from the fetching so it is pure and unit-testable.
 */
export function buildDeliverability(input: DeliverabilityInput): DeliverabilityResult {
  const returnPath = input.dkim.records.find((r) => r.kind === "return-path");
  const spf = spfCheck(input.spf, {
    returnPathCnameResolves: returnPath?.state === "pass",
  });
  const dkim = dkimCheck(input.dkim);
  const dmarc = dmarcCheck(input.dmarc, {
    // "In place" means published and valid, which is what the other checks
    // establish; an unknown there leaves this false and only ever softens the
    // p=reject combination check.
    spfOk: spf.state === "pass",
    dkimOk: dkim.state === "pass",
    domain: input.domain,
  });
  const mx = mxCheck(input.mx);
  const alignment = alignmentCheck(input.fromDomain, signedDomainOf(input));

  const checks = [spf, dkim, dmarc, mx, alignment];
  const failures = checks.filter((c) => c.state === "fail");
  const notChecked = checks
    .filter((c) => c.state === "unknown")
    .map((c) => `${c.title}: ${c.summary.replace(/^Could not be (?:fully )?checked — /, "")}`);
  return {
    domain: input.domain,
    domainSource: input.domainSource ?? "sending_domain",
    ignoredDomain: input.ignoredDomain ?? null,
    fromDomain: input.fromDomain,
    checks,
    failures,
    notChecked,
    complete: notChecked.length === 0,
    checkedAt: input.checkedAt ?? Math.floor(Date.now() / 1000),
  };
}

/** The domain SMTP2GO signs as, when the SMTP2GO half was readable. */
function signedDomainOf(input: DeliverabilityInput): string | null {
  if (input.dkim.error) return null;
  return input.dkim.senderDomain?.fulldomain ?? null;
}

/** Short one-line-per-failure text for a confirm() dialog. */
export function failureLines(result: DeliverabilityResult, limit = 5): string[] {
  const lines = result.failures.slice(0, limit).map((c) => `• ${c.title}: ${c.summary}`);
  if (result.failures.length > limit) {
    lines.push(`…and ${result.failures.length - limit} more — see the deliverability panel.`);
  }
  return lines;
}
