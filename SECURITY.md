# Security

Short version: there is no application login. Cloudflare Access is the authentication
layer, and every assumption below depends on it being configured correctly.

## Trust boundaries

| Surface | Exposure | Protection |
|---|---|---|
| `/api/*` (everything except `/api/contact`) | private | Cloudflare Access application in front of the hostname; identity arrives as `Cf-Access-Authenticated-User-Email` |
| `/api/contact` | **public** | fixed recipient, per-IP rate limit, honeypot, strict origin allowlist |
| `/api/webhooks/*` | public | shared token in the URL (`WEBHOOK_TOKEN`) or bearer token |
| Static assets | public | served from the Worker's asset binding |

Because `/api/contact` is the only route a stranger can reach, it is written
defensively: it never reads `to`, `cc`, `bcc` or `from` from the request body, so it
cannot be used as a relay. Recipients are fixed server-side.

## Secrets

- All credentials are Worker secrets (`wrangler secret put`). None are in the repository.
- `.dev.vars` and `.env*` are gitignored; `.env.example` documents names only.
- `SMTP2GO_API_KEY` is the only credential that grants sending rights. Treat a leak
  as an incident: rotate in SMTP2GO, then update the Worker secret.

## Abuse and rate limiting

- Per-IP rate limit on the contact route, stored as a salted SHA-256 of the address —
  raw IPs are not retained.
- Campaign sends are paced through a queue with a fixed batch size, so a bug cannot
  turn into an unbounded send loop.
- The one-minute cron self-gates, and the per-day window check prevents a campaign
  being dispatched twice across the day boundary.
- Suppression list is enforced at send time, not just at import time.

## What this project does not do

- No user accounts, passwords, sessions or password resets.
- No multi-tenant isolation: one deployment serves one operator.
- No storage of message bodies beyond what the campaign record needs.

## Reporting

Please do not open a public issue for a vulnerability. Use GitHub's private
vulnerability reporting on this repository (Security → Report a vulnerability), or
contact the maintainer directly. Expect an acknowledgement within a few days.

This is a portfolio/demo project. It is not offered as a hosted service, and there is
no bug bounty.
