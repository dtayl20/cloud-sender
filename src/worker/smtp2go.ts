// Minimal SMTP2GO REST client. Docs: https://apidoc.smtp2go.com/

const BASE = "https://api.smtp2go.com/v3";

export interface Smtp2goSendInput {
  api_key: string;
  to: string[];
  sender: string; // "Name <email@domain>"
  subject?: string;
  html_body?: string;
  text_body?: string;
  template_id?: string;
  version?: number;
  template_data?: Record<string, unknown>;
  // Reply-To rides in custom_headers: SMTP2GO accepts a top-level `reply_to`
  // with a 200 but never puts it on the delivered message (verified on the wire
  // 2026-09-23), so the field is deliberately not modelled here. See
  // worker/sendPayload.ts.
  custom_headers?: Array<{ header: string; value: string }>;
}

export interface Smtp2goSendResponse {
  request_id: string;
  data?: {
    succeeded?: number;
    failed?: number;
    failures?: string[];
    email_id?: string;
    error?: string;
    error_code?: string;
  };
}

export class Smtp2goError extends Error {
  constructor(public status: number, public body: string) {
    super(`SMTP2GO ${status}: ${body.slice(0, 300)}`);
  }
}

async function call<T>(apiKey: string, path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Smtp2go-Api-Key": apiKey },
    body: JSON.stringify({ api_key: apiKey, ...body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Smtp2goError(res.status, text);
  return JSON.parse(text) as T;
}

export async function smtp2goSend(apiKey: string, input: Omit<Smtp2goSendInput, "api_key">) {
  return call<Smtp2goSendResponse>(apiKey, "/email/send", input);
}

// SMTP2GO template list. Endpoints have varied across docs/versions; try the
// documented one and fall back to the legacy path so the dropdown populates
// regardless of which the account supports.
export interface Smtp2goTemplate {
  template_id: string;
  templatename?: string;
  name?: string;
  subject?: string;
}
export async function smtp2goListTemplates(apiKey: string): Promise<Smtp2goTemplate[]> {
  const paths = ["/templates/search", "/template/search"];
  let lastErr: unknown;
  for (const p of paths) {
    try {
      const r = await call<any>(apiKey, p, {});
      const raw: any[] =
        r?.data?.templates ??
        r?.data?.results ??
        (Array.isArray(r?.data) ? r.data : null) ??
        r?.templates ??
        [];
      const normalized = raw
        .map((t: any) => ({
          template_id: String(t.template_id ?? t.templateId ?? t.id ?? t.uuid ?? ""),
          templatename: t.templatename ?? t.template_name ?? t.name ?? t.title ?? "",
          subject: t.subject ?? t.template_subject ?? "",
        }))
        .filter((t) => t.template_id);
      return normalized;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export interface Smtp2goTemplateDetail {
  template_id: string;
  subject: string;
  html: string;
  text: string;
  template_variables: Record<string, unknown>;
}

export async function smtp2goGetTemplate(
  apiKey: string,
  templateId: string,
): Promise<Smtp2goTemplateDetail> {
  const paths = ["/template/view", "/templates/view", "/template/get"];
  let lastErr: unknown;
  for (const p of paths) {
    try {
      // SMTP2GO's documented /template/view payload uses `id`. Sending
      // `template_id` makes valid templates return 404 in some accounts.
      const r = await call<any>(apiKey, p, { id: templateId, template_id: templateId });
      const t: any = r?.data?.template ?? r?.data ?? r?.template ?? r;
      return {
        template_id: String(t?.template_id ?? t?.id ?? templateId),
        subject: String(t?.subject ?? t?.template_subject ?? ""),
        html: String(t?.html_body ?? t?.html ?? t?.template_body ?? t?.body ?? ""),
        text: String(t?.text_body ?? t?.text ?? ""),
        template_variables:
          t?.template_variables && typeof t.template_variables === "object"
            ? t.template_variables
            : {},
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// Extract Mustache-style {{ variable }} names from a template body.
// Ignores Mustache block/section tokens (#, /, ^, !, >, =) and common helper
// keywords so we surface only real data variables.
const MUSTACHE_RESERVED = new Set([
  "if", "else", "elseif", "endif", "unless", "each", "endeach",
  "for", "endfor", "with", "endwith", "this", ".",
  // The base-template slot: where a campaign body is injected. It is filled by
  // the merge step, not by a contact field, so it must never be mapped.
  "content",
]);
export function extractTemplateVars(...parts: string[]): string[] {
  const found = new Set<string>();
  const re = /\{\{\{?\s*([#\/\^!>=]?)\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}?\}\}/g;
  for (const src of parts) {
    if (!src) continue;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const sigil = m[1];
      if (sigil && sigil !== "") continue; // skip section/comment/partial tokens
      const name = m[2];
      if (!name) continue;
      const top = name.split(".")[0].toLowerCase();
      if (MUSTACHE_RESERVED.has(top)) continue;
      found.add(name);
    }
  }
  return Array.from(found);
}

export function extractTemplateVarsFromDetail(t: Smtp2goTemplateDetail): string[] {
  const found = new Set<string>();
  for (const name of Object.keys(t.template_variables ?? {})) {
    const clean = name.trim();
    if (clean) found.add(clean);
  }
  for (const name of extractTemplateVars(t.subject, t.html, t.text)) found.add(name);
  return Array.from(found);
}



// One sender domain. The live `/domain/view` response nests the record detail
// under `domain` (fulldomain, dkim_selector, dkim_value, rpath_selector,
// rpath_value, ...) with `trackers[]` alongside it; older/flat responses put the
// name directly on `domain`. Both shapes are typed here and normalised for the
// deliverability checks by shared/deliverability.ts.
export interface Smtp2goDomain {
  domain?: string | Record<string, any>;
  fulldomain?: string;
  domain_name?: string;
  status?: string;
  trackdomain_verified?: boolean;
  dkim_selector?: string;
  dkim_value?: string;
  dkim_verified?: boolean;
  dkim_status?: string;
  rpath_selector?: string;
  rpath_value?: string;
  rpath_verified?: boolean;
  rpath_status?: string;
  trackers?: any[];
}
export async function smtp2goListDomains(apiKey: string): Promise<Smtp2goDomain[]> {
  const paths = ["/domain/search", "/domains/search", "/domain/view"];
  let lastErr: unknown;
  for (const p of paths) {
    try {
      const r = await call<{ data?: { results?: Smtp2goDomain[]; domains?: Smtp2goDomain[] } }>(
        apiKey,
        p,
        {},
      );
      return r.data?.results ?? r.data?.domains ?? [];
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
