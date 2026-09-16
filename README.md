# Square Inch

Somebody is about to spend a whole day being photographed — a bride, a groom, a
conference speaker. They post the front and the back of what they are wearing
and put a price on the fabric. Companies drag a rectangle onto the photograph
and buy that patch of them.

**`index.html` is the product.** Open that one first.

It is two-sided, and the two sides are the **wearer** and the **sponsor**. The
front door asks which one you are:

- A **sponsor** goes to the directory — every garment taking bids, filterable by
  gown or suit and by women's or men's — opens the one whose room it wants to be
  in, and drags out the patch it wants. The area sets the price.
- A **wearer** goes to the studio, uploads a front and a back photograph, sets
  one rate for the fabric, and accepts or declines each sponsor by name.

Note the roles are stored as `client` and `brand` and always will be: the value
is frozen by a database trigger the moment an account picks a side, which is
what stops anybody listing a garment and then bidding on it themselves. Only the
display words changed. `brand` also still means a company's own mark — the
"Brand name" field, the `bids.brand` column — and that is a different thing from
the role.

A wearer's own page is laid out like a campaign, not like a dashboard: a
headline, the front and the back at full width with every claimed rectangle
priced on the cloth, a funding bar, what has been taken so far, the rate card,
social proof, how it works, the day itself, who is behind it, and an FAQ. A
sponsor can land on it cold and know what it costs by the second screenful.

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
npm test          # 420 tests, ~110s
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

### The sponsor draws the rectangle, and the area sets the floor

There is no menu of positions. A sponsor drags out the patch of fabric it wants,
anywhere on the front or the back photograph, and the floor under it follows
from how much of the photograph it covers:

    areaPercent = w * h / 100            // w and h are each a % of the photo
    sideFactor  = front ? front_multiplier : 1
    floor       = ceil(areaPercent * rate_per_percent * sideFactor)

The wearer's entire price list is those two numbers. A 27%×10% box on the front
of a default listing is 2.7% of the image, so 2.7 × 250 × 1.6 = **$1,080**.

A drawn box must cover between **0.8%** and **12%** of the photograph, sit
inside it, and **not overlap** an existing rectangle — two sponsors cannot print
on the same cloth. All of that lives in `validateBox`, which the page runs while
the finger is still moving and the server runs again before it will take money.

A brand-drawn spot arrives **unapproved**. It holds the sponsor's money and
appears nowhere public until the wearer accepts it; declining releases the
authorisation in full. The wearer's own page is the only place it shows.

### Then it is an ordinary auction

Once a rectangle exists it is contestable like any other spot. A sponsor states
**the most it will pay**, and the spot sits at *the least that sponsor needs to
stay ahead* — not at their maximum.

- One bidder on a spot pays the **floor** — the area price — however high their
  maximum was.
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
- **The wearer never accepted the rectangle** → the authorisation is released at
  settlement and never captured. Nothing is ever charged for a patch of
  somebody's clothing they did not agree to.
- **The wearer declines it** → `POST /api/decline/:spotId` cancels the
  authorisation *first*, with the secret key, and only then marks the row.
  Declining is a state, never a delete: `bids.spot_id` is `on delete cascade`,
  so deleting the spot would delete the bid that carries the payment intent and
  strand the hold on the sponsor's card with nothing left that knew its id.

The bid sheet shows both numbers side by side, because they are different and
conflating them would be dishonest: what you'd owe if it closed now, and what is
actually being held on your card.

Closing a listing is `POST /api/settle/:listingId`, guarded by `SETTLE_SECRET`.
Point cron, a GitHub Action or a Supabase scheduled function at it.

> **Stripe authorisations expire after 7 days.** Keep a campaign shorter than
> that, or re-authorise before they lapse. There is no way around this.

---

## Gowns and suits, front and back

A listing is a gown or a suit, and separately it is cut for a woman or for a
man — `garment` and `wears` are two different columns because a woman wears a
suit to her own keynote and a man wears a long coat. The pair decides the
wording on the card ("Women's gown", "Men's suit"), the two filters in the
directory, and which silhouette is drawn before a photograph exists.

Each listing has a **front and a back photograph** the wearer uploads, and
**both are required** before bidding can open — a sponsor cannot draw on a
photograph that is not there. Rectangles are drawn on top by the sponsors
themselves, not by the wearer.

Coordinates are stored as **percentages of the photograph, never pixels**, so a
layout drawn on a laptop lands in the same place on a phone, and replacing the
photo does not move the spots. Until a photo is uploaded the spots are drawn on
a silhouette, so a listing is legible from the moment it is created.

---

## Mobile

Mobile is the default and the desktop layout is what gets added on top, not the
other way round.

- One garment panel with a Front/Back toggle on a phone; both panels side by
  side from 680px, at which point the toggle removes itself. The pair is capped
  at 940px — at full page width a 3:4 panel is tall enough that you scroll past
  the front to reach the back.
- A spot's number sits in the corner of the box and its price hangs off the
  bottom edge, both at a fixed size rather than scaled to the box — a small spot
  would otherwise carry a price nobody can read, which is the one thing on the
  garment that has to be legible.
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
| `public/assets/garments/` | The demo photographs, front and back, plus `manifest.json` recording where the fabric actually is in each frame. |
| `public/` | **Everything that is served.** Nothing outside it is reachable over HTTP. |
| `test/` | 420 tests — `npm test`. Engine, HTTP contract, engine/server parity, browser E2E, and a live Supabase suite that skips itself without keys. |
| `squareinch.html` | The previous direction: the same product as a square-inch grid. |
| `app.html`, `demo-*.html` | Earlier studies. |

`build/build-squareinch.py` regenerates `squareinch.html` only. It has nothing
to do with `index.html`, which has no build step.

---

## Not real

Every brand, bid, rate and statistic in the demo is invented. No real company is
depicted.
