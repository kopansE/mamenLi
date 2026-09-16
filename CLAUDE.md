# Square Inch / mimonim.com

A marketplace where someone sells advertising space on a wedding gown or suit,
and brands bid for numbered spots on it. Live at **https://mimonim.com**.

## Skills — check these before improvising

This project's hard-won knowledge lives in `.claude/skills/`. Each is written
for a task, and each records traps that already cost real time. **Read the
relevant one before touching that area** rather than rediscovering the same
problems.

| Skill | Reach for it when |
|---|---|
| `mimonim-deploy` | deploying, rolling back, changing build commands or env vars on Render |
| `mimonim-migrate` | changing the database — tables, columns, RLS policies, triggers, storage rules |
| `mimonim-domain` | DNS, adding or moving a domain, certificate errors, "it still shows the old site" |
| `mimonim-secrets` | finding, setting or rotating any credential; suspected leak |
| `mimonim-auth` | sign-in broken, OAuth, email confirmation, SMTP, the publisher/brand role |
| `mimonim-payments` | Stripe, and the settlement job that actually charges winners |
| `mimonim-market` | bidding rules, why a spot settled at a price, anything in `market.js` |

`OPERATIONS.md` is the same material as one continuous runbook, with the full
account inventory. `README.md` explains what the product is and why the market
works the way it does.

## Shape of the thing

**One process.** `server/index.js` serves `public/` *and* `/api`. There is no
front-end build step and no separate static host.

```
public/           everything served over HTTP. NOTHING outside it is reachable.
  assets/js/market.js   the auction engine - ALSO required by the server
  assets/js/store.js    data layer: Supabase adapter + localStorage demo adapter
  assets/js/app.js      screens, rendering, the studio, sharing
server/index.js   Stripe, CSRF, rate limits, webhooks, settlement
supabase/migrations/    source of truth for the schema
test/                   322 tests
```

Hosting is **Render**; database, auth and file storage are **Supabase**;
email is **Resend**; the domain is at **GoDaddy**. Supabase never serves the
page — that confusion has cost time before.

## Rules that are not style preferences

- **Only `public/` is served.** Pointing a static handler at the repo root once
  exposed `/.git/config`, and with it every secret ever committed. There is a CI
  check for this.
- **The browser is never trusted with a price.** `/api/bid` re-reads the
  listing, spot and bids from its own database and revalidates with `market.js`
  before asking Stripe for anything. The request says which spot and what the
  bidder will pay — never what it costs.
- **`bids` has no INSERT/UPDATE/DELETE policy at all.** With RLS on and no
  policy, every browser write is refused. Only the server's service-role key
  writes bids. Do not "fix" this by adding a policy.
- **A bidder's maximum is private.** Readable only by that bidder and the
  listing owner. If the browser could read ceilings, proxy bidding is pointless.
- **`role` is frozen once chosen**, and an owner cannot bid their own listing.
  Together these stop shill bidding.
- **No `'unsafe-inline'` in `script-src`.** Every line of JS is in a file, so
  the real XSS mitigation is available. Keep it that way — no inline handlers,
  no inline `<script>`. `supabase-js` is vendored and served from our own origin
  rather than a CDN.
- **Everything reaching `innerHTML` goes through `esc()`**, every URL through
  `safeUrl()`. There is an XSS regression test that plants a payload in every
  publisher- and brand-controlled field.

## Working here

```powershell
npm test          # 322 tests, ~45s. Run before every push.
npm run verify    # proves the LIVE database still refuses what it should
npm start         # http://localhost:8787
```

`npm run verify` is not a smoke test: it attempts the things that are meant to
be impossible — anonymous bid insert, listing insert, role change — and fails
the run if any succeed.

Two testing gotchas worth knowing before you debug a phantom:

- **Stray servers cause phantom failures.** The suites spawn servers on fixed
  spare ports (8788 and up). A leftover process there makes unrelated suites
  fail. Check the port before believing a failure.
- **Render's free tier sleeps** after 15 minutes and takes ~50s to wake. A check
  run immediately after a cold start sees a half-booted page and reports
  nonsense. Hit it twice.

## Not done yet

- **Stripe is not configured** — the site runs in demo mode.
- **Settlement is not scheduled.** Nothing closes a listing on its own. Until
  a cron job calls `/api/settle/:listingId`, card authorisations simply expire
  and the publisher is paid nothing.
- **Free Render plan**, fine until people bid against a visible countdown.
- **Test data is still in the database** — delete before real users.
