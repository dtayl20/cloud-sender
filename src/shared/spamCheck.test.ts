// Pre-send spam check.
//
// Two things are being pinned here:
//   1. every rule FIRES on a sample that should trip it, and
//   2. the check stays QUIET on an ordinary professional email, because a
//      heuristic that cries wolf on normal mail is worse than no heuristic.
//
// Plus the honesty contract: a campaign that cannot be fully inspected gets no
// score and no band — never a green "good".

import { describe, expect, it } from "vitest";
import {
  BAND_CAUTION_MIN,
  BAND_GOOD_MIN,
  SPAM_WEIGHTS,
  bandFor,
  bySeverity,
  checkSpam,
  severityFor,
  type SpamCheckInput,
  type SpamRuleId,
} from "./spamCheck";

/** An ordinary, well-formed clinic update. Nothing here should trip a rule. */
const CLEAN_HTML = `<!doctype html>
<body style="background:#ffffff;font-family:Arial,sans-serif;color:#222222;">
  <div style="max-width:600px;margin:0 auto;">
    <h1 style="font-size:22px;">Your listing update</h1>
    <p>Hi Alex,</p>
    <p>We have refreshed the details on your clinic listing and added the photographs you sent through last week. Nothing is required from you, and you can adjust any of it from your dashboard at a time that suits.</p>
    <p>If you would like a hand with the wording of your practice description, reply to this email and one of the team will come back to you within one business day.</p>
    <p><a href="https://localdentists.au/setup-listing">Review your listing</a></p>
    <p>Thanks,<br />The localdentists team</p>
    <p style="font-size:12px;color:#666666;"><a href="https://localdentists.au/unsubscribe">Unsubscribe</a> from these updates.</p>
  </div>
</body>`;

const CLEAN_TEXT = `Your listing update

Hi Alex,

We have refreshed the details on your clinic listing and added the photographs you sent through last week. Nothing is required from you, and you can adjust any of it from your dashboard at a time that suits.

If you would like a hand with the wording of your practice description, reply to this email and one of the team will come back to you within one business day.

Review your listing: https://localdentists.au/setup-listing

Thanks,
The localdentists team

Unsubscribe: https://localdentists.au/unsubscribe`;

/** The clean email, as the send path would render it. */
const CLEAN: SpamCheckInput = {
  subject: "Your listing update",
  html: CLEAN_HTML,
  text: CLEAN_TEXT,
  from: "hello@localdentists.au",
  replyTo: "hello@localdentists.au",
};

function ids(input: SpamCheckInput): SpamRuleId[] {
  return checkSpam(input).findings.map((f) => f.id);
}

/** A clean email with one field replaced, so a positive sample differs only there. */
function withOne(patch: Partial<SpamCheckInput>): SpamCheckInput {
  return { ...CLEAN, ...patch };
}

const LONG_SUBJECT =
  "An update about the details on your clinic listing and everything else we changed for you this month";

describe("a clean professional email scores good and trips nothing", () => {
  const result = checkSpam(CLEAN);

  it("has no findings, a perfect score and the good band", () => {
    expect(result.findings).toEqual([]);
    expect(result.penalty).toBe(0);
    expect(result.score).toBe(100);
    expect(result.band).toBe("good");
  });

  it("is fully checked, so the result is not qualified", () => {
    expect(result.complete).toBe(true);
    expect(result.skipped).toEqual([]);
    expect(result.checked).toEqual(["subject", "body", "structure"]);
  });
});

describe("every rule fires on its own sample", () => {
  const cases: { id: SpamRuleId; input: SpamCheckInput }[] = [
    // ── subject ──────────────────────────────────────────────────────────
    { id: "subject_empty", input: withOne({ subject: "" }) },
    { id: "subject_all_caps", input: withOne({ subject: "URGENT DENTAL NEWS" }) },
    { id: "subject_exclamations", input: withOne({ subject: "Your listing update!!!" }) },
    { id: "subject_dollar", input: withOne({ subject: "Save $50 on $100 and $200 plans" }) },
    { id: "subject_spam_phrase", input: withOne({ subject: "A free guide for your clinic" }) },
    { id: "subject_long", input: withOne({ subject: LONG_SUBJECT }) },
    // ── body ─────────────────────────────────────────────────────────────
    {
      id: "body_image_heavy",
      input: withOne({
        html: '<p><img src="https://x.test/a.png" width="120" /></p><p><img src="https://x.test/b.png" width="120" /></p><p>Book today.</p><p><a href="https://localdentists.au/unsubscribe">Unsubscribe</a></p>',
        text: "Book today.\n\nUnsubscribe: https://localdentists.au/unsubscribe",
      }),
    },
    {
      id: "body_large_image",
      input: withOne({
        html: `${CLEAN_HTML}<p><img src="https://x.test/hero.png" width="900" alt="hero" /></p>`,
      }),
    },
    {
      id: "body_link_shortener",
      input: withOne({
        html: CLEAN_HTML.replace(
          "https://localdentists.au/setup-listing",
          "https://bit.ly/3xYz",
        ),
      }),
    },
    {
      id: "body_many_links",
      input: withOne({
        html: CLEAN_HTML.replace(
          "<p>Thanks,",
          `${Array.from({ length: 16 }, (_, i) => `<a href="https://localdentists.au/p${i}">Page ${i}</a>`).join(" ")}<p>Thanks,`,
        ),
      }),
    },
    {
      id: "body_link_imbalance",
      input: withOne({
        html: '<p><a href="https://localdentists.au/a">One</a> <a href="https://localdentists.au/b">Two</a> <a href="https://localdentists.au/c">Three</a> <a href="https://localdentists.au/d">Four</a> <a href="https://localdentists.au/e">Five</a> <a href="https://localdentists.au/f">Six</a></p><p>Short copy here and nothing more of substance.</p><p><a href="https://localdentists.au/unsubscribe">Unsubscribe</a></p>',
        text: "Unsubscribe: https://localdentists.au/unsubscribe",
      }),
    },
    {
      id: "body_hidden_text",
      input: withOne({
        html: CLEAN_HTML.replace(
          "<p>Hi Alex,</p>",
          '<p style="font-size:0;">free money free money free money</p><p>Hi Alex,</p>',
        ),
      }),
    },
    {
      id: "body_display_none",
      input: withOne({
        html: CLEAN_HTML.replace(
          "<p>Hi Alex,</p>",
          '<div style="display:none;">Deals inside</div><p>Hi Alex,</p>',
        ),
      }),
    },
    {
      id: "body_spam_phrase",
      input: withOne({
        html: CLEAN_HTML.replace("Hi Alex,", "Hi Alex, act now to claim your free prize!"),
      }),
    },
    {
      id: "body_exclamations",
      input: withOne({ html: CLEAN_HTML.replace("Hi Alex,", "Hi Alex!!!!!") }),
    },
    {
      id: "body_all_caps",
      input: withOne({
        html: CLEAN_HTML.replace("Hi Alex,", "Hi Alex, SPECIAL LIMITED CLINIC OFFER TODAY ONLY"),
      }),
    },
    { id: "body_missing", input: withOne({ html: "", text: "" }) },
    {
      id: "body_form_in_body",
      input: withOne({
        html: CLEAN_HTML.replace(
          "<p>Thanks,",
          '<form action="https://localdentists.au/x"><input name="email" /></form><p>Thanks,',
        ),
      }),
    },
    {
      id: "body_bare_url",
      input: withOne({
        html: CLEAN_HTML.replace(
          "<p>Thanks,",
          "<p>Full details at https://localdentists.au/report for you.</p><p>Thanks,",
        ),
      }),
    },
    {
      id: "body_attachment_mention",
      input: withOne({ html: CLEAN_HTML.replace("Hi Alex,", "Hi Alex, see attached PDF for the report.") }),
    },
    // ── structure / compliance ───────────────────────────────────────────
    {
      id: "unsubscribe_missing",
      input: withOne({
        html: CLEAN_HTML.replace(
          '<p style="font-size:12px;color:#666666;"><a href="https://localdentists.au/unsubscribe">Unsubscribe</a> from these updates.</p>',
          "",
        ),
        text: "Thanks,\nThe localdentists team",
      }),
    },
    { id: "from_missing", input: withOne({ from: "" }) },
    { id: "reply_to_missing", input: withOne({ replyTo: "" }) },
    { id: "text_missing", input: withOne({ text: "" }) },
    { id: "unrendered_variables", input: withOne({ subject: "Update for {{practice_name}}" }) },
    {
      id: "mailto_only",
      input: withOne({
        html: '<p>Reply to us at <a href="mailto:hello@localdentists.au">hello@localdentists.au</a>.</p><p>Unsubscribe below.</p><p>We refreshed your listing and will keep you posted on anything that needs your attention.</p>',
        text: "Unsubscribe: reply to this email",
      }),
    },
  ];

  for (const { id, input } of cases) {
    it(`flags ${id}`, () => {
      expect(ids(input)).toContain(id);
      // Each rule must exist in the published weight table.
      expect(SPAM_WEIGHTS[id]).toBeGreaterThan(0);
    });
  }

  it("covers every rule in the weight table", () => {
    const covered = new Set<SpamRuleId>(cases.map((c) => c.id));
    expect([...Object.keys(SPAM_WEIGHTS)].filter((id) => !covered.has(id as SpamRuleId))).toEqual([]);
  });
});

describe("the clean email stays quiet on each rule", () => {
  it("does not flag any rule that is not in the positive set", () => {
    // A handful of explicit near-misses, so a rule cannot be tripped by
    // ordinary words: no exclamations at all, no ALL-CAPS runs, etc.
    expect(ids(CLEAN)).toEqual([]);
    expect(ids(withOne({ subject: "Booking times for your clinic" }))).toEqual([]);
    expect(ids(withOne({ subject: "Your listing update — September" }))).toEqual([]);
  });

  it("does not call a real-looking unsubscribe link a miss", () => {
    expect(ids(withOne({ html: CLEAN_HTML, text: CLEAN_TEXT }))).not.toContain(
      "unsubscribe_missing",
    );
  });

  it("accepts an unsubscribe token instead of a link", () => {
    const html = CLEAN_HTML.replace(
      '<a href="https://localdentists.au/unsubscribe">Unsubscribe</a>',
      "{{unsubscribe}}",
    );
    expect(ids(withOne({ html }))).not.toContain("unsubscribe_missing");
    // …and a surviving {{unsubscribe}} token is not "unrendered variables".
    expect(ids(withOne({ html }))).not.toContain("unrendered_variables");
  });
});

describe("weights, score and band boundaries", () => {
  it("scores 100 minus the findings' weights", () => {
    const result = checkSpam({
      ...CLEAN,
      html: CLEAN_HTML.replace("Hi Alex,", "Hi Alex, see attached PDF for the report."),
    });
    const expected = 100 - SPAM_WEIGHTS.body_attachment_mention;
    expect(result.penalty).toBe(SPAM_WEIGHTS.body_attachment_mention);
    expect(result.score).toBe(expected);
  });

  it("floors the score at zero rather than going negative", () => {
    const result = checkSpam({
      subject: "FREE!!! ACT NOW $100 $200 $300",
      html: `<div style="display:none;">x</div><p style="font-size:0;">free free</p><form><input /></form><img src="https://x.test/a.png" width="900" /><p><a href="https://bit.ly/abc">Go</a></p><p>See attached file. Act now!!!</p>`,
      text: "",
      from: "",
      replyTo: "",
    });
    expect(result.penalty).toBeGreaterThan(100);
    expect(result.score).toBe(0);
    expect(result.band).toBe("likely spam");
  });

  it("places the band boundaries where the constants say", () => {
    expect(bandFor(100)).toBe("good");
    expect(bandFor(BAND_GOOD_MIN)).toBe("good");
    expect(bandFor(BAND_GOOD_MIN - 1)).toBe("caution");
    expect(bandFor(BAND_CAUTION_MIN)).toBe("caution");
    expect(bandFor(BAND_CAUTION_MIN - 1)).toBe("likely spam");
    expect(bandFor(0)).toBe("likely spam");
  });

  it("derives severity from the weight", () => {
    expect(severityFor(SPAM_WEIGHTS.unsubscribe_missing)).toBe("high");
    expect(severityFor(SPAM_WEIGHTS.subject_all_caps)).toBe("medium");
    expect(severityFor(SPAM_WEIGHTS.reply_to_missing)).toBe("low");
  });

  it("bands a mid-weight email as caution, not as spam", () => {
    // One medium finding: not clean, not spam.
    const result = checkSpam(withOne({ subject: "URGENT DENTAL NEWS" }));
    expect(result.score).toBe(100 - SPAM_WEIGHTS.subject_all_caps - SPAM_WEIGHTS.subject_spam_phrase);
    expect(result.band).toBe("caution");
  });

  it("orders findings by severity for display", () => {
    const ordered = bySeverity(
      checkSpam({ subject: "URGENT DENTAL NEWS", html: CLEAN_HTML, text: CLEAN_TEXT, from: "", replyTo: "" })
        .findings,
    );
    const firstLow = ordered.findIndex((f) => f.severity === "low");
    const lastHigh = ordered.map((f) => f.severity).lastIndexOf("high");
    expect(firstLow).toBeGreaterThan(lastHigh);
  });
});

describe("missing unsubscribe is flagged and costs the most", () => {
  const input = withOne({
    html: CLEAN_HTML.replace(
      '<p style="font-size:12px;color:#666666;"><a href="https://localdentists.au/unsubscribe">Unsubscribe</a> from these updates.</p>',
      "",
    ),
    text: "Thanks,\nThe localdentists team",
  });
  const result = checkSpam(input);
  const finding = result.findings.find((f) => f.id === "unsubscribe_missing");

  it("reports the missing opt-out with a concrete fix", () => {
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("high");
    expect(finding!.weight).toBe(SPAM_WEIGHTS.unsubscribe_missing);
    expect(finding!.fix).toMatch(/unsubscribe|opt-out/i);
  });

  it("drops the band out of good", () => {
    expect(result.score).toBe(100 - SPAM_WEIGHTS.unsubscribe_missing);
    expect(result.band).toBe("caution");
    expect(result.complete).toBe(true);
  });
});

describe("an unrendered campaign is reported honestly, never green", () => {
  it("gives no score and no band when there is nothing rendered", () => {
    const result = checkSpam({ subject: "", html: "", text: "" });

    expect(result.score).toBeNull();
    expect(result.band).toBeNull();
    expect(result.complete).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.checked).toEqual([]);
    expect(result.skipped).toHaveLength(3);
  });

  it("is not reported as good or complete when the body is missing", () => {
    const result = checkSpam({ subject: "Your update", html: null, text: null, from: "a@b.com", replyTo: "a@b.com" });

    expect(result.band).not.toBe("good");
    expect(result.score).toBeNull();
    expect(result.complete).toBe(false);
    expect(result.findings.map((f) => f.id)).toContain("body_missing");
    expect(result.skipped.join(" ")).toMatch(/body/);
  });

  it("passes the caller's own reason for an uninspectable body through", () => {
    const result = checkSpam({
      subject: "Your update",
      html: "",
      text: "",
      bodyNote: "SMTP2GO renders this template's body server-side",
    });
    expect(result.skipped).toContain("SMTP2GO renders this template's body server-side");
  });

  it("says a partially checked campaign is incomplete even when what it saw was clean", () => {
    const result = checkSpam({ subject: "Your listing update", html: "", text: "", bodyNote: "unavailable" });
    expect(result.score).toBeNull();
    expect(result.complete).toBe(false);
    expect(result.checked).toContain("subject");
  });

  it("says what it could not check when variables were left unresolved", () => {
    const result = checkSpam(withOne({ subject: "Update for {{practice_name}}" }));
    expect(result.findings.map((f) => f.id)).toContain("unrendered_variables");
    expect(result.findings.find((f) => f.id === "unrendered_variables")!.message).toContain(
      "{{practice_name}}",
    );
  });
});

describe("unresolved variables make the check partial, never a clean score", () => {
  it("names the variables it could not resolve in the couldn't-check list", () => {
    const result = checkSpam({ ...CLEAN, unresolvedVariables: ["practice_name"] });
    expect(result.skipped.join(" ")).toContain("{{practice_name}}");
    expect(result.complete).toBe(false);
    expect(result.score).toBeNull();
    expect(result.band).toBeNull();
  });

  it("pluralises and lists several names", () => {
    const result = checkSpam({ ...CLEAN, unresolvedVariables: ["api", "chip"] });
    const note = result.skipped.join(" ");
    expect(note).toContain("{{api}}");
    expect(note).toContain("{{chip}}");
    expect(note).toMatch(/variables/);
  });

  it("changes nothing when there is nothing unresolved", () => {
    const result = checkSpam({ ...CLEAN, unresolvedVariables: [] });
    expect(result.complete).toBe(true);
    expect(result.score).toBe(100);
  });
});

describe("it never calls out to anything", () => {
  it("returns a plain, serialisable result with no network dependency", () => {
    const result = checkSpam(CLEAN);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
