import type { Env, SendJob, ContactRow, CampaignRow, TemplateRow } from "./types";
import { smtp2goSend, Smtp2goError } from "./smtp2go";
import { sendEnvelope } from "./sendPayload";
import { bodyPlainText, contactVars, mappedVars, parseMapping, renderBody, renderSubject, renderText, renderTextBody, urlContextVars } from "./render";
import { settleFinishedCampaign } from "./routes/campaigns";
import { isSendBlocked } from "../shared/emailStatus";
import { resolveSequenceIdentity } from "./senderIdentities";
import { readVerifiedDomains, sendDomainViolation } from "./senderDomain";

export async function processSendBatch(batch: MessageBatch<SendJob>, env: Env): Promise<void> {
  const touched = new Set<number>();
  for (const msg of batch.messages) {
    try {
      if (msg.body.test) {
        await processTestSend(msg.body, env);
      } else if (msg.body.sequence_id) {
        await processSequenceSend(msg.body, env);
      } else {
        await processOne(msg.body, env);
        touched.add(Number(msg.body.campaign_id));
      }
      msg.ack();
    } catch (err) {
      if (err instanceof Smtp2goError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        // Permanent failure — mark and don't retry
        if (msg.body.sequence_id) await markSequenceFailed(env, msg.body, err.message);
        else await markFailed(env, Number(msg.body.send_id), err.message);
        msg.ack();
      } else {
        msg.retry({ delaySeconds: 30 });
        continue;
      }
    }
  }
  for (const cid of touched) {
    await maybeFinishCampaign(env, cid);
  }
}

/**
 * Send one sequence step. Reads the sequence_sends row by id, re-checks the
 * last-chance suppression / verification rules exactly like a campaign send, and
 * stamps the row. Idempotent: a row that already has sent_at is a no-op.
 */
async function processSequenceSend(job: SendJob, env: Env): Promise<void> {
  const db = env.DB;
  const row = await db
    .prepare("SELECT * FROM sequence_sends WHERE id=?")
    .bind(job.sequence_send_id)
    .first<any>();
  if (!row) return;
  if (row.sent_at) return; // already sent

  const seq = await db
    .prepare("SELECT * FROM sequences WHERE id=?")
    .bind(row.sequence_id)
    .first<any>();
  if (!seq) {
    await markSequenceFailed(env, job, "sequence missing");
    return;
  }
  if (seq.status === "paused" || seq.status === "draft" || seq.status === "archived") {
    throw new Error("sequence not active"); // retry later; a paused sequence resumes
  }

  const step = await db
    .prepare("SELECT * FROM sequence_steps WHERE id=?")
    .bind(row.step_id)
    .first<any>();
  if (!step) {
    await markSequenceFailed(env, job, "step missing");
    return;
  }

  const suppressed = await db
    .prepare("SELECT 1 AS x FROM suppressions WHERE email=?")
    .bind(row.email)
    .first();
  if (suppressed) {
    await db
      .prepare("UPDATE sequence_sends SET status='skipped', error='suppressed' WHERE id=?")
      .bind(row.id)
      .run();
    return;
  }

  const contact = row.contact_id
    ? await db.prepare("SELECT * FROM contacts WHERE id=?").bind(row.contact_id).first<ContactRow>()
    : null;
  if (contact && isSendBlocked(contact.email_status)) {
    await db
      .prepare("UPDATE sequence_sends SET status='skipped', error=? WHERE id=?")
      .bind(`email_status:${contact.email_status}`, row.id)
      .run();
    return;
  }

  const template = step.template_id
    ? await db.prepare("SELECT * FROM templates WHERE id=?").bind(step.template_id).first<TemplateRow>()
    : null;
  const externalTemplateId =
    step.external_template_id || (template?.source === "smtp2go" ? template.external_id : null);
  // A step with its own copy (0024) needs no template; a legacy step does.
  if (step.content_html == null && !template && !externalTemplateId) {
    await markSequenceFailed(env, job, "template missing");
    return;
  }

  const vars = contact ? contactVars(contact) : { email: row.email };
  // From identity: the sequence's choice, else the enabled default identity,
  // else the sequence's own legacy from_* columns (existing sequences keep
  // working). The domain rule is enforced below, fail closed.
  const identity = await resolveSequenceIdentity(env, seq.sender_identity_id);
  const fromEmail = identity?.from_email || seq.from_email || env.DEFAULT_FROM_EMAIL || "";
  const fromName = identity ? identity.from_name ?? "" : seq.from_name || env.DEFAULT_FROM_NAME || "";
  const replyTo = identity ? identity.reply_to ?? seq.reply_to : seq.reply_to;
  if (!fromEmail) {
    await markSequenceFailed(env, job, "no from address configured");
    return;
  }
  const domainViolation = sendDomainViolation({
    fromEmail,
    identityName: identity?.name ?? null,
    identityDomain: identity?.sending_domain ?? null,
    identityEnabled: identity ? Boolean(identity.enabled) : null,
    snapshot: await readVerifiedDomains(env),
  });
  if (domainViolation) {
    await markSequenceFailed(env, job, `sender_domain: ${domainViolation}`);
    return;
  }

  // A sequence send carries no campaign id, so the traceability headers are
  // omitted; Reply-To still travels when the sequence (or its identity) sets one.
  const envelope = (subject: string) =>
    sendEnvelope({
      campaignId: null,
      fromName,
      fromEmail,
      replyTo,
      subject,
    });

  // How the step email is built:
  //   * an attached in-app template -> the step's content goes into the template
  //     at {{content}} (the campaign model);
  //   * an SMTP2GO template        -> it renders its own body;
  //   * no template                -> the step's content IS the whole body.
  const localTemplate = template && !externalTemplateId ? template : null;
  const stepContent = step.content_html ?? step.body_html ?? null;
  const resp = localTemplate
    ? await smtp2goSend(env.SMTP2GO_API_KEY, {
        ...envelope(renderSubject(step.subject, localTemplate.subject ?? "", vars)),
        to: [row.email],
        html_body: renderBody(localTemplate.html, vars, stepContent),
        text_body: localTemplate.text
          ? renderTextBody(localTemplate.text, vars, bodyPlainText(stepContent))
          : undefined,
      })
    : externalTemplateId
      ? await smtp2goSend(env.SMTP2GO_API_KEY, {
          ...envelope(renderSubject(step.subject, template?.subject ?? "", vars)),
          to: [row.email],
          template_id: externalTemplateId,
          version: 1,
          template_data: vars,
        })
      : await smtp2goSend(env.SMTP2GO_API_KEY, {
          ...envelope(renderSubject(step.subject, "", vars)),
          to: [row.email],
          html_body: renderBody(stepContent ?? "", vars, null),
          text_body: step.content_text ? renderText(step.content_text, vars) : undefined,
        });

  const emailId = resp.data?.email_id ?? resp.request_id;
  await db
    .prepare("UPDATE sequence_sends SET status='sent', sent_at=unixepoch(), smtp2go_id=? WHERE id=?")
    .bind(emailId, row.id)
    .run();
}

/**
 * TEST MODE send: render and send one sequence step, recording the result in
 * sequence_test_sends only. No sequence_sends row, no enrolment, no metric.
 */
async function processTestSend(job: SendJob, env: Env): Promise<void> {
  const db = env.DB;
  const seq = await db
    .prepare("SELECT * FROM sequences WHERE id=?")
    .bind(job.sequence_id)
    .first<any>();
  if (!seq) return;
  const step = await db
    .prepare("SELECT * FROM sequence_steps WHERE sequence_id=? AND position=?")
    .bind(job.sequence_id, job.step_position)
    .first<any>();
  if (!step) return;

  const template = step.template_id
    ? await db.prepare("SELECT * FROM templates WHERE id=?").bind(step.template_id).first<TemplateRow>()
    : null;
  const externalTemplateId =
    step.external_template_id || (template?.source === "smtp2go" ? template.external_id : null);
  if (step.content_html == null && !template && !externalTemplateId) {
    await markTestFailed(env, job, "template missing");
    return;
  }

  const vars = { email: job.email };
  const identity = await resolveSequenceIdentity(env, seq.sender_identity_id);
  const fromEmail = identity?.from_email || seq.from_email || env.DEFAULT_FROM_EMAIL || "";
  const fromName = identity ? identity.from_name ?? "" : seq.from_name || env.DEFAULT_FROM_NAME || "";
  const replyTo = identity ? identity.reply_to ?? seq.reply_to : seq.reply_to;
  const domainViolation = sendDomainViolation({
    fromEmail,
    identityName: identity?.name ?? null,
    identityDomain: identity?.sending_domain ?? null,
    identityEnabled: identity ? Boolean(identity.enabled) : null,
    snapshot: await readVerifiedDomains(env),
  });
  if (domainViolation) {
    await markTestFailed(env, job, `sender_domain: ${domainViolation}`);
    return;
  }
  const subject = `[TEST] ${renderSubject(step.subject, template?.subject ?? "", vars)}`;
  const envelope = sendEnvelope({
    campaignId: null,
    fromName,
    fromEmail,
    replyTo,
    subject,
  });

  // Same body rules as the live send (see processSend).
  const localTemplate = template && !externalTemplateId ? template : null;
  const stepContent = step.content_html ?? step.body_html ?? null;
  const resp = localTemplate
    ? await smtp2goSend(env.SMTP2GO_API_KEY, {
        ...envelope,
        to: [job.email],
        html_body: renderBody(localTemplate.html, vars, stepContent),
        text_body: localTemplate.text
          ? renderTextBody(localTemplate.text, vars, bodyPlainText(stepContent))
          : undefined,
      })
    : externalTemplateId
      ? await smtp2goSend(env.SMTP2GO_API_KEY, {
          ...envelope,
          to: [job.email],
          template_id: externalTemplateId,
          version: 1,
          template_data: vars,
        })
      : await smtp2goSend(env.SMTP2GO_API_KEY, {
          ...envelope,
          to: [job.email],
          html_body: renderBody(stepContent ?? "", vars, null),
          text_body: step.content_text ? renderText(step.content_text, vars) : undefined,
        });

  const emailId = resp.data?.email_id ?? resp.request_id;
  await db
    .prepare("UPDATE sequence_test_sends SET smtp2go_id=? WHERE id=(SELECT MAX(id) FROM sequence_test_sends WHERE sequence_id=? AND step_position=? AND email=?)")
    .bind(emailId, job.sequence_id, job.step_position, job.email)
    .run();
}

async function markSequenceFailed(env: Env, job: SendJob, err: string) {
  if (!job.sequence_send_id) return;
  await env.DB.prepare("UPDATE sequence_sends SET status='failed', error=? WHERE id=?")
    .bind(err.slice(0, 500), job.sequence_send_id)
    .run();
}

async function markTestFailed(env: Env, job: SendJob, err: string) {
  await env.DB.prepare(
    "UPDATE sequence_test_sends SET error=? WHERE id=(SELECT MAX(id) FROM sequence_test_sends WHERE sequence_id=? AND step_position=? AND email=?)",
  )
    .bind(err.slice(0, 500), job.sequence_id, job.step_position, job.email)
    .run();
}

/**
 * A campaign is finished when nothing is queued AND nothing is waiting on a
 * later window. For a planned (daily-batch) campaign the last condition is what
 * keeps it 'sending' between batches, so this goes through the shared settler
 * rather than flipping the status itself.
 */
async function maybeFinishCampaign(env: Env, campaignId: number): Promise<void> {
  await settleFinishedCampaign(env, campaignId);
}

async function processOne(job: SendJob, env: Env): Promise<void> {
  const db = env.DB;

  // Check campaign status (paused/cancelled => skip)
  const campaign = await db
    .prepare("SELECT * FROM campaigns WHERE id = ?")
    .bind(job.campaign_id)
    .first<CampaignRow>();
  if (!campaign) {
    await markFailed(env, Number(job.send_id), "campaign missing");
    return;
  }
  if (campaign.status === "paused" || campaign.status === "cancelled") {
    // re-throw to retry later (paused will resume)
    throw new Error("campaign paused");
  }

  // Check this send hasn't already been sent (idempotency)
  const existing = await db
    .prepare("SELECT status, sent_at FROM sends WHERE id = ?")
    .bind(job.send_id)
    .first<{ status: string; sent_at: number | null }>();
  if (!existing) return;
  if (existing.sent_at) return; // already sent

  // Last-chance suppression check
  const suppressed = await db
    .prepare("SELECT 1 FROM suppressions WHERE email = ?")
    .bind(job.email)
    .first();
  if (suppressed) {
    await db
      .prepare("UPDATE sends SET status='skipped', error='suppressed' WHERE id = ?")
      .bind(job.send_id)
      .run();
    return;
  }

  const contact = job.contact_id
    ? await db
        .prepare("SELECT * FROM contacts WHERE id = ?")
        .bind(job.contact_id)
        .first<ContactRow>()
    : null;

  // Last-chance verification check, symmetric with the suppression check above:
  // an address verified as bad (or still unverified) after its send row was
  // created must not go out. NULL email_status (never checked) is grandfathered.
  if (contact && isSendBlocked(contact.email_status)) {
    await db
      .prepare("UPDATE sends SET status='skipped', error=? WHERE id = ?")
      .bind(`email_status:${contact.email_status}`, job.send_id)
      .run();
    return;
  }

  const template = campaign.template_id
    ? await db
        .prepare("SELECT * FROM templates WHERE id = ?")
        .bind(campaign.template_id)
        .first<TemplateRow>()
    : null;
  const externalTemplateId =
    (campaign as any).external_template_id ||
    (template?.source === "smtp2go" ? template.external_id : null);
  if (!template && !externalTemplateId) {
    await markFailed(env, Number(job.send_id), "template missing");
    return;
  }

  const mapping = parseMapping((campaign as any).var_mapping);
  // Variables this render uses inside an href get URL-context interpolation, so
  // a hybrid value there is URL-encoded per recipient.
  const urlVars = urlContextVars(template?.html, campaign.body_html ?? null);
  // With a mapping present, use it for both SMTP2GO (template_data) and local
  // (Mustache-rendered here). Without a mapping, keep legacy behaviour: full
  // contact vars for local templates, mapping-fallback (contact) for SMTP2GO.
  const vars = mapping
    ? mappedVars(contact, mapping, job.email, urlVars)
    : externalTemplateId
      ? mappedVars(contact, mapping, job.email, urlVars)
      : contact
        ? contactVars(contact)
        : { email: job.email };
  const fromEmail = campaign.from_email || env.DEFAULT_FROM_EMAIL || "";
  const fromName = campaign.from_name || env.DEFAULT_FROM_NAME || "";

  if (!fromEmail) {
    await markFailed(env, Number(job.send_id), "no from address configured");
    return;
  }

  // Sending-domain rule: refuse to send from a domain that is not a verified
  // SMTP2GO sending domain (enforced once the verified set has been read; the
  // campaign path has no identity, so there is no bound domain to compare).
  const domainViolation = sendDomainViolation({
    fromEmail,
    snapshot: await readVerifiedDomains(env),
  });
  if (domainViolation) {
    await markFailed(env, Number(job.send_id), `sender_domain: ${domainViolation}`);
    return;
  }

  // Sender, resolved subject and headers come from the shared envelope builder,
  // so the test send and this path cannot drift (see worker/sendPayload.ts).
  const envelope = (subject: string) =>
    sendEnvelope({
      campaignId: campaign.id,
      sendId: job.send_id,
      fromName,
      fromEmail,
      replyTo: campaign.reply_to,
      subject,
    });

  // Per-campaign body: merged into the template at {{content}} before the
  // Mustache pass, so {{vars}} work inside the body too. NULL body_html leaves
  // the template byte-for-byte unchanged. SMTP2GO templates render their own
  // body, so this only applies to in-app templates.
  const body = campaign.body_html ?? null;

  const resp = externalTemplateId
    ? await smtp2goSend(env.SMTP2GO_API_KEY, {
        ...envelope(
          // Campaign subject wins when set; otherwise the template's, byte-identical
          // to before. SMTP2GO treats `subject` as authoritative even with a
          // template_id, so the override is not silently ignored.
          renderSubject(campaign.subject, template?.subject ?? "", vars),
        ),
        to: [job.email],
        template_id: externalTemplateId,
        version: 1,
        template_data: vars,
      })
    : await smtp2goSend(env.SMTP2GO_API_KEY, {
        ...envelope(renderSubject(campaign.subject, template!.subject, vars)),
        to: [job.email],
        html_body: renderBody(template!.html, vars, body),
        // The text half renders through the RAW substitution: a text/plain part
        // has no markup context, so an escaped URL/name would arrive corrupted.
        text_body: template!.text
          ? renderTextBody(template!.text, vars, bodyPlainText(body))
          : undefined,
      });

  const emailId = resp.data?.email_id ?? resp.request_id;
  await db
    .prepare("UPDATE sends SET status='sent', sent_at=unixepoch(), smtp2go_id=? WHERE id = ?")
    .bind(emailId, job.send_id)
    .run();
}

async function markFailed(env: Env, sendId: number, err: string) {
  await env.DB.prepare("UPDATE sends SET status='failed', error=? WHERE id = ?")
    .bind(err.slice(0, 500), sendId)
    .run();
}
