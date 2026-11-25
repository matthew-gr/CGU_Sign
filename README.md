# Agreement Signer

Fills a client's Word service agreement with a lead's data from Airtable, asks for anything missing, and sends it for
e-signature by email. Grok can run the whole flow through an MCP connector. No AI writes contract text: values go only
into the named fields and yes/no optional sections a template defines.

Built by Grow Rwanda for one US client, from GR OS Sign (OS_Beta `f674d5b`) without the company seal. The spec is the
FRD (v0.1, 24 Nov 2026).

## Run it locally

Node 22, Docker.

```powershell
docker run -d --name agreements-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=agreements -p 5444:5432 postgres:18
copy .env.example .env          # set DATABASE_URL to postgresql://postgres:postgres@127.0.0.1:5444/agreements
$env:NODE_ENV="development"     # this machine sets NODE_ENV=production globally; override it for local work
npm install --include=dev
npx prisma migrate deploy
npx tsx prisma/seed.ts          # admin@example.com (Admin), sam@example.com (Sender)
npm run dev                     # http://localhost:3000
```

Email isn't sent locally (`EMAIL_DELIVERY=off`): login and signing codes are printed in the dev server's console.
Without Gotenberg or LibreOffice, PDFs are an approximate "draft" layout (never in production).

Tests: `npm run test:unit` (template engine) and `npm run test:e2e` (the whole flow against a fake Airtable, FRD §19).

## How it fits together

| Area | Code |
|---|---|
| Email-code login, sessions | `src/lib/auth.ts`, `src/lib/session.ts`, `src/app/login` |
| Templates: scan, formatters, fill | `src/lib/templates/engine.ts`, `format.ts`, `core.ts` |
| Airtable: API, conversion, write-back | `src/lib/airtable/*` |
| Agreements: fill, missing values, overrides, send | `src/lib/agreements/core.ts` |
| Sign (from GR OS): envelopes, signing, certificate, audit | `src/lib/sign/*` |
| MCP for Grok: OAuth, API keys, the ten tools | `src/lib/mcp/*`, `src/lib/agreements/mcp.ts`, `src/app/mcp` |
| Daily job (expiry, reminders, Airtable retries) | `src/app/api/cron/daily/route.ts` |

Every schema change needs a migration: `npx prisma migrate dev --name <what>`, never `db push`.

## Deploy (Railway, Grow Rwanda's account)

One project with four parts: this app, Postgres, a volume (mounted for files) and a private Gotenberg service
(`gotenberg/gotenberg:8`). Set the variables in `.env.example`: production refuses to start without `AUTH_SECRET`
and `FILE_ENCRYPTION_KEY`. Copy `SENDGRID_API_KEY` from the AI cost dashboard's Railway service with the CLI
(`--stdin`), never by printing it. Add a Railway cron that runs daily:
`curl -X POST -H "x-cron-secret: $CRON_SECRET" $APP_URL/api/cron/daily`.

## Onboarding the client (they only provide Airtable access)

1. Set `BOOTSTRAP_ADMIN_EMAIL` to whoever administers it, deploy, and sign in with an emailed code.
2. **Settings → Airtable**: paste their personal access token (`data.records:read`, `schema.bases:read`, plus
   `data.records:write` for write-back), pick the base and leads table, and the fields that identify a lead.
3. **Templates**: upload their service agreement with `{{tags}}` (the upload page lists the syntax). Map each field to
   an Airtable field, a fixed value, or "ask the user". Set the parties (lead, company signatory), test-fill, publish.
4. **Settings → Company**: name, logo, colour, time zone, and the consent text (their US counsel should approve it).
5. **Grok**: in Grok, add `<APP_URL>/mcp` as a remote MCP server. If Grok can't do OAuth, create an API key on
   My account and use it as a bearer token. Set `MCP_REDIRECT_HOSTS` to Grok's callback host once known.

## Open questions (FRD §20)

Still open: Grok's MCP support and callback host (Q1); the Airtable base and field names (Q2, answered by connecting);
template variants (Q3); the company signatory (Q4); which fields to write back (Q5); a sending domain (Q6; until then,
Grow Rwanda's verified sender with the client's display name); hosting terms (Q7); the payment link (Q8); legal sign-off
on the consent text and retention (Q9); the product name (Q10).
