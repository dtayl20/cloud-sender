# Setup

A self-hosted bulk emailer: React console + Hono API + D1 + Queues, all in one
Cloudflare Worker, with SMTP2GO doing delivery.

This guide takes you from clone to a sent test email. Budget 20 minutes,
most of it clicking around the Cloudflare dashboard.

---

## Prerequisites

- Node.js 20+ and npm
- A Cloudflare account (free plan is enough)
- An SMTP2GO account with a **verified sender domain**
- Optional: a domain on Cloudflare if you want to put the Worker on your own hostname

---

## 1. Clone and install

```bash
git clone https://github.com/dtayl20/cloud-sender.git
cd cloud-sender
npm install
```

---

## 2. Create the Cloudflare resources

These are one-time and cannot be created by a deploy:

```bash
npx wrangler login

# Database
npx wrangler d1 create emailer_db
# → paste the printed database_id into wrangler.toml (binding DB)

# Queues (deploys fail without these)
npx wrangler queues create send-queue
npx wrangler queues create send-dlq
```

`wrangler.toml` ships with the author's IDs so the file is self-documenting.
**Replace them with yours** — otherwise you are pointing at someone else's database.

Optional: if you want to import contacts straight from an existing D1
database, bind it as `SOURCE_DB` in `wrangler.toml`. The binding name must be
exactly `SOURCE_DB`. Remove the binding if you don't need it.

---

## 3. Apply the schema

**Fresh database — one file:**

```bash
npx wrangler d1 execute emailer_db --remote --file=schema.sql
# local: npx wrangler d1 execute emailer_db --local --file=schema.sql
```

`schema.sql` is the consolidated DDL for an empty database: 15 tables covering
contacts, suppressions, templates, campaigns, sends, webhook events and the
send-plan tables, plus the default base template.

**Existing database — migrations:**

```bash
npm run db:migrate:remote     # or db:migrate:local for the local simulator
```

The 13 numbered files in `migrations/` are the source of truth and the upgrade
path. Never run `schema.sql` against a database that already has tables.

---

## 4. Secrets

```bash
npx wrangler secret put SMTP2GO_API_KEY    # from SMTP2GO → Sending → API keys
npx wrangler secret put WEBHOOK_TOKEN      # any random string; used in the SMTP2GO webhook URL
npx wrangler secret put IP_SALT            # openssl rand -hex 16
```

Optional, only if you use the clinic-report endpoint:

```bash
npx wrangler secret put REPORT_SEND_TOKEN
```

Plain-text defaults live in `[vars]` in `wrangler.toml`:
`DEFAULT_FROM_EMAIL`, `DEFAULT_FROM_NAME`, `SEND_TIMEZONE`, `CONTACT_TO_EMAIL`,
`REPORT_*_EMAIL`. Change them to your own domain before sending anything.

> SMTP2GO rejects a sender on an unverified domain. Verify the domain first,
> then set `DEFAULT_FROM_EMAIL` to an address on it.

---

## 5. Run it locally

Two processes: the Worker API and the Vite console.

```bash
# terminal 1 — Worker + local D1 + local queues
cp .env.example .env.local
npm run worker:dev          # http://localhost:8787

# terminal 2 — console
VITE_API_BASE=http://localhost:8787 npm run dev    # http://localhost:8080
```

Secrets for local runs go in `.dev.vars` (gitignored), same names as above:

```bash
cp .env.example .dev.vars
```

Locally the app trusts the `Cf-Access-Authenticated-User-Email` header and
falls back to `anonymous@local`, so there is no auth step in dev. **In
production that header is only trustworthy because Cloudflare Access sets it.**

---

## 6. Deploy

```bash
npm run build               # builds the SPA into dist/
npm run worker:deploy
```

The Worker serves `dist/` through its `[assets]` binding, so one deploy ships
the API and the UI together.

**Protect it with Cloudflare Access before you send anything.** Create a Zero
Trust application covering the whole hostname, policy = your email. There is no
app-level login: Access *is* the auth layer.

---

## 7. First campaign

1. **Settings** — confirm sender name, from-address and the SMTP2GO key is live.
2. **Contacts → Imports** — upload a CSV (`email`, optional `first_name`, `last_name`, `company`).
3. **Templates** — create one, with variables like `{{first_name}}`.
4. **Campaigns** — pick a list, template, send window and (optionally) a daily ramp.
5. Send yourself a test, then schedule.

The one-minute cron picks up scheduled campaigns. It self-gates so a campaign
cannot be dispatched twice, and a per-day time-window scan stops midnight
double-sends.

---

## How delivery actually works

```
cron (1 min) ──▶ find due campaigns ──▶ enqueue one job per recipient
                                              │
                                     Queue consumer (batch 25)
                                              │
                                     SMTP2GO HTTPS API
                                              │
                             webhook events ──▶ D1 (delivered/bounce/complaint)
                                              │
                              suppressions updated, bad addresses removed
```

Batches are capped at 25 messages per invocation with 4 concurrent consumers,
so no single invocation hits Worker limits. Failures retry four times, then
land in `send-dlq`.

---

## Verify

```bash
npm test                    # vitest: rendering, hybrid vars, contact form, DNS
npm run lint
curl -s http://localhost:8787/api/settings
```

In production, check `/api/settings` returns JSON (not the SPA HTML) — if it
returns HTML, the assets binding is winning over the API route.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Deploy fails: `Queue "send-queue" does not exist` | queues are dashboard/CLI objects, not deployable | `wrangler queues create send-queue` (and `send-dlq`) |
| `/api/settings` returns HTML | SPA fallback intercepting | confirm the API routes are registered before the assets fallback; redeploy |
| Emails rejected by SMTP2GO | sender domain not verified | verify the domain, then set `DEFAULT_FROM_EMAIL` |
| Everything 403s in production | Cloudflare Access policy too strict | widen the policy to your email; check the app covers the whole hostname |
| High bounce rate | cold list, no verification | add a verification pass before importing; watch the suppression list |
| Campaign never sends | outside its send window / timezone | check `send_timezone` on the campaign and `SEND_TIMEZONE` in `[vars]` |

---

## Layout

```
src/worker/      Hono API, queue consumer, cron dispatcher, SMTP2GO client
src/web/         React console (Vite), built to dist/
migrations/      D1 schema, numbered
```
