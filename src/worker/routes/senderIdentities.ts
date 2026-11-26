// Sender identities API. Mounted at /api/sender-identities (see worker/index.ts).
//
// The owner's hard rule (see senderDomain.ts) is enforced here on every write:
// an identity's From address must be on a verified SMTP2Go sending domain, or
// the save is refused. The Settings page reads the SMTP2Go domains from here so
// the verified set and the identities stay in one place.

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { Smtp2goError } from "../smtp2go";
import { readVerifiedDomains, refreshVerifiedDomains } from "../senderDomain";
import {
  createSenderIdentity,
  deleteSenderIdentity,
  listSenderIdentities,
  setDefaultSenderIdentity,
  updateSenderIdentity,
} from "../senderIdentities";

export const senderIdentitiesRoutes = new Hono<{ Bindings: Env }>();

/** 400 for a rule violation, 502 for SMTP2Go being unreachable. */
function failure(c: any, e: unknown) {
  if (e instanceof Smtp2goError) return c.json({ error: e.message, upstream_status: e.status }, 502);
  return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
}

const identitySchema = z.object({
  name: z.string().min(1).max(200),
  from_name: z.string().max(200).nullable().optional(),
  from_email: z.string().email(),
  reply_to: z.string().email().nullable().optional().or(z.literal("")),
  enabled: z.boolean().optional(),
  is_default: z.boolean().optional(),
});

senderIdentitiesRoutes.get("/", async (c) => {
  const rows = await listSenderIdentities(c.env);
  const snapshot = await readVerifiedDomains(c.env);
  return c.json({
    rows,
    verified_domains: snapshot?.domains ?? [],
    domains: snapshot?.records ?? [],
    synced_at: snapshot?.synced_at ?? null,
  });
});

// Read the SMTP2Go sender domains live and cache them. Drives the Settings
// panel's domain list and the send-time membership check.
senderIdentitiesRoutes.post("/sync-domains", async (c) => {
  try {
    const snapshot = await refreshVerifiedDomains(c.env);
    return c.json({ ok: true, ...snapshot });
  } catch (e) {
    return failure(c, e);
  }
});

senderIdentitiesRoutes.post("/", async (c) => {
  const parsed = identitySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const d = parsed.data;
  try {
    const row = await createSenderIdentity(c.env, {
      name: d.name,
      from_name: d.from_name ?? null,
      from_email: d.from_email,
      reply_to: d.reply_to || null,
      enabled: d.enabled,
      is_default: d.is_default,
    });
    return c.json({ ok: true, row });
  } catch (e) {
    return failure(c, e);
  }
});

senderIdentitiesRoutes.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id)) return c.json({ error: "invalid id" }, 400);
  const parsed = identitySchema.partial().safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const d = parsed.data;
  try {
    const row = await updateSenderIdentity(c.env, id, {
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(d.from_name !== undefined ? { from_name: d.from_name } : {}),
      ...(d.from_email !== undefined ? { from_email: d.from_email } : {}),
      ...(d.reply_to !== undefined ? { reply_to: d.reply_to || null } : {}),
      ...(d.enabled !== undefined ? { enabled: d.enabled } : {}),
      ...(d.is_default !== undefined ? { is_default: d.is_default } : {}),
    });
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true, row });
  } catch (e) {
    return failure(c, e);
  }
});

senderIdentitiesRoutes.post("/:id/default", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await setDefaultSenderIdentity(c.env, id);
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true, row });
});

senderIdentitiesRoutes.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const ok = await deleteSenderIdentity(c.env, id);
  if (!ok) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});
