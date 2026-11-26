/**
 * GHL tag → SMTP2GO template send — `POST /api/webhooks/send-template`.
 *
 * A GHL workflow applies a tag to a contact (e.g. `send_playbook`) and calls
 * this endpoint. Mail leaves through SMTP2GO as LocalDentists.au — the same
 * sender the clinic-report endpoint uses — so nothing about the send is GHL
 * branded, and the open/click events come back on the `sends` row.
 *
 * Pure helpers live here so they can be unit-tested without the Worker runtime.
 */

export const SEND_TEMPLATE_LIMITS = {
  email: 254,
  ghl_contact_id: 120,
  first_name: 120,
  clinic_name: 160,
  tag: 60,
  template_id: 40,
  fields: 50,
  field_value: 500,
} as const;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TEMPLATE_ID_SHAPE = /^[A-Za-z0-9_-]+$/;
const FIELD_KEY_SHAPE = /^[A-Za-z0-9_.-]+$/;

/**
 * The tag the GHL workflow applies → the SMTP2GO template id to send. A tag not
 * in here is refused rather than guessed at.
 */
export const TAG_TEMPLATE_MAP: Record<string, string> = {
  send_playbook: "playbook",
  send_ld_general_info: "services",
};

/** SMTP2GO template id for a GHL tag, or null when the tag is not mapped. */
export function templateIdForTag(tag: string): string | null {
  const key = tag.trim().toLowerCase();
  return TAG_TEMPLATE_MAP[key] ?? null;
}

export interface SendTemplateInput {
  ghl_contact_id: string;
  email: string;
  first_name: string;
  clinic_name: string;
  /** Explicit SMTP2GO template id; wins over `tag` when both are supplied. */
  template_id: string;
  /** The GHL tag the workflow applied (mapped to a template when no explicit id). */
  tag: string;
  /** Extra template variables, already normalised to strings. */
  fields: Record<string, string>;
}

export interface SendTemplateValidation {
  ok: boolean;
  errors: Record<string, string>;
  values: SendTemplateInput;
}

/** Header-bound values must not carry CR/LF into a header. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function validateSendTemplate(body: unknown): SendTemplateValidation {
  const errors: Record<string, string> = {};
  const raw = (body ?? {}) as Record<string, unknown>;
  const str = (key: string): string => (typeof raw[key] === "string" ? (raw[key] as string) : "");

  const ghl_contact_id = oneLine(str("ghl_contact_id"));
  const email = oneLine(str("email"));
  const first_name = oneLine(str("first_name"));
  const clinic_name = oneLine(str("clinic_name"));
  const tag = oneLine(str("tag")).toLowerCase();
  const explicitTemplateId = oneLine(str("template_id"));

  if (!ghl_contact_id) errors.ghl_contact_id = "required";
  else if (ghl_contact_id.length > SEND_TEMPLATE_LIMITS.ghl_contact_id)
    errors.ghl_contact_id = "too_long";

  if (!email) errors.email = "required";
  else if (email.length > SEND_TEMPLATE_LIMITS.email) errors.email = "too_long";
  else if (!EMAIL_SHAPE.test(email)) errors.email = "invalid";

  if (first_name.length > SEND_TEMPLATE_LIMITS.first_name) errors.first_name = "too_long";
  if (clinic_name.length > SEND_TEMPLATE_LIMITS.clinic_name) errors.clinic_name = "too_long";
  if (tag.length > SEND_TEMPLATE_LIMITS.tag) errors.tag = "too_long";

  let template_id = explicitTemplateId;
  if (template_id) {
    if (template_id.length > SEND_TEMPLATE_LIMITS.template_id) errors.template_id = "too_long";
    else if (!TEMPLATE_ID_SHAPE.test(template_id)) errors.template_id = "invalid";
  } else if (tag) {
    const mapped = templateIdForTag(tag);
    if (!mapped) errors.tag = "unknown";
    else template_id = mapped;
  } else {
    // Neither an explicit template nor a tag: there is nothing to send.
    errors.template_id = "required";
  }

  // `fields` become SMTP2GO template variables, so keep them flat scalars.
  const fields: Record<string, string> = {};
  const fieldsRaw = raw["fields"];
  if (fieldsRaw != null) {
    if (typeof fieldsRaw !== "object" || Array.isArray(fieldsRaw)) {
      errors.fields = "invalid";
    } else {
      const entries = Object.entries(fieldsRaw as Record<string, unknown>);
      if (entries.length > SEND_TEMPLATE_LIMITS.fields) {
        errors.fields = "too_many";
      } else {
        for (const [key, value] of entries) {
          if (!FIELD_KEY_SHAPE.test(key)) {
            errors.fields = "invalid";
            break;
          }
          const isScalar =
            typeof value === "string" || typeof value === "number" || typeof value === "boolean";
          if (!isScalar) {
            errors.fields = "invalid";
            break;
          }
          if (String(value).length > SEND_TEMPLATE_LIMITS.field_value) {
            errors.fields = "too_long";
            break;
          }
          fields[key] = String(value);
        }
      }
    }
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    values: {
      ghl_contact_id,
      email,
      first_name,
      clinic_name,
      template_id,
      tag,
      fields,
    },
  };
}

/**
 * SMTP2GO `template_data` for the send: the supplied fields, with the first name
 * and clinic name laid over the top when present. Only set keys are included, so
 * an absent optional value never blanks a template variable.
 */
export function buildTemplateData(
  first_name: string,
  clinic_name: string,
  fields: Record<string, string>,
): Record<string, string> {
  const data: Record<string, string> = { ...fields };
  if (first_name) data.first_name = first_name;
  if (clinic_name) data.clinic_name = clinic_name;
  return data;
}
