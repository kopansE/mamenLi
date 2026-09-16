# Operations

Everything this system is made of, where each piece lives, and how to change
it. `README.md` explains what the product *is* and why the market works the
way it does; this file is for the day you need to move it, fix it, or hand it
over.

**No secret values are in this file.** It says where each one lives. Real
values are in `.env` (gitignored, local) and in the Render dashboard.

---

## 1. What exists

Five accounts. Nothing else is involved.

| Thing | Where | Identifier |
|---|---|---|
| Code | GitHub | `kopansE/mamenLi`, branch `main` |
| Hosting | Render | service `mamenLi` · `srv-dal80glg1s2s73ei292g` · Frankfurt · **Free plan** |
| Database, auth, file storage | Supabase | project ref `zhwathzwrqxzgizanabn` |
| Domain | GoDaddy | `mimonim.com` |
| Email delivery | Resend | domain `mimonim.com` (verified) |
| Google sign-in | Google Cloud | project `mimonim`, OAuth client `817959638983-…` |
| Payments | Stripe | **not set up yet** |

Live URLs:

- `https://mimonim.com` — the site
- `https://www.mimonim.com` — 301s to the apex
- `https://mamenli.onrender.com` — Render's own URL, still reachable

### How the pieces talk

```
browser ─> mimonim.com (Render: serves public/ AND /api)
   │
   ├─> zhwathzwrqxzgizanabn.supabase.co   database, auth, storage  (direct, no DNS of ours)
   ├─> api.stripe.com                     card details never touch us
   └─> accounts.google.com ─> supabase callback ─> back to mimonim.com
```

Supabase is **not** a web host and never serves the page. Render does. The
domain points at Render and at nothing else.

---

## 2. Where every credential lives

| Credential | Lives in | Used by | How to replace |
|---|---|---|---|
| `SUPABASE_URL` | `.env` + Render env | browser and server | Fixed per project |
| `SUPABASE_ANON_KEY` | `.env` + Render env | browser | Supabase → Settings → API Keys |
| `SUPABASE_SERVICE_ROLE_KEY` | `.env` + Render env | **server only** | same page. Bypasses RLS — never ship to a browser |
| `SUPABASE_DB_PASSWORD` | `.env` only | `supabase db push` | Settings → Database → **Reset password** (not viewable) |
| `SETTLE_SECRET` | `.env` + Render env | guards `/api/settle` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `RESEND_API_KEY` | `.env` + Supabase SMTP | Supabase sends mail | Resend → API Keys |
| Google client ID / secret | Google Cloud + Supabase provider | sign-in | GCP → Clients → reset secret |
| `STRIPE_*` | not set yet | payments | Stripe dashboard |

**`.env` is gitignored and must stay that way.** Render holds its own copy;
the two are independent. Changing one does not change the other.

### Rotating anything

1. Generate the new value in that service's dashboard.
2. Update `.env` locally.
3. Update Render → Environment (this triggers a redeploy).
4. `npm run verify` if it was a Supabase key.

The DB password is only used by the CLI, so rotating it breaks nothing that
is running.

---

## 3. Deploying a change

Render watches `main`. Pushing deploys.

```powershell
npm test                 # 321 tests, ~45s. Do not skip this.
git add -A
git commit -m "..."
git push origin main
```

Render builds and swaps automatically. Watch it at
**dashboard.render.com → mamenLi → Deploys**.

If a deploy fails, the previous version keeps serving — a bad push does not
take the site down.

### Build settings (Render → Settings)

| | |
|---|---|
| Build Command | `npm ci --omit=dev && npm --prefix server ci --omit=dev` |
| Start Command | `node server/index.js` |
| Health Check Path | `/healthz` |

The build command has **two** installs because dependencies are split: the
root holds dev tooling, `server/` holds what actually runs. A build command of
just `npm install` produces `Cannot find module 'dotenv'` at startup. This
happened on the first deploy.

### Render environment variables

```
NODE_ENV=production
TRUST_PROXY=1
PUBLIC_BASE_URL=https://mimonim.com
CANONICAL_HOST=mimonim.com
PLATFORM_FEE_PERCENT=8
CURRENCY=usd
SUPABASE_URL=…
SUPABASE_ANON_KEY=…
SUPABASE_SERVICE_ROLE_KEY=…
SETTLE_SECRET=…
```

`TRUST_PROXY` must match how many proxies really sit in front. Render is one.
Setting it higher than the truth lets a caller spoof `X-Forwarded-For` and
choose their own rate-limit bucket, which silently disables every limit.

---

## 4. Changing the schema

`supabase/migrations/` is the source of truth. Applied so far, in order:

| Migration | What it did |
|---|---|
| `20260916120000_init` | tables, RLS, storage buckets, realtime, new-user trigger |
| `20260916140000_seal_the_market` | made bid ceilings private; settled price moved onto `spots` |
| `20260916160000_spot_price_defaults_to_floor` | an unbid spot is worth its floor, not null |
| `20260916180000_role_chosen_once` | OAuth users pick a side once, then it freezes |
| `20260916190000_fix_role_locked_null` | fixed a NULL bug in the above that broke **all** sign-ups |
| `20260916200000_garment_is_worn_by_someone` | added `listings.wears` — who the garment is cut for, which `garment` had been guessing |
| `20260916210000_brands_draw_their_own_spots` | `listings.rate_per_percent` + `front_multiplier`, `spots.proposed_by` + `approved`. The sponsor draws the rectangle now and its area sets the price |
| `20260916220000_declining_is_not_deleting` | `spots.declined` — refusing a sponsor releases their card instead of deleting the row, which used to cascade to the bid and strand the hold |

**Never edit a migration that has run.** Add a new one beside it.

```powershell
# create supabase/migrations/<UTC timestamp>_name.sql, then:
npx supabase db push --db-url "postgresql://postgres:<DB_PASSWORD>@db.zhwathzwrqxzgizanabn.supabase.co:5432/postgres"
npm run verify
```

The direct database host is **IPv6-only**. On a network without IPv6 this
fails with a timeout — use the Supabase pooler host instead.

`supabase/apply-all.sql` is a concatenation of every migration for pasting
into the SQL editor by hand. It is generated, not authoritative.

### Verifying the database

`npm run verify` does not just check that tables exist — it checks that the
things which are supposed to be impossible really are: that an anonymous
client cannot insert a bid, cannot insert a listing, and cannot change its own
role. It fails the run if any of those succeed.

An earlier version of that script reported green against a **completely empty
database**, because a missing table refuses writes just like RLS does. It now
distinguishes the two. If you extend it, keep that distinction.

---

## 5. Changing the domain

Say the new domain is `example.com`. Five places, and missing any one breaks
something subtle.

1. **Render** → Settings → Custom Domains → add `example.com` and
   `www.example.com`.
2. **DNS at the registrar:**

   | Type | Name | Value |
   |---|---|---|
   | A | `@` | `216.24.57.1` |
   | CNAME | `www` | `mamenli.onrender.com` |

   Delete any parking or forwarding record first. A CNAME cannot sit on the
   apex — that is why the root is an `A` record.

3. **Render env** → `PUBLIC_BASE_URL=https://example.com` and
   `CANONICAL_HOST=example.com`. Without these, Stripe returns buyers to the
   old domain and `www` will not fold into the apex.
4. **Supabase** → Authentication → URL Configuration → Site URL and Redirect
   URLs (`https://example.com/**`). Sign-in silently breaks otherwise.
5. **Google Cloud** → Clients → Authorised JavaScript origins. The *redirect
   URI* stays `https://zhwathzwrqxzgizanabn.supabase.co/auth/v1/callback` —
   it belongs to Supabase, not to you, and changing it is the usual cause of
   `redirect_uri_mismatch`.

Email is separate: moving domains means re-verifying in **Resend** and
updating the sender address.

---

## 6. Things that actually bit us

Recorded because each one cost real time.

- **The whole repo was being served.** A static handler pointed at the project
  root hands out `/.git/config`, and with it every secret ever committed. Only
  `public/` is served now. Do not widen that.
- **GoDaddy appends the domain.** A DNS record for
  `resend._domainkey.mimonim.com` is entered with the Name `resend._domainkey`.
  Pasting the full hostname creates `…mimonim.com.mimonim.com` and verification
  never completes, with no useful error.
- **GoDaddy forwarding overrides DNS.** While it is on, the domain serves
  GoDaddy's page no matter what the A record says. Look for `Server: DPS/…` in
  the response headers.
- **DNS caches lie.** After changing a record, `ipconfig /flushdns` before
  concluding anything. We chased a ghost for several minutes because the OS
  cache still held the old IP while every public resolver had the new one.
- **Supabase's built-in email only reaches your own org members.** It is not a
  mail service. Without custom SMTP, sign-up works for you and fails for every
  real user.
- **`NULL` is not `false` in SQL.** `wanted in ('client','brand')` is `NULL`
  when `wanted` is `NULL`, and writing that into a `NOT NULL` column aborted
  every account creation. Wrap membership tests in `coalesce(…, false)`.
- **Render's free tier sleeps** after 15 minutes idle, then takes ~50s to wake.
  Automated checks that run immediately after a cold start will see a
  half-booted page and report nonsense.

---

## 7. Not done yet

**Settlement is not scheduled.** Nothing closes a listing on its own.
`POST /api/settle/:listingId` with header `x-settle-secret: <SETTLE_SECRET>`
captures the winners and releases everyone else. **Until this is scheduled,
card authorisations simply expire and the publisher is paid nothing.** A Render
Cron Job pointed at it is the intended fix.

**Stripe is not configured.** The footer reads "payments not configured" and
bidding stays in demo mode. Needs `STRIPE_SECRET_KEY`,
`STRIPE_PUBLISHABLE_KEY`, and `STRIPE_WEBHOOK_SECRET`, plus a webhook endpoint
at `https://mimonim.com/api/webhook` subscribed to
`checkout.session.completed` and `checkout.session.expired`.

**Stripe authorisations expire after about 7 days**, so a campaign has to
close sooner than that. This is Stripe's limit, not ours.

**Free plan.** Fine while nothing real is running; wrong the moment people are
bidding against a visible countdown.

**Email confirmation is off.** Turn it back on in Supabase → Authentication →
Sign In / Providers → *Confirm email* now that Resend is verified.

**The test listing is still in the database** — "Maya & Tal", one spot, two
accounts. Delete it before real users arrive.

---

## 8. Quick reference

```powershell
npm test          # 321 tests
npm run verify    # prove the live database still refuses what it should
npm start         # local, http://localhost:8787
npm run dev       # local with reload
```

| Dashboard | URL |
|---|---|
| Render service | dashboard.render.com/web/srv-dal80glg1s2s73ei292g |
| Supabase | supabase.com/dashboard/project/zhwathzwrqxzgizanabn |
| Resend | resend.com/domains |
| Google Cloud | console.cloud.google.com → project `mimonim` |
| GoDaddy DNS | dcc.godaddy.com → mimonim.com → DNS |
