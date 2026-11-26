-- 0008_campaign_sending_domain.sql - repair first-label sending domains.
--
-- The campaign editor's sending-domain picker read SMTP2GO's nested
-- /domain/view record one level too shallow: it took `domain.domain` (the
-- FIRST LABEL - "example") and looked for `suffix` at the wrong level,
-- so nothing was appended. Every campaign saved from that picker therefore
-- stored a bare label:
--
--   sending_domain = "example"      from_email = "hello@example.com"
--   sending_domain = "dentalscout"        from_email = "smile@dentalscout.com.au"
--
-- A bare label is not a domain, so the Deliverability panel looked up names
-- that do not exist ("_dmarc.example") and reported four failures plus
-- one unknown for a domain whose DNS and SMTP2GO setup were fine.
--
-- The picker is fixed and the API now refuses a dotless value, so this
-- migration only has to repair what is already stored. The real domain is
-- derived from each row's own From address - the one authoritative value on the
-- row - and only where that derivation actually yields a domain. Rows whose
-- From address is missing or produces no dotted domain are left untouched and
-- must be listed and fixed by hand rather than guessed at.
--
-- Bounded: touches only rows whose sending_domain has no dot.

UPDATE campaigns
   SET sending_domain = rtrim(
         lower(trim(substr(from_email, instr(from_email, '@') + 1))),
         '.'
       )
 WHERE sending_domain IS NOT NULL
   AND sending_domain <> ''
   -- Only rows where the stored value is not a domain at all.
   AND instr(sending_domain, '.') = 0
   -- Only rows where the From address can supply one.
   AND instr(from_email, '@') > 0
   AND instr(substr(from_email, instr(from_email, '@') + 1), '.') > 0
   -- ...and the derived value is a clean domain (no spaces, no double dots).
   AND instr(substr(from_email, instr(from_email, '@') + 1), ' ') = 0
   AND instr(substr(from_email, instr(from_email, '@') + 1), '..') = 0
   -- Never leave the column empty: the rtrim above must keep a dotted value.
   AND instr(rtrim(lower(substr(from_email, instr(from_email, '@') + 1)), '.'), '.') > 0;
