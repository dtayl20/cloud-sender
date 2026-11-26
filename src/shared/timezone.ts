// State -> IANA timezone derivation for a contact's local send window.
//
// A sequence's send_time means LOCAL time for the contact, so the dispatcher
// needs a zone per contact. `contacts.timezone` holds that zone; it is derived
// from the contact's state on import/sync (and back-filled by migration 0021)
// and stored as an IANA name. When it is unknown the sequence's own
// send_timezone (or the Worker default) is the fallback.

/** Australian state/territory -> IANA zone. ACT/TAS have their own zones. */
export const STATE_TIMEZONES: Record<string, string> = {
  NSW: "Australia/Sydney",
  VIC: "Australia/Melbourne",
  TAS: "Australia/Hobart",
  ACT: "Australia/Sydney",
  QLD: "Australia/Brisbane",
  SA: "Australia/Adelaide",
  WA: "Australia/Perth",
  NT: "Australia/Darwin",
};

/** Long state names accepted alongside the two/three-letter codes. */
const STATE_ALIASES: Record<string, string> = {
  "NEW SOUTH WALES": "NSW",
  VICTORIA: "VIC",
  TASMANIA: "TAS",
  QUEENSLAND: "QLD",
  "SOUTH AUSTRALIA": "SA",
  "WESTERN AUSTRALIA": "WA",
  "NORTHERN TERRITORY": "NT",
  "AUSTRALIAN CAPITAL TERRITORY": "ACT",
};

/** Normalise a state string to its code, or null when unrecognised. */
export function normalizeState(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase();
  if (!s) return null;
  if (STATE_TIMEZONES[s]) return s;
  return STATE_ALIASES[s] ?? null;
}

/**
 * The IANA zone for a state, or null when the state is missing/unrecognised.
 * An explicit zone string that is already IANA-ish is passed through so callers
 * can feed either a state or a zone.
 */
export function timezoneForState(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Already an IANA zone?
  if (s.includes("/")) return s;
  const code = normalizeState(s);
  return code ? STATE_TIMEZONES[code] : null;
}

/**
 * Australian postcode -> state code, for a submission that carries a postcode
 * but no state. Only 4-digit postcodes are considered; the ranges are the
 * standard allocations, with the ACT's 2600-2618/2900-2920 carved out of NSW.
 * Returns null when the value is not a recognisable 4-digit postcode.
 */
export function stateForPostcode(raw: unknown): string | null {
  if (raw == null) return null;
  const digits = String(raw).replace(/[^0-9]/g, "");
  if (digits.length !== 4) return null;
  const n = Number(digits);
  if (n >= 800 && n <= 999) return "NT";
  if (n >= 1000 && n <= 2599) return "NSW";
  if (n >= 2600 && n <= 2618) return "ACT";
  if (n >= 2619 && n <= 2899) return "NSW";
  if (n >= 2900 && n <= 2920) return "ACT";
  if (n >= 2921 && n <= 2999) return "NSW";
  if (n >= 3000 && n <= 3999) return "VIC";
  if (n >= 4000 && n <= 4999) return "QLD";
  if (n >= 5000 && n <= 5999) return "SA";
  if (n >= 6000 && n <= 6999) return "WA";
  if (n >= 7000 && n <= 7999) return "TAS";
  if (n >= 8000 && n <= 8999) return "VIC";
  return null;
}

const TIMEZONE_STATE_KEYS = ["state", "State", "STATE", "state_code", "region", "province"];
const TIMEZONE_POSTCODE_KEYS = ["postcode", "post_code", "postal_code", "postCode", "zip", "Zip", "ZIP"];

/**
 * Derive a contact's timezone from its raw field bag, looking for a state in
 * the common keys (mirrored columns and the attributes JSON), then falling back
 * to an Australian postcode when no state is present. Returns null when nothing
 * recognisable is present - the caller falls back to the sequence zone.
 */
export function deriveTimezoneFromFields(fields: Record<string, unknown>): string | null {
  for (const key of TIMEZONE_STATE_KEYS) {
    if (key in fields) {
      const tz = timezoneForState(fields[key]);
      if (tz) return tz;
    }
  }
  for (const key of TIMEZONE_POSTCODE_KEYS) {
    const state = stateForPostcode(fields[key]);
    if (state) return STATE_TIMEZONES[state] ?? null;
  }
  return null;
}
