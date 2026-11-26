-- 0021_sequence_timezone_backfill.sql - derive a contact's IANA timezone from
-- its state, where the state is present in the mirrored attributes JSON.
--
-- Pure data migration: additive and idempotent (the WHERE matches nothing on a
-- re-run). No table is rebuilt. Rows whose state is absent or unrecognised keep
-- timezone = NULL, which means "unknown" - the sequence's own send_timezone is
-- the fallback at send time (see src/shared/timezone.ts).
--
-- The mapping matches the state -> zone table in src/shared/timezone.ts:
--   NSW/ACT -> Australia/Sydney, VIC -> Australia/Melbourne, TAS -> Australia/Hobart,
--   QLD -> Australia/Brisbane, SA -> Australia/Adelaide, WA -> Australia/Perth,
--   NT -> Australia/Darwin.

UPDATE contacts
   SET timezone = CASE upper(trim(json_extract(attributes, '$.state')))
     WHEN 'NSW'         THEN 'Australia/Sydney'
     WHEN 'NEW SOUTH WALES' THEN 'Australia/Sydney'
     WHEN 'ACT'         THEN 'Australia/Sydney'
     WHEN 'AUSTRALIAN CAPITAL TERRITORY' THEN 'Australia/Sydney'
     WHEN 'VIC'         THEN 'Australia/Melbourne'
     WHEN 'VICTORIA'    THEN 'Australia/Melbourne'
     WHEN 'TAS'         THEN 'Australia/Hobart'
     WHEN 'TASMANIA'    THEN 'Australia/Hobart'
     WHEN 'QLD'         THEN 'Australia/Brisbane'
     WHEN 'QUEENSLAND'  THEN 'Australia/Brisbane'
     WHEN 'SA'          THEN 'Australia/Adelaide'
     WHEN 'SOUTH AUSTRALIA' THEN 'Australia/Adelaide'
     WHEN 'WA'          THEN 'Australia/Perth'
     WHEN 'WESTERN AUSTRALIA' THEN 'Australia/Perth'
     WHEN 'NT'          THEN 'Australia/Darwin'
     WHEN 'NORTHERN TERRITORY' THEN 'Australia/Darwin'
     ELSE NULL
   END
 WHERE timezone IS NULL
   AND json_extract(attributes, '$.state') IS NOT NULL
   AND CASE upper(trim(json_extract(attributes, '$.state')))
     WHEN 'NSW' THEN 1 WHEN 'NEW SOUTH WALES' THEN 1
     WHEN 'ACT' THEN 1 WHEN 'AUSTRALIAN CAPITAL TERRITORY' THEN 1
     WHEN 'VIC' THEN 1 WHEN 'VICTORIA' THEN 1
     WHEN 'TAS' THEN 1 WHEN 'TASMANIA' THEN 1
     WHEN 'QLD' THEN 1 WHEN 'QUEENSLAND' THEN 1
     WHEN 'SA' THEN 1 WHEN 'SOUTH AUSTRALIA' THEN 1
     WHEN 'WA' THEN 1 WHEN 'WESTERN AUSTRALIA' THEN 1
     WHEN 'NT' THEN 1 WHEN 'NORTHERN TERRITORY' THEN 1
     ELSE 0 END = 1;
