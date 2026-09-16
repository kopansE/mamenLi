# Square Inch

A marketplace where someone sells advertising space on their wedding gown or
suit, and brands bid for the positions that matter.

**`index.html` is the product.** Open that one first.

The page is laid out like a campaign, not like a dashboard: a headline, the
garment with numbered spots on it, a funding bar, the list of spots, the one
standout spot, social proof, how it works, the day itself, perks, who is behind
it, and an FAQ. A brand can land on it cold and know what it costs by the second
screenful.

---

## Operating it

[OPERATIONS.md](OPERATIONS.md) is the runbook: every account and identifier,
where each credential lives, how to deploy, how to change the domain, how to
add a migration, and the traps that already cost us an afternoon.

---

## Run it

```powershell
npm run setup     # installs the server's dependencies, once
npm start         # http://localhost:8787
npm test          # 273 tests, ~45s
npm run verify    # proves the live database refuses what it should
```

Run those from the **project root**; `.env` is read from the root whichever
directory you start from.

With a blank `.env` everything still works. There is a seeded demo listing, and
bidding, photo uploads and accounts all run in the browser's own storage. No
card is ever charged and nothing leaves the machine. The footer says
`Demo mode` so you always know which you are in.

---

## Do you need a backend? Yes — and it should be Supabase

You need three things a static host cannot give you: **a database** (spots and
bids have to be the same for everyone), **accounts** (a publisher must only edit
their own garment), and **file storage** (front and back photographs, brand
logos). On top of that, taking money needs **one** server-side secret.

**Use Supabase.** The free tier is Postgres + Auth + Storage + Realtime, and Row
Level Security lets the browser talk to the database directly, so there is no
API to build for most of the app.

| What you need | Supabase gives you | What you write |
|---|---|---|
| Real accounts, client or brand | Auth (email, Google, Apple) | already written — `store.js` |
| Listings, spots, bids | Postgres + RLS | already written — `supabase/migrations/` |
| Front/back photos, logos | Storage buckets | already written |
| Live bidding and chat | Realtime subscriptions | already written |
| Taking money | *nothing* — this is the one piece it does not do | `server/index.js` |

Why not the alternatives: **GitHub Pages** is static only, no database at all.
**Firebase** works but is document-shaped and its security rules get ugly around
"the highest bid wins", which is a query, not a document read. **Neon** or
**PlanetScale** give you Postgres but no auth, no storage and no realtime, so
you would build three more things yourself. **Writing your own API** is the
option you take later, if you outgrow RLS — not now.

### Set it up

The project for this repo is `zhwathzwrqxzgizanabn`, already set in `.env`.

1. **Apply the schema.** `supabase/migrations/` is the source of truth. If the
   GitHub integration is connected, pushing to the production branch applies
   every migration in filename order. Otherwise paste
   `supabase/migrations/20260916120000_init.sql` into the SQL editor and run
   it. It creates the tables, the RLS policies, both storage buckets, the
   realtime publication, a trigger that gives every new account a profile row,
   and a trigger that freezes that account's role.

   Never edit a migration that has already run — add a new one beside it.

2. **Copy two keys** from Settings → API Keys into `.env`:
   - `SUPABASE_ANON_KEY` — belongs in the browser. RLS is what protects the
     data, which is why the migration ships policies rather than TODOs.
   - `SUPABASE_SERVICE_ROLE_KEY` — **server-side only**. It bypasses RLS
     entirely; it is what lets the server write the `bids` table the browser is
     forbidden to touch. Never put it in a client bundle or anything named
     `NEXT_PUBLIC_*` / `VITE_*`.

3. **Prove it.**

   ```powershell
   npm run verify
   ```

   This does not just check that tables exist — it checks that the things which
   are meant to be impossible really are: that an anonymous client cannot
   insert a bid, cannot insert a listing, and cannot change its own role. A
   green run is the security model actually holding rather than being asserted
   in a comment.

4. Restart. The footer will say `Live` instead of `Demo mode`.

### What has to be done in the dashboard by hand

The migrations create every table, policy and bucket. These four live in
project settings and cannot be set from SQL:

| Where | Setting | Why |
|---|---|---|
| Authentication → Providers → Email | **Confirm email**: off to launch, on before real money | On, nobody can sign in until SMTP works. Off, sign-up is instant. |
| Authentication → URL Configuration | **Site URL** + **Redirect URLs** = your deployed origin | Email links and any OAuth callback come back here. Wrong value = a dead link in every email. |
| Project Settings → Auth → SMTP | **Required.** Your own SMTP | See below — without it, sign-up does not work for anyone but you. |
| Authentication → Providers | Google / Apple, if you want them | Each needs its own OAuth client, plus the callback URL above. |

### You cannot skip SMTP

Supabase restricted its built-in email sender in late 2024: it now delivers
**only to addresses belonging to your organisation's members**. Everyone else
gets `Email address not authorized`, and the whole project shares a handful
of messages an hour.

So on a stock project, email sign-up works for you and fails for every real
user — and it fails *silently enough* to look like a bug in the app. There is
no toggle that fixes this; the "Confirm email" switch has been removed from
the Email provider panel because it no longer helps on its own.

**Resend** on the free tier (3,000/month) plus the domain you already own:

1. resend.com → add `mimonim.com` → it prints the DNS records.
2. Paste them into GoDaddy → DNS → Records. **Use the short name**: for
   `resend._domainkey.mimonim.com` the Name field is `resend._domainkey`,
   because GoDaddy appends the domain itself. Pasting the full hostname gets
   you `resend._domainkey.mimonim.com.mimonim.com` and a verification that
   never completes.
3. Resend → API Keys → create one.
4. Supabase → Project Settings → Authentication → SMTP Settings:

   | Field | Value |
   |---|---|
   | Host | `smtp.resend.com` |
   | Port | `465` |
   | Username | `resend` |
   | Password | the Resend API key |
   | Sender email | `no-reply@mimonim.com` |
   | Sender name | whatever the emails should be signed |

   No mailbox is needed for the sender address — Resend only sends.

5. Supabase → Authentication → Rate Limits: raise the email limit, which was
   pinned low only because the shared sender was.

This is also what makes the product's own emails possible later. "You have
been outbid" is worthless if it cannot reach anyone, and that notice is the
thing that keeps an auction moving.

**Single sign-on proper (SAML) is a Pro-plan feature.** Google and Apple are
ordinary OAuth and work on the free tier. Google is already wired up in the
code — it needs credentials.

### Google sign-in

In Google Cloud (APIs & Services → Credentials), create an **OAuth client ID**
of type *Web application*:

| Field | Value |
|---|---|
| Authorised JavaScript origins | `https://mimonim.com`, `https://www.mimonim.com`, `http://localhost:8787` |
| Authorised redirect URIs | `https://zhwathzwrqxzgizanabn.supabase.co/auth/v1/callback` |

The redirect URI is **Supabase's**, not ours. Google returns to Supabase, which
mints the session and then bounces the browser back here. Putting
`mimonim.com` there instead is the single most common way to get
`redirect_uri_mismatch`.

Then in Supabase → Authentication → Sign In / Providers → Google: enable it and
paste the client ID and secret. And in URL Configuration:

| Field | Value |
|---|---|
| Site URL | `https://mimonim.com` |
| Redirect URLs | `https://mimonim.com/**`, `https://www.mimonim.com/**`, `http://localhost:8787/**` |

The wildcards matter: the app returns to whatever path it left from, so an
exact-match entry rejects every page but the root.

**Which side of the table?** A provider cannot tell us whether someone is here
to sell space or to buy it, so a Google arrival lands with `role_locked`
false and is asked once, on their first visit back. That answer is then frozen
by the same trigger that protects the email sign-up path — an account still
cannot switch sides, list a garment and bid it up itself.

Watch out for the interaction between **Confirm email** and onboarding: with
confirmations on, `signUp` returns no session, so the account exists but the
user is not signed in until they click the link. The app handles this — it
says so and switches to the sign-in form — but it is the difference between a
two-second onboarding and a two-minute one.

### Then deploy

The app is **one process**: `server/index.js` serves `public/` and `/api`
together. It does not go on a static host, because the Stripe secret and the
price validation have to live somewhere that is not the browser.

`render.yaml` configures the whole service — connect the repo on Render and it
reads it. Every secret is marked `sync: false`, so Render prompts for each one
and keeps it in the service environment; nothing sensitive is in the repo.

Set these on the host (already in `render.yaml`):

| Variable | Value | Why |
|---|---|---|
| `NODE_ENV` | `production` | HSTS on, cookies marked Secure |
| `TRUST_PROXY` | `1` | Render terminates TLS — exactly one proxy in front |
| `PUBLIC_BASE_URL` | `https://mimonim.com` | Stripe return URLs; stops a spoofed Host redirecting buyers |
| `CANONICAL_HOST` | `mimonim.com` | `www` and `*.onrender.com` 308 here |

**Why one canonical host matters:** two origins means two cookie jars, two
Supabase sessions and a Google redirect that works on one and not the other.
The webhook route is exempt from the redirect — Stripe must never be bounced.

### Pointing mimonim.com at it

DNS goes to the **host**, never to Supabase. Add the domain in Render first; it
then shows you the exact records. In GoDaddy → DNS → Records:

| Type | Name | Value |
|---|---|---|
| A | `@` | the IP Render shows for the apex |
| CNAME | `www` | `<service>.onrender.com` |

Copy the values from Render rather than from here — they change, and a stale IP
is a silent outage. Two GoDaddy-specific traps: make sure **Domain Forwarding**
is off (it hijacks the apex and quietly breaks TLS issuance), and drop the TTL
to 600s while you are setting up so mistakes cost minutes instead of an hour.

Adding the record is also what *proves* you own the domain — Render will not
issue a certificate until it resolves.

### Closing listings

This service does not close listings by itself. Settlement is
`POST /api/settle/:listingId`, guarded by `SETTLE_SECRET`. Add a Render Cron
Job or a GitHub Action that calls it when a listing is due. **Without it the
winners are never captured** — every authorisation simply expires and the
publisher is paid nothing.

**The rule that must survive the port:** the server recomputes the price from
its own copy of the listing and the spot, using `market.js`. The browser says
*which spot* and *what it is willing to pay*. It never says what something
costs.

---

## How the bidding works

The reference this page is modelled on sells spots at a fixed price and lets you
take one over for double the last sale. Doubling locks everyone out after two
takeovers, so this runs a real auction instead.

Each spot has a **floor** the publisher sets. A brand states **the most it will
pay**, and the spot sits at *the least that brand needs to stay ahead* — not at
their maximum.

- One bidder on a spot pays the **floor**, however high their maximum was.
- A second bidder over the first takes it, and pays just over the loser's
  maximum.
- A bidder *under* the leader's ceiling does not win, but **pushes the leader's
  price up** — so a lowball still costs the holder money.
- Ties go to whoever bid first.
- A new bid must clear the standing price by **15%** (`RULES.MIN_RAISE`).
- **Anti-snipe:** any bid inside the final **10 minutes** pushes that spot's
  close out by 10 minutes. A spot only closes after ten quiet minutes, so the
  last bid is always one somebody could have answered.

Bidding your true ceiling early therefore costs you nothing, which is the whole
point — it is what stops the last-second scramble the reference site invites.

The engine is `assets/js/market.js`: about 200 lines, no dependencies, and
**loaded by both the browser and the server**. That is deliberate. The page
quotes you with the same `evaluate()` the server revalidates with, so a tampered
client cannot invent a price the rules would refuse.

### The money follows the same shape

Bidding takes an **authorisation**, not a charge (`capture_method: 'manual'`).

- You bid → Stripe authorises **your maximum**, plus the platform fee.
- Someone outbids you → the authorisation is **cancelled**. Not refunded —
  cancelled. The money was never taken, so there is no refund to wait for.
- The spot closes with you holding it → Stripe captures **the settled price**,
  which is usually *less* than you authorised. Stripe allows capturing under the
  authorised amount, and that is exactly the shape proxy bidding needs.
- The campaign misses its goal → every authorisation is released and nobody
  pays.

The bid sheet shows both numbers side by side, because they are different and
conflating them would be dishonest: what you'd owe if it closed now, and what is
actually being held on your card.

Closing a listing is `POST /api/settle/:listingId`, guarded by `SETTLE_SECRET`.
Point cron, a GitHub Action or a Supabase scheduled function at it.

> **Stripe authorisations expire after 7 days.** Keep a campaign shorter than
> that, or re-authorise before they lapse. There is no way around this.

---

## Gowns and suits, front and back

A listing is a gown or a suit, and each has a **front and a back photograph** the
publisher uploads. Spots are drawn on top by dragging a rectangle across the
picture.

Coordinates are stored as **percentages of the photograph, never pixels**, so a
layout drawn on a laptop lands in the same place on a phone, and replacing the
photo does not move the spots. Until a photo is uploaded the spots are drawn on
a silhouette, so a listing is legible from the moment it is created.

---

## Mobile

Mobile is the default and the desktop layout is what gets added on top, not the
other way round.

- One garment panel with a Front/Back toggle on a phone; both panels side by
  side from 680px, at which point the toggle removes itself.
- Spot labels scale with the spot they sit in (`cqw` container units) with a
  floor so they never become unreadable.
- Tables become card lists under 640px.
- The bid dialog rises as a bottom sheet on a phone and is centred on a desktop.
- A sticky action bar appears once a spot is selected, and only under 900px.
- `dvh` not `vh`, `env(safe-area-inset-*)` on everything that touches an edge,
  16px inputs so iOS Safari does not zoom on focus, 44px minimum touch targets.

---

## Security

| Concern | What is done |
|---|---|
| Price tampering | The server recomputes every bid from its own database with the shared engine. The client's number is an intent, never a price. |
| Card data | Never touches the site. Stripe's hosted page holds it; the secret key stays on the server. |
| Writing bids | The browser **cannot**. `bids` has a read policy and deliberately no insert policy, so RLS refuses every write. Only the server's service-role key can insert, and only after revalidating. |
| Editing someone else's listing | RLS policies scope every write to `auth.uid()`, including spots, which are checked against the owner of their parent listing. |
| Shill bidding | An owner cannot bid on their own listing, and `role` is frozen at sign-up by a trigger so an account cannot switch sides to get around it. |
| Storage | You may only write inside a folder named after your own user id, or after a listing you own. |
| CSRF | Double-submit cookie (`si_csrf`) echoed in an `x-csrf-token` header, compared with `timingSafeEqual`. `SameSite=Lax`, `Secure` in production. |
| XSS | Every interpolated string goes through `esc()`, every URL through `safeUrl()`. CSP carries **no `'unsafe-inline'` on `script-src`** — all JavaScript is in files, so the real mitigation is available. |
| Clickjacking | `frame-ancestors 'none'`. |
| Rate limiting | A ladder, not one number: 240/min on `/api`, **12/min on `/api/bid`** keyed on the account rather than the IP, 40/min on chat, 6/min on settlement. `TRUST_PROXY` must match your real topology or the keys are attacker-chosen. |
| Sealed bids | A brand's maximum is readable only by that brand and by the publisher being paid. The page draws from a settled price the server writes onto the spot, so it never needs to see a ceiling. |
| Supply chain | `supabase-js` is vendored at a pinned version and served from our own origin. No CDN appears in `script-src`. |
| Serving | Only `public/` is served. Pointing a static handler at the repo root hands out `.git`, and with it every secret ever committed. |
| Webhooks | Signature-verified, replay-safe via a unique index on `stripe_session`, and it answers 500 on failure so Stripe retries rather than dropping a paid bid. |
| Transport | HSTS with preload in production; `upgrade-insecure-requests`. |

Before you take real money: set `NODE_ENV=production`, set `PUBLIC_BASE_URL`
(otherwise a spoofed `Host` header can redirect your buyers), set
`STRIPE_WEBHOOK_SECRET`, and generate a `SETTLE_SECRET`.

---

## Sharing

Every spot has its own link (`?l=<listing>&spot=<spot>`), so a brand can be sent
straight to the one you want them to buy. The share sheet offers the native
share sheet on mobile, a pre-filled post on X, a copy-the-link for Instagram
(which has no web share target), and Open Graph tags for the preview card.

---

## Files

| File | What it is |
|---|---|
| `index.html` | **The product.** |
| `assets/css/app.css` | The design system. Mobile first. |
| `assets/js/market.js` | The auction engine. Shared by the browser and the server. |
| `assets/js/store.js` | Data layer: Supabase adapter, plus a demo adapter so it runs with no keys. |
| `assets/js/app.js` | Screens, rendering, the studio, sharing. |
| `server/index.js` | Stripe, CSRF, rate limits, webhooks, settlement. |
| `supabase/migrations/` | Tables, RLS, storage policies, realtime, the account triggers. |
| `supabase/config.toml` | Project ref and CLI settings. |
| `scripts/verify-supabase.js` | `npm run verify` — proves RLS actually refuses what it should. |
| `public/` | **Everything that is served.** Nothing outside it is reachable over HTTP. |
| `test/` | 273 tests — `npm test`. Engine, HTTP contract, engine/server parity, browser E2E, and a live Supabase suite that skips itself without keys. |
| `squareinch.html` | The previous direction: the same product as a square-inch grid. |
| `app.html`, `demo-*.html` | Earlier studies. |

`build/build-squareinch.py` regenerates `squareinch.html` only. It has nothing
to do with `index.html`, which has no build step.

---

## Not real

Every brand, bid, rate and statistic in the demo is invented. No real company is
depicted.
