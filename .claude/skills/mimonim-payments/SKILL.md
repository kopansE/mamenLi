---
name: mimonim-payments
description: Wire up or change Stripe on the Square Inch site, and schedule the settlement job that actually charges the winners. Use when asked to enable payments, add Stripe keys, set up the webhook, take the site out of demo mode, or when bids are placed but nobody is ever charged. Covers the authorise-the-maximum / capture-the-settled-price model, the 7-day authorisation limit that constrains campaign length, and the cron job without which publishers are paid nothing.
---

# Payments and settlement

**Currently not configured.** The footer reads "payments not configured" and
bidding runs in demo mode.

## The model

Bidding takes an **authorisation, not a charge** (`capture_method: 'manual'`).

- Bid placed → Stripe authorises the bidder's **maximum**, plus the platform fee.
- Outbid → the authorisation is **cancelled**, not refunded. The money was never
  taken, so there is nothing to wait for.
- Still holding at close → Stripe captures the **settled price**, which is
  usually *less* than was authorised. Stripe permits capturing under the
  authorised amount, which is exactly the shape proxy bidding needs.
- Goal missed → every authorisation is released and nobody pays.

The bid sheet shows both numbers, because conflating "what you'd owe" with
"what is held on your card" would be a lie.

> **Stripe authorisations expire after about 7 days.** A campaign must close
> sooner than that. This is Stripe's limit and there is no way around it — a
> longer campaign needs re-authorisation before the holds lapse.

## Turning it on

1. Stripe dashboard → Developers → API keys. Copy the secret and publishable
   keys (test keys first).
2. Add to **Render → Environment** *and* local `.env`:
   ```
   STRIPE_SECRET_KEY=sk_…
   STRIPE_PUBLISHABLE_KEY=pk_…
   STRIPE_WEBHOOK_SECRET=whsec_…
   ```
3. Stripe → Developers → Webhooks → add endpoint
   `https://mimonim.com/api/webhook`, subscribed to:
   - `checkout.session.completed`
   - `checkout.session.expired`

   Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

**Without the webhook secret the endpoint refuses every request**, which means
authorised bids are never recorded. Set it before taking money.

Locally: `stripe listen --forward-to localhost:8787/api/webhook`.

## Settlement — the part that is easy to forget

**Nothing closes a listing on its own.** Until this is scheduled, every
authorisation quietly expires and **the publisher is paid nothing**.

```
POST https://mimonim.com/api/settle/<listingId>
x-settle-secret: <SETTLE_SECRET>
```

It prices every spot from *all* its bids, captures each winner at the settled
price, releases everyone else, and closes the listing. It refuses to settle a
spot whose clock is still running (anti-snipe may have extended it) unless
`?force=1`.

Set it up as a **Render Cron Job** pointed at the listing's close time, or a
GitHub Action. The secret is compared with `timingSafeEqual` and the route has
its own 6/min rate limit.

## Why the client is never trusted for a price

`/api/bid` reads the listing, the spot and every live bid from its own database,
revalidates with the same `market.js` the page quoted with, and only then asks
Stripe for money. The request body says *which spot* and *what the bidder is
willing to pay* — never what something costs.

Also server-decided, because `listings` is owner-writable and a publisher could
otherwise edit them through PostgREST:

- **The platform fee** comes from `PLATFORM_FEE_PERCENT`, not the listing row.
- **The currency** is validated against an allowlist. A publisher setting a
  zero-decimal currency like JPY would otherwise turn a ¥1,000 bid into a
  ¥100,000 charge, because Stripe takes amounts in minor units and JPY has none.

`test/server.test.js` asserts that a client stuffing `price`, `floor`,
`feePercent` or `currency` into the request body changes nothing.

## What is not covered by tests

The **successful** Stripe path. `stripe-node` 16 has no host override, so a bid
that got all the way through would really call `api.stripe.com`. Every test
stops at a guard *before* Stripe — which is every guard that decides a price or
an identity. `resettle()` and the capture half of settlement are therefore
unverified at the HTTP level; the pricing logic underneath them is covered by
property tests. Exercise them once by hand in test mode with `stripe listen`
before taking real money.
