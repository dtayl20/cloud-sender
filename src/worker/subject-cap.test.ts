// The rendered subject is capped at a sane length, without ever shipping a
// mangled name or a subject that reads as bulk mail.
//
// The trigger: "what we measured on {{business_name}}'s website" with a very
// long business name renders past the ~70 characters a client shows, so the
// name is shortened at a word boundary -- or dropped cleanly when no whole name
// fits -- and the result stays under our own spam check's "long subject" line.

import { describe, expect, it } from "vitest";
import {
  SUBJECT_TARGET_LENGTH,
  capRenderedSubject,
  previewSubjectLine,
  renderSubject,
} from "../shared/subject";
import { SPAM_WEIGHTS, checkSpam } from "../shared/spamCheck";

const SOURCE = "what we measured on {{business_name}}'s website";
const LONG_NAME = "Comfort Dental Gymea Dr Y Cheah Dr Raj And Associates";
const NAME_PREFIX = "what we measured on ";
const NAME_SUFFIX = "'s website";

/** The subject the OLD render produced for this name, before the cap. */
const uncapped = (name: string) => NAME_PREFIX + name + NAME_SUFFIX;

describe("a subject that already fits is untouched", () => {
  it("leaves a short personalised subject exactly as it was", () => {
    const out = renderSubject(SOURCE, null, { business_name: "Riverside Dental" });
    expect(out).toBe("what we measured on Riverside Dental's website");
  });

  it("leaves a short plain subject exactly as it was", () => {
    expect(renderSubject("Your listing update", null, {})).toBe("Your listing update");
    expect(renderSubject(null, "Update for {{practice_name}}", { practice_name: "Riverside Dental" })).toBe(
      "Update for Riverside Dental",
    );
  });

  it("leaves a subject exactly at the cap alone", () => {
    const exact = "z".repeat(SUBJECT_TARGET_LENGTH);
    expect(renderSubject(exact, null, {})).toBe(exact);
  });
});

describe("a long name is shortened at a word boundary", () => {
  const out = renderSubject(SOURCE, null, { business_name: LONG_NAME });

  it("fits the cap", () => {
    expect(uncapped(LONG_NAME).length).toBeGreaterThan(SUBJECT_TARGET_LENGTH);
    expect(out.length).toBeLessThanOrEqual(SUBJECT_TARGET_LENGTH);
  });

  it("keeps the frame and the possessive intact", () => {
    expect(out.startsWith(NAME_PREFIX)).toBe(true);
    expect(out.endsWith(NAME_SUFFIX)).toBe(true);
  });

  it("drops whole trailing words, never half a word", () => {
    const kept = out.slice(NAME_PREFIX.length, out.length - NAME_SUFFIX.length);
    const keptWords = kept.split(" ");
    // A leading run of whole words from the original name...
    expect(LONG_NAME.split(" ").slice(0, keptWords.length)).toEqual(keptWords);
    // ...and shorter than the original, i.e. it actually did something.
    expect(keptWords.length).toBeGreaterThanOrEqual(2);
    expect(keptWords.length).toBeLessThan(LONG_NAME.split(" ").length);
    // The name itself never ends mid-word.
    expect(LONG_NAME.startsWith(kept)).toBe(true);
  });

  it("reads as a shorter name, not a broken string", () => {
    expect(out).not.toMatch(/['’]\s+website/); // no orphan possessive
    expect(out).not.toMatch(/[a-z]{2}'s$/); // no bare "...x's" tail
  });
});

describe("a name that cannot fit drops out cleanly", () => {
  it("falls back to a name-free subject that still reads like a sentence", () => {
    // One 29-character word: no whole name fits without becoming a half-name.
    const out = renderSubject(SOURCE, null, { business_name: "Extraordinarilylongclinicname Dental" });
    expect(uncapped("Extraordinarilylongclinicname Dental").length).toBeGreaterThan(
      SUBJECT_TARGET_LENGTH,
    );
    expect(out).toBe("what we measured on your website");
  });

  it("uses 'you' where the template has no possessive", () => {
    const out = renderSubject(
      "A website check for {{business_name}} with a very long trailing clause here",
      null,
      { business_name: "Comfort Dental Gymea Dr Y Cheah Dr Raj And Associates" },
    );
    expect(out.length).toBeLessThanOrEqual(SUBJECT_TARGET_LENGTH);
    expect(out).not.toContain("{{");
  });

  it("never leaves a dangling possessive for any long name", () => {
    const names = [
      LONG_NAME,
      "Extraordinarilylongclinicname Dental",
      "The Very Long Named Dental Surgery Of Somewhere Far Away",
      "A".repeat(70),
      "Smile Dental Clinic And Implant Centre Of Greater Western Sydney",
    ];
    for (const name of names) {
      const out = renderSubject(SOURCE, null, { business_name: name });
      expect(out.length, name).toBeLessThanOrEqual(SUBJECT_TARGET_LENGTH);
      expect(out, name).not.toMatch(/\s['’]/); // a space before an apostrophe = orphan
      expect(out.endsWith("'s"), name).toBe(false);
      expect(out.trim().length, name).toBeGreaterThan(0);
    }
  });
});

describe("a long subject with no variable is cut at a word boundary", () => {
  it("caps a plain 95-character subject without cutting a word in half", () => {
    const long =
      "An update about the details on your clinic listing and everything else we changed for you this month";
    const out = renderSubject(long, null, {});
    expect(out.length).toBeLessThanOrEqual(SUBJECT_TARGET_LENGTH);
    expect(long.startsWith(out)).toBe(true);
    // The character the cut landed on is a word break, not mid-word.
    expect(long[out.length]).toBe(" ");
  });

  it("caps an over-long subject with no spaces at the cap, cleanly", () => {
    const out = renderSubject("y".repeat(250), null, {});
    expect(out).toBe("y".repeat(SUBJECT_TARGET_LENGTH));
  });
});

describe("the cap is the single rule for every renderer", () => {
  it("gives the editor preview the same subject the send uses", () => {
    const values = { business_name: LONG_NAME };
    expect(previewSubjectLine(SOURCE, null, values)).toBe(renderSubject(SOURCE, null, values));

    const short = { business_name: "Riverside Dental" };
    expect(previewSubjectLine(SOURCE, null, short)).toBe(renderSubject(SOURCE, null, short));
  });

  it("caps the campaign's own subject override, not just the template's", () => {
    const out = renderSubject(SOURCE, "Template subject", { business_name: LONG_NAME });
    expect(out.length).toBeLessThanOrEqual(SUBJECT_TARGET_LENGTH);
    expect(out.endsWith(NAME_SUFFIX)).toBe(true);
  });

  it("keeps an unresolved variable visible in the preview", () => {
    expect(previewSubjectLine("Hi {{nobody}}", null, {})).toBe("Hi {{nobody}}");
    // The send resolves it to empty, exactly like the body does.
    expect(renderSubject("Hi {{nobody}}", null, {})).toBe("Hi");
  });

  it("returns the source unchanged when nothing needs capping", () => {
    expect(capRenderedSubject("Short and sweet", SOURCE, () => "unused")).toBe("Short and sweet");
  });
});

describe("shortening does not cost spam score", () => {
  // A realistic campaign body, so the only rule the subject change can move is
  // the subject-length one.
  const body = Array.from({ length: 60 }, (_, i) => (i % 2 ? "clinic" : "patients")).join(" ");
  const campaign = (subject: string) => ({
    subject,
    html: `<p>${body}</p><p><a href="https://localdentists.au/clinic-report/unsubscribe">unsubscribe</a></p>`,
    text: `${body}\n\nunsubscribe: https://localdentists.au/clinic-report/unsubscribe`,
    from: "listing@localdentists.au",
    replyTo: "hello@localdentists.au",
  });

  const before = checkSpam(campaign(uncapped(LONG_NAME)));
  const after = checkSpam(campaign(renderSubject(SOURCE, null, { business_name: LONG_NAME })));

  it("starts from a subject the checker calls too long", () => {
    expect(uncapped(LONG_NAME).length).toBeGreaterThan(78);
    expect(before.findings.some((f) => f.id === "subject_long")).toBe(true);
  });

  it("passes the long-subject rule afterwards", () => {
    expect(after.findings.some((f) => f.id === "subject_long")).toBe(false);
  });

  it("scores better, by exactly the long-subject penalty", () => {
    expect(before.score).not.toBeNull();
    expect(after.score).not.toBeNull();
    expect(after.score! - before.score!).toBe(SPAM_WEIGHTS.subject_long);
    expect(after.score).toBeGreaterThan(before.score!);
  });
});
