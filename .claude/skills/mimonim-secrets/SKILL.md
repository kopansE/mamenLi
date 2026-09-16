---
name: mimonim-secrets
description: Find, set or rotate a credential for the Square Inch site - Supabase keys, the Postgres password, Stripe keys, the Resend API key, Google OAuth secret, or SETTLE_SECRET. Use when asked where a key lives, to rotate or regenerate one, when a key has leaked, or when something fails with an auth/permission error that looks like a wrong key. Covers which keys are safe in a browser and which are catastrophic there, and the two independent copies of every value.
---

# Credentials

## Two independent copies

Every secret exists in **two places that do not sync**:

- **`.env`** in the repo root — local development. Gitignored. Must stay that way.
- **Render → Environment** — production. Editing it triggers a redeploy.

Changing one does not change the other. A key rotation means updating both.

## The map

| Credential | Lives in | Used by | Where to regenerate |
|---|---|---|---|
| `SUPABASE_URL` | `.env` + Render | browser + server | fixed per project |
| `SUPABASE_ANON_KEY` | `.env` + Render | **browser** | Supabase → Settings → API Keys |
| `SUPABASE_SERVICE_ROLE_KEY` | `.env` + Render | **server only** | same page |
| `SUPABASE_DB_PASSWORD` | `.env` only | `supabase db push` | Settings → Database → Reset password |
| `SETTLE_SECRET` | `.env` + Render | guards `/api/settle` | generate one yourself |
| `RESEND_API_KEY` | `.env` + Supabase SMTP settings | Supabase sends mail | Resend → API Keys |
| Google client ID + secret | Google Cloud + Supabase provider | sign-in | GCP → Clients → reset secret |
| `STRIPE_SECRET_KEY` | not set yet | server only | Stripe dashboard |
| `STRIPE_PUBLISHABLE_KEY` | not set yet | browser | Stripe dashboard |
| `STRIPE_WEBHOOK_SECRET` | not set yet | webhook verification | Stripe → Webhooks |

Generate a `SETTLE_SECRET`:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Which keys are safe in a browser

**Safe, and deliberately public** — served by `/api/config`:

- `SUPABASE_ANON_KEY` — Row Level Security is the protection, not secrecy of
  this key. That is why the migrations ship policies rather than TODOs.
- `STRIPE_PUBLISHABLE_KEY` — designed to be public.

**Catastrophic in a browser:**

- `SUPABASE_SERVICE_ROLE_KEY` — bypasses RLS entirely. It is what lets the
  server write the `bids` table that browsers are forbidden to touch. If it
  leaks, the whole database is readable and writable by anyone. Never put it in
  client code or in anything prefixed `NEXT_PUBLIC_` / `VITE_`.
- `STRIPE_SECRET_KEY` — can move money.
- `SUPABASE_DB_PASSWORD` — full Postgres access.

There is a standing check for this: `test/server.test.js` asserts the exact key
set `/api/config` returns and fails if a `service_role`, `sk_` or `whsec_`
value ever appears in a response body or header.

## Rotating

1. Generate the new value in that service's dashboard.
2. Update `.env`.
3. Update Render → Environment (redeploys automatically).
4. `npm run verify` if it was a Supabase key.

Blast radius, so you can judge urgency:

- **Anon key** — low. Public by design; rotating mostly just invalidates
  sessions.
- **Service role key** — highest. Rotate immediately on any suspicion.
- **DB password** — only the CLI uses it, so rotating breaks nothing running.
  Safe to rotate freely; it is also the only one you *must* reset rather than
  read, since Supabase never shows it again after project creation.
- **Google client secret** — rotate in GCP, then paste into Supabase →
  Authentication → Providers → Google. Sign-in breaks between the two steps.
- **Resend key** — rotate in Resend, then update Supabase's SMTP settings.
  Email silently stops in between.

## Checking nothing leaked

```powershell
curl -s https://mimonim.com/api/config          # must contain no sk_ / service_role
curl -s -o /dev/null -w "%{http_code}\n" https://mimonim.com/.env          # 404
curl -s -o /dev/null -w "%{http_code}\n" https://mimonim.com/.git/config   # 404
```

Only `public/` is served. Pointing a static handler at the repo root once
exposed `/.git/config`, and with it every secret ever committed — that is why
`server/index.js` serves an allowlisted directory rather than denylisting
dotfiles.

## If a secret reaches a chat, a log, or a screenshot

Treat it as leaked and rotate it. The DB password, the Resend key and the
Google client secret used during this project's setup were all pasted into a
transcript; each is rotatable from its own dashboard in under a minute.
