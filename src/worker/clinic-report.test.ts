import { describe, expect, it } from "vitest";
import {
  buildClinicReportMail,
  fillPlaceholders,
  isAllowedReportUrl,
  validateClinicReport,
  type ClinicReportInput,
} from "./clinicReport";

const base = {
  email: "manager@clinic.com.au",
  clinic_name: "Harbourview Dental",
  report_url: "https://localdentists.au/report/123",
  name: "",
  subject: "",
  body: "",
};

describe("isAllowedReportUrl", () => {
  it("accepts https links on localdentists.au and its subdomains", () => {
    expect(isAllowedReportUrl("https://localdentists.au/report/123")).toBe(true);
    expect(isAllowedReportUrl("https://www.localdentists.au/report/123")).toBe(true);
    expect(isAllowedReportUrl("https://reports.localdentists.au/abc")).toBe(true);
  });

  it("refuses other hosts, http, and lookalikes", () => {
    expect(isAllowedReportUrl("http://localdentists.au/report/1")).toBe(false);
    expect(isAllowedReportUrl("https://evil.com/r")).toBe(false);
    expect(isAllowedReportUrl("https://localdentists.au.evil.com/r")).toBe(false);
    expect(isAllowedReportUrl("not a url")).toBe(false);
  });
});

describe("validateClinicReport", () => {
  it("accepts a well-formed payload and defaults the optional copy to empty", () => {
    const r = validateClinicReport(base);
    expect(r.ok).toBe(true);
    expect(r.values.name).toBe("");
    expect(r.values.subject).toBe("");
    expect(r.values.body).toBe("");
  });

  it("requires email, clinic name and report url", () => {
    const r = validateClinicReport({});
    expect(r.ok).toBe(false);
    expect(Object.keys(r.errors).sort()).toEqual(["clinic_name", "email", "report_url"]);
  });

  it("rejects a bad email and an off-domain report link", () => {
    const r = validateClinicReport({ ...base, email: "nope", report_url: "https://other.com/r" });
    expect(r.errors.email).toBe("invalid");
    expect(r.errors.report_url).toBe("not_allowed");
  });

  it("flattens newlines out of header-bound fields", () => {
    const r = validateClinicReport({ ...base, clinic_name: "Harbourview\nBcc: x@y.com" });
    expect(r.values.clinic_name).toBe("Harbourview Bcc: x@y.com");
  });

  it("caps the clinic name and the custom copy", () => {
    expect(validateClinicReport({ ...base, clinic_name: "x".repeat(200) }).errors.clinic_name).toBe("too_long");
    expect(validateClinicReport({ ...base, subject: "x".repeat(300) }).errors.subject).toBe("too_long");
    expect(validateClinicReport({ ...base, body: "x".repeat(7000) }).errors.body).toBe("too_long");
  });
});

describe("fillPlaceholders", () => {
  const values = { ...base, name: "Sam" } as ClinicReportInput;

  it("replaces the three GHL placeholders, in any spacing or case", () => {
    const out = fillPlaceholders("Hi {{name}} at {{ clinic_name }} — {{REPORT_URL}}", values);
    expect(out).toBe("Hi Sam at Harbourview Dental — https://localdentists.au/report/123");
  });

  it("leaves unknown braces alone", () => {
    expect(fillPlaceholders("{{contact.email}}", values)).toBe("{{contact.email}}");
  });
});

describe("buildClinicReportMail", () => {
  it("uses the built-in copy when no custom subject or body is supplied", () => {
    const mail = buildClinicReportMail({ ...base, name: "Sam" } as ClinicReportInput);
    expect(mail.subject).toContain("Harbourview Dental");
    expect(mail.text).toContain("https://localdentists.au/report/123");
    expect(mail.html).toContain('href="https://localdentists.au/report/123"');
  });

  it("uses the GHL-supplied copy verbatim, with placeholders filled", () => {
    const mail = buildClinicReportMail({
      ...base,
      name: "Sam",
      subject: "Report for {{clinic_name}}",
      body: "Hi {{name}},\nSee {{report_url}}\nTa.",
    } as ClinicReportInput);
    expect(mail.subject).toBe("Report for Harbourview Dental");
    expect(mail.text).toBe("Hi Sam,\nSee https://localdentists.au/report/123\nTa.");
    expect(mail.html).toContain("<br />");
    expect(mail.html).toContain('href="https://localdentists.au/report/123"');
  });

  it("escapes interpolated values, so supplied HTML cannot become markup", () => {
    const mail = buildClinicReportMail({
      ...base,
      clinic_name: '<img src=x onerror="alert(1)">',
      body: '<script>alert(1)</script> {{clinic_name}}',
    } as ClinicReportInput);
    expect(mail.html).not.toContain("<img");
    expect(mail.html).not.toContain("<script");
    expect(mail.html).toContain("&lt;script&gt;");
  });
});

describe("template_id", () => {
  it("is optional and defaults to empty", () => {
    expect(validateClinicReport(base).values.template_id).toBe("");
  });

  it("accepts an alphanumeric id and rejects junk", () => {
    expect(validateClinicReport({ ...base, template_id: "1234567" }).ok).toBe(true);
    expect(validateClinicReport({ ...base, template_id: "123 456" }).errors.template_id).toBe("invalid");
    expect(validateClinicReport({ ...base, template_id: "x".repeat(60) }).errors.template_id).toBe("too_long");
  });
});
