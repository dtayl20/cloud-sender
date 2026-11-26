/**
 * Sender identities: named from-identities bound to a verified SMTP2Go sending
 * domain.
 *
 * Everything here is thin over the `sender_identities` table. The one rule that
 * matters lives in senderDomain.ts (`assertFromEmailVerified`, called on every
 * write; `sendDomainViolation`, called on every send).
 */

import type { Env } from "./types";
import { assertFromEmailVerified, fromEmailDomain } from "./senderDomain";

export interface SenderIdentityRow {
  id: number;
  name: string;
  from_name: string | null;
  from_email: string;
  reply_to: string | null;
  sending_domain: string;
  enabled: number;
  is_default: number;
  created_at: number;
  updated_at: number;
}

export interface SenderIdentityInput {
  name: string;
  from_name?: string | null;
  from_email: string;
  reply_to?: string | null;
  enabled?: boolean;
  is_default?: boolean;
}

const IDENTITY_COLS =
  "id, name, from_name, from_email, reply_to, sending_domain, enabled, is_default, created_at, updated_at";

export async function listSenderIdentities(env: Env): Promise<SenderIdentityRow[]> {
  const r = await env.DB.prepare(
    `SELECT ${IDENTITY_COLS} FROM sender_identities ORDER BY is_default DESC, name COLLATE NOCASE, id`,
  ).all<SenderIdentityRow>();
  return r.results ?? [];
}

export async function getSenderIdentity(env: Env, id: number): Promise<SenderIdentityRow | null> {
  if (!Number.isSafeInteger(id)) return null;
  try {
    return await env.DB.prepare(`SELECT ${IDENTITY_COLS} FROM sender_identities WHERE id=?`)
      .bind(id)
      .first<SenderIdentityRow>();
  } catch {
    // No sender_identities table yet (an unmigrated DB): fall back to legacy
    // from_* columns rather than failing the send.
    return null;
  }
}

export async function getDefaultSenderIdentity(env: Env): Promise<SenderIdentityRow | null> {
  try {
    return await env.DB.prepare(
      `SELECT ${IDENTITY_COLS} FROM sender_identities WHERE is_default=1 AND enabled=1 LIMIT 1`,
    ).first<SenderIdentityRow>();
  } catch {
    return null;
  }
}

/**
 * The identity a sequence's send should use: its explicit choice, else the
 * enabled default. Returns null when neither exists (the caller then falls back
 * to the sequence's own from_* columns).
 *
 * A disabled explicitly-chosen identity is still returned (so the send can fail
 * closed with a clear "disabled" message) rather than silently falling back to
 * the default and sending from the wrong identity.
 */
export async function resolveSequenceIdentity(
  env: Env,
  senderIdentityId: number | null | undefined,
): Promise<SenderIdentityRow | null> {
  if (senderIdentityId != null && Number.isSafeInteger(Number(senderIdentityId))) {
    const chosen = await getSenderIdentity(env, Number(senderIdentityId));
    if (chosen) return chosen;
  }
  return getDefaultSenderIdentity(env);
}

/** Validate a from-address against the live verified domains and return its domain. */
async function validatedDomain(env: Env, fromEmail: string): Promise<string> {
  await assertFromEmailVerified(env, fromEmail);
  const domain = fromEmailDomain(fromEmail);
  if (!domain) throw new Error(`From address "${fromEmail}" has no usable domain`);
  return domain;
}

async function clearOtherDefaults(env: Env, keepId: number): Promise<void> {
  await env.DB.prepare("UPDATE sender_identities SET is_default=0, updated_at=unixepoch() WHERE is_default=1 AND id<>?")
    .bind(keepId)
    .run();
}

export async function createSenderIdentity(env: Env, input: SenderIdentityInput): Promise<SenderIdentityRow> {
  const sendingDomain = await validatedDomain(env, input.from_email);
  const enabled = input.enabled === false ? 0 : 1;
  const isDefault = input.is_default ? 1 : 0;
  const r = await env.DB.prepare(
    `INSERT INTO sender_identities (name, from_name, from_email, reply_to, sending_domain, enabled, is_default)
     VALUES (?,?,?,?,?,?,?) RETURNING ${IDENTITY_COLS}`,
  )
    .bind(
      input.name.trim(),
      (input.from_name ?? "").trim() || null,
      input.from_email.trim(),
      (input.reply_to ?? "").trim() || null,
      sendingDomain,
      enabled,
      isDefault,
    )
    .first<SenderIdentityRow>();
  if (!r) throw new Error("failed to create sender identity");
  // A default must be enabled, and only one default may exist.
  if (isDefault && !enabled) {
    await env.DB.prepare("UPDATE sender_identities SET enabled=1, updated_at=unixepoch() WHERE id=?").bind(r.id).run();
    r.enabled = 1;
  }
  if (isDefault) await clearOtherDefaults(env, r.id);
  return r;
}

export async function updateSenderIdentity(
  env: Env,
  id: number,
  patch: Partial<SenderIdentityInput>,
): Promise<SenderIdentityRow | null> {
  const existing = await getSenderIdentity(env, id);
  if (!existing) return null;

  const nextEmail = patch.from_email != null ? patch.from_email.trim() : existing.from_email;
  // Re-validate the domain whenever the address changes (and, cheaply, whenever
  // it is supplied) so an address can never drift off its verified domain.
  let sendingDomain = existing.sending_domain;
  if (patch.from_email != null && nextEmail !== existing.from_email) {
    sendingDomain = await validatedDomain(env, nextEmail);
  }

  const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled === false ? 0 : 1;
  const isDefault = patch.is_default === undefined ? existing.is_default : patch.is_default ? 1 : 0;

  await env.DB.prepare(
    `UPDATE sender_identities
        SET name=?, from_name=?, from_email=?, reply_to=?, sending_domain=?, enabled=?, is_default=?, updated_at=unixepoch()
      WHERE id=?`,
  )
    .bind(
      patch.name != null ? patch.name.trim() : existing.name,
      patch.from_name !== undefined ? ((patch.from_name ?? "").trim() || null) : existing.from_name,
      nextEmail,
      patch.reply_to !== undefined ? ((patch.reply_to ?? "").trim() || null) : existing.reply_to,
      sendingDomain,
      // The default identity must stay enabled.
      isDefault ? 1 : enabled,
      isDefault,
      id,
    )
    .run();

  if (isDefault) await clearOtherDefaults(env, id);
  return getSenderIdentity(env, id);
}

export async function deleteSenderIdentity(env: Env, id: number): Promise<boolean> {
  const r = await env.DB.prepare("DELETE FROM sender_identities WHERE id=?").bind(id).run();
  return Number(r.meta?.changes ?? 0) > 0;
}

/** Mark one identity as the single default (and enable it). */
export async function setDefaultSenderIdentity(env: Env, id: number): Promise<SenderIdentityRow | null> {
  const existing = await getSenderIdentity(env, id);
  if (!existing) return null;
  await env.DB.prepare("UPDATE sender_identities SET is_default=0, updated_at=unixepoch() WHERE is_default=1").run();
  await env.DB.prepare("UPDATE sender_identities SET is_default=1, enabled=1, updated_at=unixepoch() WHERE id=?")
    .bind(id)
    .run();
  return getSenderIdentity(env, id);
}
