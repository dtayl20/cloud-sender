import type { Env } from "./types";
import { timezoneForState } from "../shared/timezone";

const IDENT = /^[A-Za-z0-9_]+$/;

export interface SourceTableCfg {
  id: number;
  table_name: string;
  email_column: string;
}

/** Only this mirrored table carries clinic ids, so only it gets outreach flags. */
export const CLINIC_SOURCE_TABLE = "dentists";

/**
 * Derived outreach flags, computed from the *other* D1 database (SOURCE_DB)
 * and merged into each mirrored contact's `attributes`.
 *
 * D1 cannot join across databases, so the small summary tables are read once
 * per sync (never per contact) and matched by clinic id here in the worker.
 *
 * `*Loaded` tracks whether that source table could actually be read. It keeps
 * the flags additive: an unreadable table leaves its key absent rather than
 * writing a false 0 for every clinic.
 */
export interface OutreachFlags {
  thumbsLoaded: boolean;
  scanLoaded: boolean;
  thumbIds: Set<number>;
  scanOkIds: Set<number>;
}

/**
 * Read clinic_thumbs / website_platforms / booking_platforms from SOURCE_DB.
 * Returns null when there is no source DB to read — the flags are then left
 * off entirely. Each read is best-effort: a failure marks that side unloaded
 * instead of failing the sync.
 */
export async function loadOutreachFlags(env: Env): Promise<OutreachFlags | null> {
  if (!env.SOURCE_DB) return null;

  const flags: OutreachFlags = {
    thumbsLoaded: false,
    scanLoaded: false,
    thumbIds: new Set<number>(),
    scanOkIds: new Set<number>(),
  };

  // has_thumb — a row in clinic_thumbs means a screenshot was captured.
  try {
    const res = await env.SOURCE_DB.prepare("SELECT id FROM clinic_thumbs").all<{ id: number }>();
    for (const r of res.results) {
      const n = Number(r.id);
      if (Number.isFinite(n)) flags.thumbIds.add(n);
    }
    flags.thumbsLoaded = true;
  } catch {
    // leave thumbsLoaded=false: has_thumb stays absent this run
  }

  // scan_ok — both scan tables have a resolved (status '200') row for the clinic.
  try {
    const wp = await env.SOURCE_DB.prepare(
      "SELECT id FROM website_platforms WHERE status = '200'",
    ).all<{ id: number }>();
    const bp = await env.SOURCE_DB.prepare(
      "SELECT id FROM booking_platforms WHERE status = '200'",
    ).all<{ id: number }>();
    const wpOk = new Set<number>();
    for (const r of wp.results) {
      const n = Number(r.id);
      if (Number.isFinite(n)) wpOk.add(n);
    }
    for (const r of bp.results) {
      const n = Number(r.id);
      if (Number.isFinite(n) && wpOk.has(n)) flags.scanOkIds.add(n);
    }
    flags.scanLoaded = true;
  } catch {
    // leave scanLoaded=false: scan_ok stays absent this run
  }

  return flags;
}

/**
 * Merge the derived flags into a contact's attribute blob. Additive: every
 * existing key is left in place and a flag is only written when its source
 * table was readable. `outreach_ok` is the single flag the audience uses and
 * needs both sides, so it is 0 (never absent) once anything loaded.
 */
export function applyOutreachFlags(
  extras: Record<string, unknown>,
  clinicId: number | null,
  flags: OutreachFlags | null,
): void {
  if (!flags) return;

  const hasThumb = clinicId != null && flags.thumbIds.has(clinicId);
  const scanOk = clinicId != null && flags.scanOkIds.has(clinicId);

  if (flags.thumbsLoaded) extras.has_thumb = hasThumb ? 1 : 0;
  if (flags.scanLoaded) extras.scan_ok = scanOk ? 1 : 0;
  if (flags.thumbsLoaded && flags.scanLoaded) {
    extras.outreach_ok = hasThumb && scanOk ? 1 : 0;
  } else {
    extras.outreach_ok = 0;
  }
}

async function pickKeyCols(env: Env, table: string): Promise<string[]> {
  const info = await env.SOURCE_DB!.prepare(`PRAGMA table_info(${table})`).all<{
    name: string;
    pk: number;
  }>();
  return info.results
    .filter((r) => (r.pk ?? 0) > 0)
    .sort((a, b) => (a.pk ?? 0) - (b.pk ?? 0))
    .map((r) => String(r.name));
}

function firstDefined(row: Record<string, any>, keys: string[]): any {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

export async function syncSourceTable(
  env: Env,
  cfg: SourceTableCfg,
  /** Precomputed by syncAll so the source tables are read once per sync. Omit to load here. */
  precomputedFlags?: OutreachFlags | null,
): Promise<{ table: string; scanned: number; upserted: number; disabled: number }> {
  if (!env.SOURCE_DB) throw new Error("SOURCE_DB binding not configured");
  if (!IDENT.test(cfg.table_name)) throw new Error("invalid table name");
  if (!IDENT.test(cfg.email_column)) throw new Error("invalid email column");

  const t = cfg.table_name;
  const emailCol = cfg.email_column;
  const pkCols = await pickKeyCols(env, t);
  const runStart = Math.floor(Date.now() / 1000);

  // Read the outreach summary tables once per sync (not once per contact).
  const outreachFlags =
    t === CLINIC_SOURCE_TABLE
      ? precomputedFlags === undefined
        ? await loadOutreachFlags(env)
        : precomputedFlags
      : null;

  const src = await env.SOURCE_DB.prepare(
    `SELECT rowid AS __rowid, * FROM ${t} LIMIT 100000`,
  ).all<Record<string, any>>();

  let upserted = 0;
  const stmts: D1PreparedStatement[] = [];
  for (const row of src.results) {
    const email = String(row[emailCol] ?? "").trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) continue;

    const keyVal = pkCols.length
      ? pkCols.map((c) => String(row[c] ?? "")).join("|")
      : String(row.__rowid);

    const extras: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === "__rowid" || k === emailCol) continue;
      if (["first_name", "last_name", "practice_name"].includes(k)) continue;
      extras[k] = v;
    }

    // Additive: derived flags ride along with the mirrored columns.
    if (outreachFlags) {
      const rawId = Number(row.id);
      applyOutreachFlags(extras, Number.isFinite(rawId) ? rawId : null, outreachFlags);
    }

    stmts.push(
      env.DB.prepare(
        `INSERT INTO contacts
           (email, first_name, last_name, practice_name, attributes, source, status,
            source_table, source_row_key, last_seen_at, email_status, timezone)
         VALUES (?,?,?,?,?,?, 'active', ?,?,?, 'pending', ?)
         ON CONFLICT(email) DO UPDATE SET
           first_name    = COALESCE(excluded.first_name, contacts.first_name),
           last_name     = COALESCE(excluded.last_name, contacts.last_name),
           practice_name = COALESCE(excluded.practice_name, contacts.practice_name),
           attributes    = excluded.attributes,
           source_table  = excluded.source_table,
           source_row_key = excluded.source_row_key,
           last_seen_at  = excluded.last_seen_at,
           timezone      = COALESCE(contacts.timezone, excluded.timezone),
           status = CASE WHEN contacts.status='disabled' THEN 'active' ELSE contacts.status END,
           updated_at = unixepoch()`,
      ).bind(
        email,
        firstDefined(row, ["first_name", "FirstName", "firstName", "given_name"]),
        firstDefined(row, ["last_name", "LastName", "lastName", "surname", "family_name"]),
        firstDefined(row, ["practice_name", "PracticeName", "practice", "company", "clinic", "business_name"]),
        JSON.stringify(extras),
        `source_db:${t}`,
        t,
        keyVal,
        runStart,
        timezoneForState(
          (extras as any).state ?? (extras as any).State ?? (row as any).state ?? (row as any).State ?? null,
        ),
      ),
    );
    upserted++;
  }

  const CHUNK = 50;
  for (let i = 0; i < stmts.length; i += CHUNK) {
    await env.DB.batch(stmts.slice(i, i + CHUNK));
  }

  const disabledRes = await env.DB.prepare(
    `UPDATE contacts SET status='disabled', updated_at=unixepoch()
     WHERE source_table = ?
       AND (last_seen_at IS NULL OR last_seen_at < ?)
       AND status != 'disabled'
       AND status != 'unsubscribed'
       AND status != 'complained'`,
  ).bind(t, runStart).run();

  await env.DB.prepare(
    `UPDATE source_tables SET last_synced_at=?, last_row_count=?, last_error=NULL WHERE id=?`,
  ).bind(runStart, upserted, cfg.id).run();

  return {
    table: t,
    scanned: src.results.length,
    upserted,
    disabled: Number((disabledRes.meta as any)?.changes ?? 0),
  };
}

export async function syncAll(env: Env): Promise<any[]> {
  const cfgs = await env.DB.prepare(
    "SELECT id, table_name, email_column FROM source_tables WHERE active=1 AND cron_enabled=1",
  ).all<SourceTableCfg>();

  // Read the outreach summary tables once for the whole run, then hand the
  // same map to every source table.
  let flags: OutreachFlags | null = null;
  try {
    flags = await loadOutreachFlags(env);
  } catch {
    flags = null;
  }

  const results: any[] = [];
  for (const cfg of cfgs.results) {
    try {
      results.push(await syncSourceTable(env, cfg, flags));
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      await env.DB.prepare("UPDATE source_tables SET last_error=? WHERE id=?").bind(msg, cfg.id).run();
      results.push({ table: cfg.table_name, error: msg });
    }
  }
  return results;
}
