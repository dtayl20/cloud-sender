import { Hono } from "hono";
import type { Env } from "../types";
import { checkDeliverability, resolveCheckDomain } from "../deliverability";

export const deliverabilityRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/deliverability?domain=<d>&from=<email>&fresh=1
 *
 * Runs the DNS checks (SPF, DMARC, MX), the SMTP2GO DKIM/verification check and
 * the From/DKIM alignment check for one sending domain. `domain` may be
 * omitted, in which case the From address's domain is used, else the Worker's
 * DEFAULT_FROM_EMAIL domain.
 *
 * `fresh=1` skips the isolate DNS cache for this request, so the panel's
 * "Check again" reflects a record added seconds ago instead of the cached
 * answer. Ordinary loads reuse the cache.
 *
 * Only domain names are looked up. No campaign content is read or sent
 * anywhere, and there is no third-party scanning service involved.
 */
deliverabilityRoutes.get("/", async (c) => {
  const domain = c.req.query("domain") ?? null;
  const from = c.req.query("from") ?? null;
  const noCache = c.req.query("fresh") === "1";

  if (!resolveCheckDomain(c.env, { domain, fromEmail: from })) {
    return c.json(
      { error: "no domain to check — pass ?domain=, or set a From address / DEFAULT_FROM_EMAIL" },
      400,
    );
  }

  const result = await checkDeliverability(c.env, { domain, fromEmail: from, noCache });
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});
