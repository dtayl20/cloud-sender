-- 0012_contact_rate.sql - per-IP rate limiting for the public contact endpoint.
--
-- `POST /api/contact` is the only unauthenticated, email-sending route on this
-- Worker (the rest of /api is behind Cloudflare Access), so it carries the only
-- abuse surface a stranger can reach. A honeypot drops the naive bots; this
-- table slows the rest.
--
-- The IP itself is never stored. It is SHA-256'd with the IP_SALT secret before
-- it reaches this table, so a row is a counter, not an address, and the table
-- cannot be turned into a visitor log. One row per hashed IP, holding the start
-- of the current window and how many submissions landed inside it; a submission
-- arriving after the window has elapsed simply restarts the count.
--
-- No cleanup job: a row is ~60 bytes and is reused the next time the same IP
-- submits, so the table only grows with distinct source addresses.

CREATE TABLE IF NOT EXISTS contact_rate (
  ip_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_contact_rate_window ON contact_rate (window_start);
