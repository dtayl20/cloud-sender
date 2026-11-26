/**
 * Pre-send spam check — sender-side hygiene, entirely local.
 *
 * The input is the RENDERED campaign: the subject, HTML body and text body the
 * send path would actually produce (see src/worker/render.ts and
 * src/shared/subject.ts). Checking the rendered output rather than the template
 * means the check matches what really goes out — a `{{content}}` slot that was
 * never filled shows up here exactly as a recipient would see it.
 *
 * Nothing leaves our infrastructure. There is deliberately NO external
 * spam-scoring service: posting clinic email content to a third-party checker
 * would send campaign content off-site, which is not acceptable for this tool.
 * The rules below are ordinary heuristics over the rendered text; they are
 * documented, weighted and explainable rather than a black-box score.
 *
 * A good score is NOT a guarantee of inbox placement. It means we could not see,
 * from the inside, a reason a receiving filter would object. Deliverability is
 * also about domain reputation, authentication (SPF/DKIM/DMARC), list hygiene
 * and recipient engagement — none of which this check can see.
 *
 * No Worker, React or DB imports here, so the Worker send path and the campaign
 * editor share exactly one implementation.
 */

import { htmlToText } from "./body";

/** Overall verdict. `caution` or worse should make the operator look before sending. */
export type SpamBand = "good" | "caution" | "likely spam";

/** How hard a rule penalises. Derived from the weight, so the two never drift. */
export type SpamSeverity = "high" | "medium" | "low";

/** Which part of the campaign a rule looks at. */
export type SpamArea = "subject" | "body" | "structure";

export interface SpamFinding {
  /** Stable rule id (also the SPAM_WEIGHTS key) — one finding per rule. */
  id: SpamRuleId;
  area: SpamArea;
  severity: SpamSeverity;
  /** Points this finding subtracted from 100. */
  weight: number;
  /** What is wrong, with the concrete detail (counts, the offending words). */
  message: string;
  /** What to do about it. */
  fix: string;
}

export interface SpamCheckInput {
  subject?: string | null;
  html?: string | null;
  /** The text/plain alternative, if the template has one. */
  text?: string | null;
  from?: string | null;
  replyTo?: string | null;
  /**
   * Why the body could not be inspected, when the caller knows (e.g. an SMTP2GO
   * template renders its own body server-side). Shown verbatim in `skipped`.
   */
  bodyNote?: string | null;
  /**
   * Variables the caller could not resolve before checking (an unmapped contact
   * field in the editor's sample render — see src/shared/sampleValues.ts). They
   * are reported in `skipped`, which makes the result partial: the check refuses
   * to hand back a clean score over a variable it never resolved.
   */
  unresolvedVariables?: string[] | null;
}

export interface SpamCheckResult {
  /** 100 minus the findings' weights (floored at 0). Null when nothing could be scored. */
  score: number | null;
  /** Band for `score`. Null when the campaign was not fully checkable. */
  band: SpamBand | null;
  findings: SpamFinding[];
  /** Total weight subtracted. */
  penalty: number;
  /** Areas that WERE inspected. */
  checked: SpamArea[];
  /** What could NOT be inspected, and why — never silently reported as clean. */
  skipped: string[];
  /** False when any area had to be skipped: treat the result as partial, not green. */
  complete: boolean;
}

/* ───────────────────────────── weights and bands ───────────────────────────── */

/**
 * Every rule's penalty, in one table so the score is auditable by reading it.
 *
 * Weights are not linear in "how spammy a word feels": the rules that a
 * receiving filter acts on structurally (no unsubscribe, an empty subject, a
 * form in the body, hidden text, a link shortener) cost the most, and wording
 * rules cost less, because wording alone rarely decides placement.
 */
export const SPAM_WEIGHTS = {
  // Subject (the one field that lands in a header)
  subject_empty: 20,
  subject_spam_phrase: 15,
  subject_all_caps: 10,
  subject_exclamations: 8,
  subject_dollar: 8,
  subject_long: 6,
  // Body
  body_hidden_text: 15,
  body_image_heavy: 12,
  body_link_shortener: 12,
  body_display_none: 10,
  body_large_image: 8,
  body_many_links: 8,
  body_link_imbalance: 8,
  body_spam_phrase: 8,
  body_all_caps: 8,
  body_exclamations: 6,
  body_missing: 20,
  body_form_in_body: 12,
  body_bare_url: 6,
  body_attachment_mention: 6,
  // Structure / compliance
  unsubscribe_missing: 25,
  from_missing: 20,
  text_missing: 10,
  unrendered_variables: 8,
  reply_to_missing: 6,
  mailto_only: 6,
} as const;

export type SpamRuleId = keyof typeof SPAM_WEIGHTS;

/** score >= 90 is `good`; >= 60 is `caution`; anything lower is `likely spam`. */
export const BAND_GOOD_MIN = 90;
export const BAND_CAUTION_MIN = 60;

export function bandFor(score: number): SpamBand {
  if (score >= BAND_GOOD_MIN) return "good";
  if (score >= BAND_CAUTION_MIN) return "caution";
  return "likely spam";
}

/** High >= 15, medium >= 8, low below that. Kept in one place so severity always matches weight. */
export function severityFor(weight: number): SpamSeverity {
  if (weight >= 15) return "high";
  if (weight >= 8) return "medium";
  return "low";
}

/* ──────────────────────────── tuning constants ──────────────────────────── */

/** A subject longer than this is hard to scan and easy to truncate in a client. */
export const SUBJECT_LONG_AT = 78;
/** Fewer words than this next to an image is an image-led email. */
export const IMAGE_HEAVY_MAX_WORDS = 50;
/** An image at least this wide (or width="100%") dominates the message. */
export const IMAGE_WIDTH_WARN = 600;
/** Absolute link ceiling for one email. */
export const MANY_LINKS_AT = 15;
/** Link-count-to-text rule: links are only suspicious above this floor… */
export const LINK_IMBALANCE_MIN = 5;
/** …and above one link per this many words. */
export const WORDS_PER_LINK = 50;
/** Exclamation marks in the body before it reads as shouting. */
export const BODY_EXCLAMATIONS_AT = 5;
/** Consecutive ALL-CAPS words in the body before it reads as shouting. */
export const BODY_CAPS_RUN_AT = 5;

/**
 * Words that are ALL CAPS in ordinary professional mail. Kept short on purpose:
 * anything here stops being a spam signal, so it has to be a word nobody shouts.
 */
const CAPS_ALLOW = new Set([
  "HTML", "PDF", "FAQ", "CEO", "CTO", "ASAP", "NSW", "VIC", "QLD", "WA", "SA",
  "TAS", "ACT", "NT", "AU", "USA", "UK", "NZ", "GST", "ABN", "SMS", "ID", "OK",
  "SEO", "ROI", "AEST", "AEDT", "AM", "PM", "CBD", "GP", "API", "URL", "EMR",
]);

/** Phrases that read as promotion rather than correspondence. */
const SPAM_PHRASES: RegExp[] = [
  /\bfree\b/i,
  /\b100%\s*(free|guaranteed)\b/i,
  /\bguarantee(?:d|s)?\b/i,
  /\bact now\b/i,
  /\b(?:limited[- ]time|expires (?:today|soon)|only \d+ (?:left|spots))\b/i,
  /\b(?:click here|click below)\b/i,
  /\b(?:buy now|order now|apply now)\b/i,
  /\b(?:risk[- ]free|no obligation|money[- ]back)\b/i,
  /\b(?:congratulations|you (?:have )?won|winner|jackpot)\b/i,
  /\b(?:cash|prize)\b/i,
  /\b(?:urgent|hurry)\b/i,
  /\b(?:viagra|cialis|pharmacy|pills)\b/i,
  /\b(?:credit card|loan|mortgage|debt)\b/i,
  /\b(?:unsecured|pre[- ]approved)\b/i,
  /\bcheap(?:est)?\b/i,
];

/** Hosts that hide the real destination — classic phishing/filter signal. */
const SHORTENER_HOSTS = [
  "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly",
  "rb.gy", "cutt.ly", "shorturl.at", "rebrand.ly", "tiny.cc", "lnkd.in",
  "trib.al", "bit.do", "adf.ly", "qr.ae", "shorte.st", "soo.gd",
];

/** A {{unsubscribe}} / {{unsubscribe_url}} style token, any spelling. */
const UNSUB_TOKEN_RE = /\{\{\{?\s*[A-Za-z0-9_.]*unsub[A-Za-z0-9_.]*\s*\}?\}\}/i;
/** Or an obvious opt-out written out: the link, its href, or "email preferences". */
const UNSUB_WORD_RE = /\bunsubscribe\b|\bopt[- ]?out\b|\bemail preferences\b/i;
/** Any remaining {{variable}} after rendering — the send will ship it literally. */
const MUSTACHE_VAR_RE = /\{\{\{?\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}?\}\}/g;
/** These are expected to survive rendering: the opt-out is injected by the sender. */
const EXPECTED_TOKENS = /^(?:content|unsub|unsubscribe|unsubscribe_url|unsubscribe_link|optout|opt_out)$/i;

/* ──────────────────────────────── helpers ──────────────────────────────── */

function styles(html: string): string[] {
  const out: string[] = [];
  const re = /style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[1] ?? m[2] ?? "");
  return out;
}

function hrefs(html: string): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push((m[1] ?? m[2] ?? "").trim());
  return out;
}

function hostOf(href: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(href);
  return (m?.[1] ?? "").toLowerCase().replace(/^www\./, "");
}

/** ALL-CAPS words worth counting: 4+ letters, minus the allowed acronyms. */
function capsWords(text: string): string[] {
  const out: string[] = [];
  const re = /\b[A-Z][A-Z'&-]{3,}\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const w = m[0].replace(/['&-]+$/, "");
    if (w.length >= 4 && !CAPS_ALLOW.has(w)) out.push(w);
  }
  return out;
}

/** Longest run of consecutive ALL-CAPS words (2+ letters) in a text. */
function capsRun(text: string): number {
  let best = 0;
  let cur = 0;
  for (const raw of text.split(/\s+/)) {
    const w = raw.replace(/[^A-Za-z'&-]/g, "");
    const upper = w.length >= 2 && /[A-Z]/.test(w) && w === w.toUpperCase();
    cur = upper ? cur + 1 : 0;
    if (cur > best) best = cur;
  }
  return best;
}

function matchedPhrases(text: string): string[] {
  const out: string[] = [];
  for (const re of SPAM_PHRASES) {
    const m = re.exec(text);
    if (m) out.push(JSON.stringify(m[0]));
  }
  return out;
}

function unrenderedVars(...parts: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    const re = new RegExp(MUSTACHE_VAR_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(part)) !== null) {
      const name = m[1];
      if (EXPECTED_TOKENS.test(name) || name.toLowerCase().startsWith("unsub")) continue;
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

function finding(
  id: SpamRuleId,
  area: SpamArea,
  message: string,
  fix: string,
): SpamFinding {
  const weight = SPAM_WEIGHTS[id];
  return { id, area, severity: severityFor(weight), weight, message, fix };
}

/* ─────────────────────────────── the check ─────────────────────────────── */

export function checkSpam(input: SpamCheckInput = {}): SpamCheckResult {
  const subject = String(input.subject ?? "").trim();
  const html = String(input.html ?? "");
  const text = String(input.text ?? "");
  const hasHtml = !!html.trim();
  const hasText = !!text.trim();
  const bodyAvailable = hasHtml || hasText;

  // Variables the caller could not resolve. Named, never silently treated as
  // resolved: this is what stops a half-mapped campaign from scoring clean.
  const unresolvedInput = (input.unresolvedVariables ?? [])
    .map((n) => String(n ?? "").trim())
    .filter(Boolean);
  const unresolvedNote = unresolvedInput.length
    ? `the ${unresolvedInput.length === 1 ? "variable" : "variables"} with no sample value: ${unresolvedInput
        .map((n) => `{{${n}}}`)
        .join(", ")}`
    : "";

  // Nothing rendered at all: we refuse to call this clean. A score would be a
  // fiction, so there is none — just what we could not look at and why.
  if (!subject && !bodyAvailable) {
    return {
      score: null,
      band: null,
      findings: [],
      penalty: 0,
      checked: [],
      skipped: [
        "the subject (nothing rendered yet)",
        "the body content (nothing rendered yet — pick a template and/or add the campaign content)",
        "the compliance details (unsubscribe, plain-text alternative) — no rendered campaign to inspect",
        ...(unresolvedNote ? [unresolvedNote] : []),
      ],
      complete: false,
    };
  }

  const findings: SpamFinding[] = [];
  const checked: SpamArea[] = [];
  const skipped: string[] = [];
  // Links are needed by the body rules and by the mailto-only structure check.
  const links = hrefs(html);
  const httpLinks = links.filter((h) => /^https?:\/\//i.test(h));

  /* ── subject ─────────────────────────────────────────────────────────── */

  checked.push("subject");
  if (!subject) {
    findings.push(
      finding(
        "subject_empty",
        "subject",
        "No subject line.",
        "Write one — set the campaign subject or give the template a subject. An empty subject is both a filter signal and a reason not to open.",
      ),
    );
  } else {
    const caps = capsWords(subject);
    const words = subject.split(/\s+/).filter(Boolean);
    const capsRatio = words.length ? caps.length / words.length : 0;
    const shouty =
      caps.length >= 2 ||
      (words.length >= 3 && capsRatio >= 0.6) ||
      (subject === subject.toUpperCase() && /[A-Z]{3,}/.test(subject));
    if (shouty) {
      findings.push(
        finding(
          "subject_all_caps",
          "subject",
          `ALL-CAPS words in the subject: ${caps.length ? caps.join(", ") : subject}.`,
          "Use sentence case and put the one important word in lower case too — shouting is a classic filter cue.",
        ),
      );
    }

    const bangs = (subject.match(/!/g) ?? []).length;
    if (bangs >= 3) {
      findings.push(
        finding(
          "subject_exclamations",
          "subject",
          `${bangs} exclamation marks in the subject.`,
          "Use at most one — and preferably none.",
        ),
      );
    }

    const dollars = (subject.match(/\$/g) ?? []).length;
    if (dollars >= 3) {
      findings.push(
        finding(
          "subject_dollar",
          "subject",
          `${dollars} "$" signs in the subject.`,
          "Describe the offer in words instead of a price scream in the subject.",
        ),
      );
    }

    const phrases = matchedPhrases(subject);
    if (phrases.length) {
      findings.push(
        finding(
          "subject_spam_phrase",
          "subject",
          `Promotional wording in the subject: ${phrases.join(", ")}.`,
          "Rewrite the subject as a plain statement of what the email contains.",
        ),
      );
    }

    if (subject.length > SUBJECT_LONG_AT) {
      findings.push(
        finding(
          "subject_long",
          "subject",
          `Subject is ${subject.length} characters (over ${SUBJECT_LONG_AT}).`,
          "Shorten it — long subjects get truncated in the client and read as bulk mail.",
        ),
      );
    }
  }

  /* ── body ────────────────────────────────────────────────────────────── */

  if (!bodyAvailable) {
    findings.push(
      finding(
        "body_missing",
        "body",
        "There is no rendered body to check.",
        "Pick a template (and add the campaign content if it uses a {{content}} slot) before sending.",
      ),
    );
    skipped.push(
      input.bodyNote?.trim() ||
        "the body content (no rendered HTML or text to inspect)",
    );
  } else {
    checked.push("body");

    const bodyText = [hasHtml ? htmlToText(html) : "", text].filter(Boolean).join("\n");
    const words = bodyText.split(/\s+/).filter(Boolean);
    const wordCount = words.length;
    const imgTags = html.match(/<img\b[^>]*>/gi) ?? [];
    const imageCount = imgTags.length;

    // Image-led mail: almost no text carrying the message.
    if (imageCount > 0 && wordCount < IMAGE_HEAVY_MAX_WORDS) {
      findings.push(
        finding(
          "body_image_heavy",
          "body",
          `${imageCount} image${imageCount === 1 ? "" : "s"} but only ${wordCount} word${wordCount === 1 ? "" : "s"} of text.`,
          "Add real text that carries the message — an email that is mostly an image looks like a picture-spam to filters and is unreadable with images off.",
        ),
      );
    }

    // One oversized image dominates the message.
    const bigImages = imgTags.filter((tag) => {
      const w = /width\s*=\s*["']?(\d+)["']?/i.exec(tag);
      const sw = /width\s*:\s*(\d+)\s*px/i.exec(tag);
      const pct = /width\s*=\s*["']100%["']/i.test(tag) || /width\s*:\s*100%/i.test(tag);
      const px = Math.max(Number(w?.[1] ?? 0), Number(sw?.[1] ?? 0));
      return pct || px >= IMAGE_WIDTH_WARN;
    });
    if (bigImages.length) {
      findings.push(
        finding(
          "body_large_image",
          "body",
          `${bigImages.length} full-width or oversized image${bigImages.length === 1 ? "" : "s"} (>= ${IMAGE_WIDTH_WARN}px).`,
          "Cap the images at roughly the email width (~600px) and keep the message in the text.",
        ),
      );
    }

    // Hidden content: the filter sees text the reader does not.
    const hidden: string[] = [];
    const styleList = styles(html);
    if (styleList.some((s) => /font-size\s*:\s*0(?:px|pt|em|%)?(?:\s|;|$)/i.test(s))) {
      hidden.push("font-size:0");
    }
    if (styleList.some((s) => /opacity\s*:\s*0(?:[.;"'\s]|$)/i.test(s))) hidden.push("opacity:0");
    if (styleList.some((s) => /visibility\s*:\s*hidden/i.test(s))) hidden.push("visibility:hidden");
    if (styleList.some((s) => /text-indent\s*:\s*-?\d{3,}px/i.test(s))) {
      hidden.push("text-indent off-screen");
    }
    if (
      styleList.some(
        (s) =>
          /(?:^|[;{\s])color\s*:\s*(?:#fff(?:fff)?|white)\b/i.test(s) &&
          /background(?:-color)?\s*:\s*(?:#fff(?:fff)?|white)\b/i.test(s),
      )
    ) {
      hidden.push("white text on a white background");
    }
    if (styleList.some((s) => /height\s*:\s*0(?:px)?\s*;[^"']*overflow\s*:\s*hidden/i.test(s))) {
      hidden.push("zero-height clipped block");
    }
    // A whole block hidden with display:none. Called out separately because the
    // inbox preheader is a legitimate use, not a trick.
    const displayNone = /display\s*:\s*none/i.test(html);

    if (hidden.length) {
      findings.push(
        finding(
          "body_hidden_text",
          "body",
          `Hidden text in the body: ${hidden.join(", ")}.`,
          "Remove it. Filters read hidden text and treat it as an attempt to fool them; if a block is decorative, delete it rather than hide it.",
        ),
      );
    }
    if (displayNone) {
      findings.push(
        finding(
          "body_display_none",
          "body",
          "A block is hidden with display:none.",
          "If that is the inbox preheader, keep it short and truthful — it is still readable by filters. Otherwise delete the block.",
        ),
      );
    }

    // Link shorteners.
    const shorteners = [...new Set(links.map(hostOf).filter((h) => SHORTENER_HOSTS.includes(h)))];
    if (shorteners.length) {
      findings.push(
        finding(
          "body_link_shortener",
          "body",
          `Shortened links: ${shorteners.join(", ")}.`,
          "Link to the real destination. Shorteners hide the target, which is exactly what phishing does — many filters and gateways reject or rewrite them.",
        ),
      );
    }

    if (links.length > MANY_LINKS_AT) {
      findings.push(
        finding(
          "body_many_links",
          "body",
          `${links.length} links in one email (over ${MANY_LINKS_AT}).`,
          "Keep only the links that matter — a link-dense email reads as bulk advertising.",
        ),
      );
    }

    // Link count against the amount of text.
    const linkAllowance = Math.max(LINK_IMBALANCE_MIN, Math.ceil(wordCount / WORDS_PER_LINK));
    if (links.length > linkAllowance) {
      findings.push(
        finding(
          "body_link_imbalance",
          "body",
          `${links.length} links against ${wordCount} words of text.`,
          "Either add the explanatory text each link needs, or drop links — links with no surrounding text are the pattern filters score against.",
        ),
      );
    }

    // Bare URLs in the HTML copy rather than a link. Deliberately HTML only: in
    // the text/plain alternative a URL cannot be a link, so its presence there
    // is correct, not a finding.
    const withoutAnchors = html.replace(/<a\b[\s\S]*?<\/a>/gi, " ");
    const residualText = htmlToText(withoutAnchors);
    if (/https?:\/\/\S+/i.test(residualText)) {
      findings.push(
        finding(
          "body_bare_url",
          "body",
          "A URL appears as plain text rather than as a link.",
          "Wrap it in an <a href> with a readable label (or drop it) — a raw URL in the copy is a common spam tell.",
        ),
      );
    }

    const phrases = matchedPhrases(bodyText);
    if (phrases.length) {
      findings.push(
        finding(
          "body_spam_phrase",
          "body",
          `Promotional wording in the body: ${phrases.join(", ")}.`,
          "Say it plainly. A single promotional word is not fatal, but they add up with the rest of the findings.",
        ),
      );
    }

    const bangs = (bodyText.match(/!/g) ?? []).length;
    if (bangs >= BODY_EXCLAMATIONS_AT) {
      findings.push(
        finding(
          "body_exclamations",
          "body",
          `${bangs} exclamation marks in the body.`,
          "Cut them back to one or two.",
        ),
      );
    }

    const caps = capsWords(bodyText);
    const run = capsRun(bodyText);
    if (run >= BODY_CAPS_RUN_AT || caps.length >= 10) {
      findings.push(
        finding(
          "body_all_caps",
          "body",
          `${caps.length} ALL-CAPS words${run >= BODY_CAPS_RUN_AT ? `, ${run} in a row` : ""} in the body.`,
          "Use sentence case. Shouted words lose their emphasis and read as spam.",
        ),
      );
    }

    // Forms in email: many filters hate them, and most clients strip them.
    if (/<\s*(?:form|input|textarea|select)\b/i.test(html)) {
      findings.push(
        finding(
          "body_form_in_body",
          "body",
          "The body contains a form field (<form>/<input>/<textarea>/<select>).",
          "Replace it with a link to a real page. Form tags in an email are stripped by many clients and are a strong filter signal.",
        ),
      );
    }

    if (
      /\b(?:see (?:the )?attach(?:ed|ment)|attached (?:file|document|pdf|invoice)|download the attachment|in the attachment)\b/i.test(
        bodyText,
      )
    ) {
      findings.push(
        finding(
          "body_attachment_mention",
          "body",
          "The copy refers to an attachment.",
          "Link to the document on a web page instead — an unexpected attachment plus an attachment mention is a phishing pattern, and SMTP2GO is not attaching anything here.",
        ),
      );
    }
  }

  /* ── structure / compliance ──────────────────────────────────────────── */

  // from/reply-to are campaign fields, so they are checkable even with no body.
  checked.push("structure");
  if (!String(input.from ?? "").trim()) {
    findings.push(
      finding(
        "from_missing",
        "structure",
        "No from address on this campaign.",
        "Set a From email on a domain you have verified in SMTP2GO (DKIM/SPF). A missing or unverified sender is the fastest way to the spam folder.",
      ),
    );
  }
  if (!String(input.replyTo ?? "").trim()) {
    findings.push(
      finding(
        "reply_to_missing",
        "structure",
        "No reply-to address.",
        "Add a monitored reply-to. It is a mild signal, but it also makes replies land where someone reads them.",
      ),
    );
  }

  if (bodyAvailable) {
    const unsubscribe =
      UNSUB_TOKEN_RE.test(html) ||
      UNSUB_TOKEN_RE.test(text) ||
      UNSUB_WORD_RE.test(htmlToText(html)) ||
      UNSUB_WORD_RE.test(text) ||
      hrefs(html).some((h) => UNSUB_WORD_RE.test(h));
    if (!unsubscribe) {
      findings.push(
        finding(
          "unsubscribe_missing",
          "structure",
          "No unsubscribe / opt-out in the body.",
          "Add one: an obvious unsubscribe link, or the {{unsubscribe}} token your template replaces at send time. Unsubscribing has to be possible — it is required by anti-spam law and its absence is one of the most reliable filter signals there is.",
        ),
      );
    }

    if (!hasText) {
      findings.push(
        finding(
          "text_missing",
          "structure",
          "No plain-text alternative.",
          "Give the template a text body. A multipart message with a real text/plain half scores better and is readable everywhere.",
        ),
      );
    }

    const mailtoOnly = links.some((h) => /^mailto:/i.test(h)) && httpLinks.length === 0;
    if (mailtoOnly) {
      findings.push(
        finding(
          "mailto_only",
          "structure",
          "The only way to make contact is a mailto: link.",
          "Add a normal link (a page on your site) alongside it — a mailto-only contact looks like a form letter.",
        ),
      );
    }
  } else {
    skipped.push(
      "the unsubscribe check and the plain-text alternative (no rendered body to inspect)",
    );
  }

  // Unresolved variables: rendering left a {{name}} behind, so a recipient would
  // literally receive it. Honest reporting matters more than a tidy score here.
  const unresolved = unrenderedVars(subject, html, text);
  if (unresolved.length) {
    findings.push(
      finding(
        "unrendered_variables",
        "structure",
        `Unresolved variables will be sent as-is: ${unresolved
          .slice(0, 5)
          .map((n) => `{{${n}}}`)
          .join(", ")}${unresolved.length > 5 ? ` (+${unresolved.length - 5} more)` : ""}.`,
        "Map each variable to a contact field or a static value, or delete it. This check only saw the variables it could resolve, so fix these first and check again.",
      ),
    );
  }

  // A variable that could not be resolved makes the result partial, exactly like
  // any other area we had to skip — see unresolvedInput above.
  if (unresolvedNote) skipped.push(unresolvedNote);

  const penalty = findings.reduce((sum, f) => sum + f.weight, 0);
  const complete = skipped.length === 0 && checked.length > 0;
  const score = complete ? Math.max(0, 100 - penalty) : null;

  return {
    score,
    band: score === null ? null : bandFor(score),
    findings,
    penalty,
    checked,
    skipped,
    complete,
  };
}

/** Highest-severity findings first, for display. */
export function bySeverity(findings: readonly SpamFinding[]): SpamFinding[] {
  const rank: Record<SpamSeverity, number> = { high: 0, medium: 1, low: 2 };
  return [...findings].sort((a, b) => rank[a.severity] - rank[b.severity] || b.weight - a.weight);
}
