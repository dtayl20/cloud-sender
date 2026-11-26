-- 0019_verify_lock.sql - single-flight lease for the Bulk Email Checker pass.
--
-- Bulk Email Checker permits ONE concurrent connection. The 1-minute cron pass
-- (verifyPendingContacts) is sequential *within* a pass, but nothing stopped the
-- next tick from starting a second pass while the previous one was still running
-- (slow responses / retries / a long queue), which opens two connections and
-- trips the account's concurrency warning.
--
-- This table is a one-row lease. A pass must claim it with a single conditional
-- write (`INSERT ... ON CONFLICT(id) DO UPDATE ... WHERE started_at < stale`) and
-- only proceeds when that write reports 1 changed row. Because D1 serialises
-- writes and the guard is evaluated inside the same statement, exactly one pass
-- can win; a second concurrent pass sees the (young) lease and skips.
--
--   id          always 1 - the CHECK keeps this a single-row table
--   owner       opaque id of the pass holding the lease; the release DELETE is
--               guarded on it so a stale lease reclaimed by another pass cannot
--               be torn down by the original (late) holder's cleanup
--   started_at  unix seconds the lease was claimed; older than the stale timeout
--               (~5 min) means the holder died and the lease may be reclaimed
--
-- Additive only; no existing table or column is touched.

CREATE TABLE IF NOT EXISTS verify_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL,
  started_at INTEGER NOT NULL
);
