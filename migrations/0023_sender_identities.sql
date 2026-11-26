-- 0023_sender_identities.sql - named from-identities backed by a verified
-- SMTP2GO sending domain.
--
-- The owner only ever sends through SMTP2Go. A Sender identity is a named
-- from-identity (from_name + from_email + reply_to) that is BOUND to one of the
-- SMTP2GO account's verified sending domains.
--
-- HARD RULE enforced by the API (routes/senderIdentities.ts) and again at send
-- time (worker/senderDomain.ts): the domain of `from_email` MUST be a verified
-- SMTP2GO sending domain. The concrete case this prevents is sending
-- `something@example.com` while the send would actually go out over a
-- different verified domain. An identity is refused on save
-- when its from-address is not on a verified domain, and a send is refused
-- (fail closed) when the resolved identity's from-address domain and its bound
-- sending domain disagree.
--
-- `sending_domain` is stored denormalised (= the domain of from_email at save
-- time) so a send can refuse a mismatch deterministically, without a network
-- call, even if the SMTP2GO side later changes.
--
-- Additive only: one new table + one new nullable column on `sequences`. No
-- existing table is rebuilt, so the campaign send path is untouched.

CREATE TABLE IF NOT EXISTS sender_identities (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  from_name      TEXT,
  from_email     TEXT NOT NULL,
  reply_to       TEXT,
  -- The verified SMTP2GO sending domain this identity is bound to: the domain
  -- of from_email, validated against SMTP2GO's verified sender domains on save.
  sending_domain TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  is_default     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

-- At most one default identity. A partial unique index is the cheapest way to
-- make that a database invariant rather than a race in the API.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sender_identities_default
  ON sender_identities(is_default) WHERE is_default = 1;

-- A sequence may pick a sender identity. NULL = fall back to the default
-- identity, else to the sequence's own legacy from_* columns (so existing
-- sequences keep working unchanged).
ALTER TABLE sequences ADD COLUMN sender_identity_id INTEGER;
