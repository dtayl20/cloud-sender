// Test-only D1 shim backed by Node's built-in SQLite (node:sqlite).
//
// It implements the small slice of the D1 API the Worker routes use
// (prepare / bind / all / first / run / batch) so route handlers can be
// exercised against real SQL — including the real migration files — without
// wrangler or miniflare. Nothing in src/worker imports this; it is only used
// from tests.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Row = Record<string, unknown>;

export function createTestD1() {
  // enableForeignKeyConstraints defaults to true, which is what we want: the
  // migration has to survive foreign key enforcement.
  const db = new DatabaseSync(":memory:");

  const makeStatement = (sql: string, binds: unknown[] = []) => ({
    bind(...args: unknown[]) {
      return makeStatement(sql, args);
    },
    async all<T = Row>() {
      return { results: db.prepare(sql).all(...(binds as never[])) as T[], success: true, meta: {} };
    },
    async first<T = Row>() {
      const rows = db.prepare(sql).all(...(binds as never[])) as T[];
      return rows.length ? rows[0] : null;
    },
    async run() {
      const r = db.prepare(sql).run(...(binds as never[]));
      return {
        success: true,
        results: [],
        meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) },
      };
    },
  });

  return {
    prepare: (sql: string) => makeStatement(sql),
    batch: (statements: { run: () => Promise<unknown> }[]) =>
      Promise.all(statements.map((s) => s.run())),
    exec: (sql: string) => {
      db.exec(sql);
    },
    /** Test helper: synchronous query returning rows. */
    sql: <T = Row>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
    close: () => db.close(),
  };
}

export type TestD1 = ReturnType<typeof createTestD1>;

/** migrations/ lives at the repo root, two levels up from src/test. */
export function migrationPath(file: string): string {
  return fileURLToPath(new URL(`../../migrations/${file}`, import.meta.url));
}

/**
 * Every migration, in apply order. One list so a new migration is added in one
 * place and every test sees the same schema.
 */
export const ALL_MIGRATIONS = [
  "0001_init.sql",
  "0002_segments.sql",
  "0003_campaign_var_mapping.sql",
  "0004_source_sync.sql",
  "0005_campaign_body.sql",
  "0006_campaign_tags.sql",
  "0007_campaign_subject.sql",
  "0008_campaign_sending_domain.sql",
  "0009_campaign_send_plan.sql",
  "0010_campaign_send_ramp.sql",
  "0011_campaign_send_spread.sql",
  "0012_contact_rate.sql",
  "0013_ghl_send_template.sql",
  "0014_ghl_engagement_writeback.sql",
  "0015_ghl_tag_trigger_campaign.sql",
  "0016_email_verification.sql",
  "0017_email_verification_backfill.sql",
  "0018_email_verify_queue.sql",
  "0019_verify_lock.sql",
  "0020_sequences.sql",
  "0021_sequence_timezone_backfill.sql",
  "0022_form_submission.sql",
  "0023_sender_identities.sql",
  "0024_sequence_step_content.sql",
];

/** Apply migration files, in the order given, to a test database. */
export function applyMigrations(d1: TestD1, files: string[]): void {
  for (const file of files) d1.exec(readFileSync(migrationPath(file), "utf8"));
}
