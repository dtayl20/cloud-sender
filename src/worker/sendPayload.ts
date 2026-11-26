/**
 * The one place a send's envelope is built.
 *
 * A test send exists to show what production will send, so the two paths must
 * agree on every header. They did not: `POST /:id/test` passed only `to`,
 * `sender`, `subject` and the body, so a test arrived with no Reply-To and no
 * X-Campaign-ID / X-Send-ID headers even when the campaign had them — exactly
 * the drift a test send is meant to catch. Both paths now call the builders
 * below, so they cannot disagree again.
 *
 * Reply-To travels as a `custom_headers` entry (see replyToHeader): SMTP2GO
 * accepts a top-level `reply_to` field with a 200 but does not put it on the
 * delivered message. Verified on the wire 2026-09-23 — a send with only a
 * top-level `reply_to` arrived with no Reply-To, while the same send with a
 * `custom_headers` `Reply-To` arrived with it. The dead top-level field has
 * been dropped rather than kept for company.
 */

import type { Smtp2goSendInput } from "./smtp2go";

export type CustomHeader = { header: string; value: string };

/** Who the message comes from: "Name <email>" when a name is set, else the address. */
export function senderLine(
  fromName: string | null | undefined,
  fromEmail: string | null | undefined,
): string {
  const name = (fromName ?? "").trim();
  const email = (fromEmail ?? "").trim();
  return name ? `${name} <${email}>` : email;
}

/**
 * Reply-To as a header value, or undefined when there is nothing to send. An
 * unset, blank or whitespace-only reply address must not become an empty
 * `Reply-To:` header, which is malformed and worse than none.
 */
export function replyToHeader(replyTo: string | null | undefined): string | undefined {
  const value = (replyTo ?? "").trim();
  return value ? value : undefined;
}

/**
 * The custom headers a send carries: campaign/send identity for traceability
 * plus Reply-To when the campaign has one. `sendId` is absent for a test send
 * (nothing is queued, so there is no send row) and is simply omitted.
 */
export function customHeaders(opts: {
  campaignId: number | null | undefined;
  sendId?: number | null;
  replyTo?: string | null;
}): CustomHeader[] {
  const headers: CustomHeader[] = [];
  if (opts.campaignId != null) {
    headers.push({ header: "X-Campaign-ID", value: String(opts.campaignId) });
  }
  if (opts.sendId != null) {
    headers.push({ header: "X-Send-ID", value: String(opts.sendId) });
  }
  const reply = replyToHeader(opts.replyTo);
  if (reply) headers.push({ header: "Reply-To", value: reply });
  return headers;
}

/**
 * Everything a send needs beyond the body: the sender line, the resolved
 * subject and the headers. Both the queue consumer and the test-send route
 * build their payload through this, so "what a test sends" is what production
 * sends by construction.
 */
export function sendEnvelope(input: {
  campaignId: number | null | undefined;
  sendId?: number | null;
  fromName?: string | null;
  fromEmail?: string | null;
  replyTo?: string | null;
  subject: string;
}): Pick<Smtp2goSendInput, "sender" | "subject" | "custom_headers"> {
  return {
    sender: senderLine(input.fromName, input.fromEmail),
    subject: input.subject,
    custom_headers: customHeaders({
      campaignId: input.campaignId,
      sendId: input.sendId,
      replyTo: input.replyTo,
    }),
  };
}
