import { Hono } from "hono";
import type { Env } from "../types";
import { smtp2goListTemplates, smtp2goListDomains, smtp2goGetTemplate, extractTemplateVarsFromDetail, Smtp2goError } from "../smtp2go";

export const smtp2goRoutes = new Hono<{ Bindings: Env }>();

function err(e: unknown) {
  if (e instanceof Smtp2goError) return { status: e.status, message: e.message };
  return { status: 0, message: e instanceof Error ? e.message : String(e) };
}

smtp2goRoutes.get("/templates", async (c) => {
  if (!c.env.SMTP2GO_API_KEY) {
    return c.json({ templates: [], error: "SMTP2GO_API_KEY not set" });
  }
  try {
    const templates = await smtp2goListTemplates(c.env.SMTP2GO_API_KEY);
    return c.json({ templates });
  } catch (e) {
    const { status, message } = err(e);
    return c.json({ templates: [], error: message, upstream_status: status });
  }
});

// Fetch a specific SMTP2GO template and return the variables it references so
// the campaign editor can auto-populate the variable mapping rows.
smtp2goRoutes.get("/templates/:id/vars", async (c) => {
  if (!c.env.SMTP2GO_API_KEY) {
    return c.json({ vars: [], error: "SMTP2GO_API_KEY not set" });
  }
  const id = c.req.param("id");
  try {
    const t = await smtp2goGetTemplate(c.env.SMTP2GO_API_KEY, id);
    const vars = extractTemplateVarsFromDetail(t);
    return c.json({ vars, subject: t.subject });
  } catch (e) {
    const { status, message } = err(e);
    return c.json({ vars: [], error: message, upstream_status: status });
  }
});

smtp2goRoutes.get("/domains", async (c) => {
  if (!c.env.SMTP2GO_API_KEY) {
    return c.json({ domains: [], error: "SMTP2GO_API_KEY not set" });
  }
  try {
    const domains = await smtp2goListDomains(c.env.SMTP2GO_API_KEY);
    return c.json({ domains });
  } catch (e) {
    const { status, message } = err(e);
    return c.json({ domains: [], error: message, upstream_status: status });
  }
});

// Health check used by Settings page
smtp2goRoutes.get("/ping", async (c) => {
  if (!c.env.SMTP2GO_API_KEY) return c.json({ ok: false, error: "SMTP2GO_API_KEY not set" });
  try {
    const [templates, domains] = await Promise.all([
      smtp2goListTemplates(c.env.SMTP2GO_API_KEY).catch(() => []),
      smtp2goListDomains(c.env.SMTP2GO_API_KEY).catch(() => []),
    ]);
    return c.json({ ok: true, templates_count: templates.length, domains_count: domains.length });
  } catch (e) {
    return c.json({ ok: false, error: err(e).message });
  }
});

// SMTP2GO templates are referenced directly by external_template_id on the
// campaign — no import is needed. This endpoint cleans up legacy blank rows
// created by the old "Import" flow (source='smtp2go' with empty html).
smtp2goRoutes.post("/templates/cleanup-blank-imports", async (c) => {
  const r = await c.env.DB.prepare(
    "DELETE FROM templates WHERE source='smtp2go' AND (html IS NULL OR html='')",
  ).run();
  return c.json({ ok: true, deleted: r.meta.changes ?? 0 });
});
