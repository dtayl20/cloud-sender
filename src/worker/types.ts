export interface Env {
  DB: D1Database;
  SOURCE_DB?: D1Database;
  SEND_QUEUE: Queue<SendJob>;
  ASSETS: Fetcher;
  SMTP2GO_API_KEY: string;
  WEBHOOK_TOKEN: string;
  DEFAULT_FROM_EMAIL?: string;
  DEFAULT_FROM_NAME?: string;
  /** Default IANA zone for a campaign's sending window (see SEND_TIMEZONE). */
  SEND_TIMEZONE?: string;

  // --- Public contact endpoint (POST /api/contact, see routes/contact.ts) ---
  /** Fixed recipient of website enquiries. Never read from the request. */
  CONTACT_TO_EMAIL?: string;
  /** Envelope sender for those enquiries; falls back to DEFAULT_FROM_EMAIL. */
  CONTACT_FROM_EMAIL?: string;
  CONTACT_FROM_NAME?: string;
  /** Extra comma-separated browser origins allowed to post. */
  CONTACT_ALLOWED_ORIGINS?: string;
  CONTACT_PREVIEW_SUFFIX?: string;
  CONTACT_RATE_LIMIT?: string;
  CONTACT_RATE_WINDOW_SECONDS?: string;
  /** Sender for the clinic-report re-send endpoint (defaults to DEFAULT_FROM_EMAIL). */
  REPORT_FROM_EMAIL?: string;
  REPORT_FROM_NAME?: string;
  /** Optional second bearer/token for the clinic-report endpoint, so the caller
   *  never needs to retrieve WEBHOOK_TOKEN. */
  REPORT_SEND_TOKEN?: string;
  /** Optional SMTP2GO template id for the clinic-report email, so the wording can
   *  be edited in SMTP2GO instead of the Worker. */
  REPORT_TEMPLATE_ID?: string;
  /** Salt for the rate limiter's IP hash (secret). */
  IP_SALT?: string;

  // --- Email verification (Bulk Email Checker, see worker/emailVerify.ts) ---
  /** BEC API key (32 chars). Unset => the cron pass is a no-op. */
  BULK_EMAIL_CHECKER_API?: string;
  /** Pause switch for the cron pass (also settable via the email_verify_paused
   *  settings key). Truthy => verifyPendingContacts is a no-op, so a manual run
   *  in the dashboard cannot collide. Default: unset (not paused). */
  VERIFY_PAUSED?: string;

  // --- GHL engagement write-back (see ghl.ts) ---
  /** GHL Private Integration token. Secret; unset => the write-back is skipped. */
  GHL_API_KEY?: string;
  /** GHL API base. Defaults to https://services.leadconnectorhq.com. */
  GHL_API_BASE?: string;
  /** GHL sub-account the contacts live in. Defaults to the Dental Scout location. */
  GHL_LOCATION_ID?: string;
  /** Tag applied on an open. Defaults to email_opened. */
  GHL_OPEN_TAG?: string;
  /** Tag applied on a click. Defaults to email_clicked. */
  GHL_CLICK_TAG?: string;
}

export interface SendJob {
  /** Campaign send. Absent on a sequence or test job. */
  campaign_id?: number | null;
  send_id?: number | null;
  contact_id: number | null;
  email: string;
  /** Sequence send: the owning sequence, and the sequence_sends row to fill in. */
  sequence_id?: number | null;
  sequence_send_id?: number | null;
  /**
   * TEST MODE: render and send one sequence step to `email` with no real send
   * row, no enrolment and no metric (recorded in sequence_test_sends only).
   */
  test?: boolean;
  /** Step position, used by a test job (which has no sequence_sends row). */
  step_position?: number | null;
}

export interface ContactRow {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  practice_name: string | null;
  attributes: string;
  status: string;
  source: string | null;
  created_at: number;
  updated_at: number;
  /** Email verification (0016): NULL = never checked, else pending|valid|risky|invalid|unknown. */
  email_status?: string | null;
  /** Unix seconds of the last check (0016). */
  email_verified_at?: number | null;
  /** 1 = the operator asked for this address to be (re)checked on the next pass (0018). */
  email_verify_queued?: number | null;
}

export interface CampaignRow {
  id: number;
  name: string;
  template_id: number | null;
  external_template_id: string | null;
  list_id: number | null;
  segment_id: number | null;
  audience_filter: string | null;
  var_mapping: string | null;
  /** Per-campaign body merged into a base template at {{content}}. NULL = none. */
  body_html: string | null;
  /** Per-campaign subject line. NULL = use the template's subject (today's behaviour). */
  subject: string | null;
  sending_domain: string | null;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  status: string;
  scheduled_at: number | null;
  /** Daily-batch plan - all nullable; no plan means "send all at once". */
  daily_cap: number | null;
  send_days: string | null;
  send_time: string | null;
  send_timezone: string | null;
  /** Optional ramp on the daily cap: first-day allowance, and days to full cap. */
  ramp_start: number | null;
  ramp_days: number | null;
  /** Minutes to spread each day's batch across (null = all at the window). */
  spread_minutes: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface TemplateRow {
  id: number;
  source: "local" | "smtp2go";
  external_id: string | null;
  name: string;
  subject: string;
  html: string;
  text: string | null;
  /** 1 = base template (chrome only); campaigns supply the body. */
  is_base: number;
  updated_at: number;
}
