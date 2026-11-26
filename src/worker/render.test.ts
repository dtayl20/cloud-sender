import { describe, expect, it } from "vitest";
import Mustache from "mustache";
import {
  acceptsCampaignBody,
  hasContentSlot,
  htmlToText,
  isBaseTemplate,
  mergeBody,
  plainTextToHtml,
} from "../shared/body";
import { bodyPlainText, render, renderBody } from "./render";

/** A miniature version of the seeded base template. */
const BASE_TEMPLATE = [
  "<!doctype html><body>",
  '<div class="header">LocalDentists.au</div>',
  '<div class="body">{{content}}</div>',
  '<div class="footer">localdentists.au</div>',
  "</body>",
].join("");

const VARS = { first_name: "Alex", practice_name: "Riverside Dental" };

describe("base template + campaign body", () => {
  it("injects the campaign body at the {{content}} slot", () => {
    const body = plainTextToHtml("Hello Alex\n\nSecond paragraph");
    const out = renderBody(BASE_TEMPLATE, VARS, body);

    expect(out).toContain('<div class="body"><p>Hello Alex</p>\n<p>Second paragraph</p></div>');
    // chrome is preserved on both sides of the body
    expect(out.indexOf("LocalDentists.au</div>")).toBeLessThan(out.indexOf("<p>Hello Alex</p>"));
    expect(out.indexOf("<p>Second paragraph</p>")).toBeLessThan(
      out.indexOf("localdentists.au</div>"),
    );
  });

  it("resolves variables inside the body, after injection", () => {
    const out = renderBody(
      BASE_TEMPLATE,
      VARS,
      plainTextToHtml("Hi {{first_name}} of {{practice_name}}"),
    );
    expect(out).toContain("Hi Alex of Riverside Dental");
  });

  it("escapes contact data in the body but never escapes the body's own markup", () => {
    const out = renderBody(
      BASE_TEMPLATE,
      { first_name: "A & B <script>" },
      plainTextToHtml("Hi {{first_name}}"),
    );
    expect(out).toContain("<p>Hi A &amp; B &lt;script&gt;</p>");
  });

  it("appends the body when the template has no {{content}} slot, never dropping it", () => {
    const noSlot = '<body><div class="header">LocalDentists.au</div></body>';
    const out = renderBody(noSlot, VARS, "<p>Body</p>");

    expect(hasContentSlot(noSlot)).toBe(false);
    expect(out).toBe(`${noSlot}<p>Body</p>`);
    expect(out).toContain("<p>Body</p>");
  });

  it("leaves the template alone when the campaign has no body (today's behaviour)", () => {
    expect(renderBody(BASE_TEMPLATE, VARS, null)).toBe(Mustache.render(BASE_TEMPLATE, VARS));
    expect(renderBody(BASE_TEMPLATE, VARS, undefined)).toBe(Mustache.render(BASE_TEMPLATE, VARS));
    expect(mergeBody(BASE_TEMPLATE, null)).toBe(BASE_TEMPLATE);
  });

  it("renders a non-base template byte-identically to before", () => {
    const plainTemplate = "<h1>{{first_name}}</h1><p>Template copy</p>";
    const html = render(plainTemplate, VARS);

    expect(renderBody(plainTemplate, VARS, null)).toBe(html);
    expect(renderBody(plainTemplate, VARS, undefined)).toBe(html);
    expect(renderBody(plainTemplate, VARS)).toBe(html);
  });

  it("reduces the body to plain text for a base template's text half", () => {
    const body = plainTextToHtml("One\n\nTwo & three");
    expect(bodyPlainText(body)).toBe("One\n\nTwo & three");
    expect(htmlToText(body)).toBe("One\n\nTwo & three");
    expect(bodyPlainText(null)).toBeNull();
    expect(mergeBody("{{content}}\n\n--\nLocalDentists.au", bodyPlainText(body))).toBe(
      "One\n\nTwo & three\n\n--\nLocalDentists.au",
    );
  });

  it("treats blank and whitespace-only slots safely", () => {
    expect(mergeBody("a{{content}}b", "")).toBe("ab");
    expect(mergeBody("{{{content}}}|{{ content }}", "B")).toBe("B|B");
    // "$&" in the body must not be re-substituted by String.replace
    expect(mergeBody("x{{content}}y", "a$&b")).toBe("xa$&by");
  });
});

describe("plain text -> paragraphs", () => {
  it("turns blank lines into paragraphs and single newlines into breaks", () => {
    expect(plainTextToHtml("One\n\nTwo")).toBe("<p>One</p>\n<p>Two</p>");
    expect(plainTextToHtml("Line 1\nLine 2")).toBe("<p>Line 1<br />Line 2</p>");
    expect(plainTextToHtml("One\n\n\n\nTwo")).toBe("<p>One</p>\n<p>Two</p>");
  });

  it("escapes HTML the operator types and drops empty input", () => {
    expect(plainTextToHtml("A & B <b>")).toBe("<p>A &amp; B &lt;b&gt;</p>");
    expect(plainTextToHtml("   \n\n  ")).toBe("");
    expect(plainTextToHtml(null)).toBe("");
    expect(plainTextToHtml(undefined)).toBe("");
  });

  it("round-trips through htmlToText so the editor can re-open a saved body", () => {
    expect(htmlToText(plainTextToHtml("One\n\nTwo"))).toBe("One\n\nTwo");
  });
});

describe("base template detection", () => {
  it("recognises base templates and templates that can take a body", () => {
    expect(isBaseTemplate({ is_base: 1 })).toBe(true);
    expect(isBaseTemplate({ is_base: 0 })).toBe(false);
    expect(isBaseTemplate(null)).toBe(false);

    expect(acceptsCampaignBody({ is_base: 1, html: "no slot" })).toBe(true);
    expect(acceptsCampaignBody({ is_base: 0, html: "{{content}}" })).toBe(true);
    expect(acceptsCampaignBody({ is_base: 0, html: "<p>plain</p>" })).toBe(false);
  });
});
