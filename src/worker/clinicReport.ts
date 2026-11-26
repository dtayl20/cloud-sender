/**
 * Clinic-report re-send — `POST /api/webhooks/clinic-report`.
 *
 * The GHL Voice AI agent asks "can you send me the report again?" and the workflow
 * calls this endpoint. Mail leaves through SMTP2GO as LocalDentists.au rather than
 * through GHL's own sender, so nothing about the call or the mail is Dental Scout
 * branded.
 *
 * The wording can live in GHL (a Custom Value passed as `subject` / `body`), so it
 * is editable without touching this Worker. Inside that text three placeholders are
 * substituted: {{clinic_name}}, {{name}}, {{report_url}}.
 *
 * Pure helpers live here so they can be unit-tested without the Worker runtime.
 */

export const CLINIC_REPORT_LIMITS = {
  email: 254,
  clinic_name: 120,
  name: 120,
  report_url: 500,
  subject: 200,
  body: 6000,
  template_id: 40,
} as const;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** The only hosts a report link may point at — this endpoint is not a link relay. */
export const REPORT_HOSTS = ["localdentists.au"] as const;

export interface ClinicReportInput {
  email: string;
  clinic_name: string;
  report_url: string;
  name: string;
  subject: string;
  body: string;
  /** Optional SMTP2GO template id. When set, the template supplies the copy and
   *  the three placeholders are sent as template variables instead. */
  template_id: string;
}

export interface ClinicReportValidation {
  ok: boolean;
  errors: Record<string, string>;
  values: ClinicReportInput;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function isAllowedReportUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return REPORT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

export function validateClinicReport(body: unknown): ClinicReportValidation {
  const errors: Record<string, string> = {};
  const raw = (body ?? {}) as Record<string, unknown>;
  const str = (key: string): string => (typeof raw[key] === "string" ? (raw[key] as string).trim() : "");

  const email = oneLine(str("email"));
  const clinic_name = oneLine(str("clinic_name"));
  const report_url = str("report_url");
  const name = oneLine(str("name"));
  const subject = oneLine(str("subject"));
  const bodyText = str("body");
  const template_id = oneLine(str("template_id"));

  if (!email) errors.email = "required";
  else if (email.length > CLINIC_REPORT_LIMITS.email) errors.email = "too_long";
  else if (!EMAIL_SHAPE.test(email)) errors.email = "invalid";

  if (!clinic_name) errors.clinic_name = "required";
  else if (clinic_name.length > CLINIC_REPORT_LIMITS.clinic_name) errors.clinic_name = "too_long";

  if (!report_url) errors.report_url = "required";
  else if (report_url.length > CLINIC_REPORT_LIMITS.report_url) errors.report_url = "too_long";
  else if (!isAllowedReportUrl(report_url)) errors.report_url = "not_allowed";

  if (name.length > CLINIC_REPORT_LIMITS.name) errors.name = "too_long";
  if (subject.length > CLINIC_REPORT_LIMITS.subject) errors.subject = "too_long";
  if (bodyText.length > CLINIC_REPORT_LIMITS.body) errors.body = "too_long";
  if (template_id.length > CLINIC_REPORT_LIMITS.template_id) errors.template_id = "too_long";
  else if (template_id && !/^[A-Za-z0-9_-]+$/.test(template_id)) errors.template_id = "invalid";

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    values: { email, clinic_name, report_url, name, subject, body: bodyText, template_id },
  };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Substitute the three placeholders the GHL Custom Value can use. */
export function fillPlaceholders(template: string, values: ClinicReportInput): string {
  return template
    .replace(/\{\{\s*clinic_name\s*\}\}/gi, values.clinic_name)
    .replace(/\{\{\s*name\s*\}\}/gi, values.name)
    .replace(/\{\{\s*report_url\s*\}\}/gi, values.report_url);
}

export interface ClinicReportMail {
  subject: string;
  text: string;
  html: string;
}

const DEFAULT_BODY = [
  "Hi {{name}},",
  "",
  "Here's a copy of the clinic report for {{clinic_name}}:",
  "{{report_url}}",
  "",
  "It covers how your website handles patient enquiries after hours, and what",
  "we'd change. Reply to this email if you'd like me to walk you through it.",
  "",
  "Kind regards,",
  "LocalDentists.au",
].join("\n");

export function buildClinicReportMail(input: ClinicReportInput): ClinicReportMail {
  const subjectTemplate = input.subject || "Your clinic report from LocalDentists.au — {{clinic_name}}";
  const bodyTemplate = input.body || DEFAULT_BODY;

  const subject = fillPlaceholders(subjectTemplate, input).slice(0, 160);
  const text = fillPlaceholders(bodyTemplate, input);

  // Plain text -> HTML: escape everything first, then only the line breaks and the
  // (already escaped) report link become markup.
  const escapedUrl = escapeHtml(input.report_url);
  const html = escapeHtml(text)
    .replace(/\r?\n/g, "<br />")
    .split(escapedUrl)
    .join(`<a href="${escapedUrl}">${escapedUrl}</a>`);

  return { subject, text, html };
}
