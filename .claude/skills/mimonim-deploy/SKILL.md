---
name: mimonim-deploy
description: Ship a code change to mimonim.com, the Square Inch spot-marketplace running on Render. Use when asked to deploy, push to production, redeploy, roll back, change the build or start command, or add/change an environment variable on the live service. Covers the two-install build command that catches everyone, which env vars must be set and why TRUST_PROXY is a security control, how to watch a deploy, and how to roll back.
---

# Deploying mimonim.com

The site is **one process**. `server/index.js` serves `public/` *and* `/api` —
there is no separate front end to build and no static host involved. It runs on
**Render**, service `mamenLi` (`srv-dal80glg1s2s73ei292g`), region Frankfurt.

Render watches the `main` branch of `kopansE/mamenLi`. **Pushing deploys.**

## The procedure

```powershell
npm test                 # 321 tests, ~45s. Do not skip - they cover the money path.
git add -A
git commit -m "..."
git push origin main
```

Then watch **dashboard.render.com/web/srv-dal80glg1s2s73ei292g → Deploys**.

A failed build does **not** take the site down — the previous version keeps
serving until a build succeeds.

## Build settings

| Setting | Value |
|---|---|
| Build Command | `npm ci --omit=dev && npm --prefix server ci --omit=dev` |
| Start Command | `node server/index.js` |
| Health Check Path | `/healthz` |

**The build command has two installs on purpose.** Dependencies are split: the
repo root holds dev tooling (Supabase CLI), `server/` holds what actually runs
in production. A build command of plain `npm install`, `npm ci`, or `yarn`
installs only the root and the service dies at startup with:

```
Error: Cannot find module 'dotenv'
```

This is the single most likely deploy failure. Check the build command first.

## Environment variables on Render

```
NODE_ENV=production
TRUST_PROXY=1
PUBLIC_BASE_URL=https://mimonim.com
CANONICAL_HOST=mimonim.com
PLATFORM_FEE_PERCENT=8
CURRENCY=usd
SUPABASE_URL=https://zhwathzwrqxzgizanabn.supabase.co
SUPABASE_ANON_KEY=…
SUPABASE_SERVICE_ROLE_KEY=…
SETTLE_SECRET=…
```

Render's env is **independent of the local `.env`**. Changing one does not
change the other. Editing an env var on Render triggers a redeploy.

Three of these are load-bearing in non-obvious ways:

- **`TRUST_PROXY=1`** — this is a security control, not a formality. It must
  equal the real number of proxies in front (Render is exactly one). Set higher
  than the truth and a caller can spoof `X-Forwarded-For` to choose their own
  rate-limit bucket, silently disabling every limit including the 12/min on
  `/api/bid`.
- **`PUBLIC_BASE_URL`** — where Stripe returns buyers after checkout. Unset, it
  is inferred from the request's `Host` header, which a spoofed header can
  redirect.
- **`CANONICAL_HOST`** — folds `www` and `*.onrender.com` into the apex with a
  308. Without it you have two origins, therefore two cookie jars, two Supabase
  sessions, and a Google sign-in that works on one host and not the other. The
  Stripe webhook route is deliberately exempt from this redirect.

Never set `PUBLIC_BASE_URL`/`CANONICAL_HOST` to a domain whose DNS does not yet
point at Render — every request will 308 to a domain that is not yours yet, and
the service becomes untestable.

## Rolling back

Render → Deploys → find the last good deploy → **Rollback**. Instant; no git
work needed. Fix forward afterwards.

## Verifying a deploy actually worked

```powershell
curl -s -o /dev/null -w "%{http_code}\n" https://mimonim.com/healthz
curl -s https://mimonim.com/api/config          # supabaseUrl set, no service_role anywhere
curl -s -o /dev/null -w "%{http_code}\n" https://mimonim.com/.git/config   # must be 404
```

`/api/config` is deliberately public and exposes the Stripe *publishable* key
and the Supabase *anon* key. If it ever contains `service_role` or `sk_`, stop
and treat it as an incident.

## Cold starts will make you doubt a good deploy

The service is on Render's **free plan**: it sleeps after 15 minutes idle and
takes ~50 seconds to wake. A check run immediately after a cold start sees a
half-booted page — listings missing, `$0 of $0` — and looks like a broken
deploy. Hit it twice before concluding anything. Upgrading to the $7/month tier
removes this, and should happen before real users bid against a countdown.
