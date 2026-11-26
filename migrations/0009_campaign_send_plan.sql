-- 0009_campaign_send_plan.sql - per-campaign daily-batch ("drip") sending plan.
--
-- Until now a campaign was either sent immediately or released in one go at a
-- single scheduled_at moment; the send queue only paced individual queue
-- invocations. There was no per-day cap and no send window, so a segment of
-- thousands went out in one blast.
--
-- This adds an OPTIONAL plan, read by the every-minute cron dispatcher:
--   * daily_cap     - most recipients released per day (NULL = no cap).
--   * send_days     - allowed ISO weekdays, CSV, Mon=1 … Sun=7 (NULL = any day).
--   * send_time     - "HH:MM" local: the time the day's batch goes out
--                     (NULL = any time that day).
--   * send_timezone - IANA zone the window is measured in; NULL = the Worker's
--                     SEND_TIMEZONE var (default Australia/Brisbane, which has
--                     no daylight saving, so the boundary never shifts).
--
-- All four are nullable and purely additive, so every existing campaign keeps
-- today's behaviour exactly. No plan means "send all at once".
--
-- The dispatcher deliberately stores NO "batch released" marker. Each tick
-- recomputes the day's remaining allowance from what is already in `sends`, so a
-- cron that fires sixty times an hour — or a tick that is re-entered — cannot
-- double-send. That count is a time-window scan inside a local day, and this
-- index is what keeps it cheap as a campaign grows.

ALTER TABLE campaigns ADD COLUMN daily_cap INTEGER;
ALTER TABLE campaigns ADD COLUMN send_days TEXT;
ALTER TABLE campaigns ADD COLUMN send_time TEXT;
ALTER TABLE campaigns ADD COLUMN send_timezone TEXT;

CREATE INDEX idx_sends_campaign_queued ON sends(campaign_id, queued_at);
