---
name: mimonim-market
description: Understand or change how bidding works on the Square Inch site - the proxy auction, minimum raise, anti-snipe, settlement price, or the platform fee. Use when asked to change bidding rules, explain why a spot settled at a given price, debug a bid that was refused or a price that looks wrong, or touch market.js. Covers why the engine is shared by browser and server, the invariants that must not break, and two real bugs this logic already had.
---

# The market

`public/assets/js/market.js` — about 200 lines, no dependencies, **loaded by
both the browser and the server**. That is the point: the page quotes with the
same `evaluate()` the server revalidates with, so a tampered client cannot
invent a price the rules would refuse.

It is a UMD module — `require()` from Node, `window.Market` in a browser. Do
not convert it to ESM without solving that for both sides.

## The rules

Each spot has a **floor** set by the publisher. A brand states the **maximum**
it will pay. The spot then sits at *the least that brand needs to stay ahead* —
not at their maximum.

- One bidder pays the **floor**, however high their maximum was.
- A second bidder above the first takes it, paying just over the loser's
  maximum (capped at their own).
- A bidder *under* the leader's ceiling does **not** win, but **pushes the
  leader's price up** — a lowball still costs the holder money.
- Ties go to whoever bid first.
- A new bid must clear the standing price by **15%** (`RULES.MIN_RAISE`).
- **Anti-snipe:** a bid inside the last **10 minutes** (`RULES.ANTI_SNIPE_MIN`)
  moves the close to `now + 10 minutes`. A spot only closes after ten quiet
  minutes.

Bidding your true ceiling early therefore costs nothing. That property is the
whole design — the reference site this was modelled on doubles the last sale on
takeover, which locks everyone out after two rounds.

## Invariants

Anything you change must keep these. `test/engine-server-parity.test.js` runs
400 seeded markets asserting them.

- the holder is always the bidder with the highest maximum
- the settled price is never above the holder's own maximum, never below the floor
- a bidder is never charged more than their stated maximum
- removing a **non-leader** bid must not change who holds the spot
- a bid below the current minimum changes neither holder nor price

## Two bugs this logic already had

Both were found by tests, not by reading. Assume more are hiding.

**Self-bidding inflation.** `settle()` did not de-duplicate by bidder, so a
holder raising their own ceiling became their own runner-up and bid against
themselves — alone at a floor of 100, raising to 1200 made them pay 1150, and
it also ratcheted the bar for genuine rivals from 115 to 1323, which works as a
lockout. Fixed by keeping only each bidder's strongest live bid before choosing
leader and runner-up.

**`campaign().met` disagreeing with its own figures.** It compared raw float
accumulators against a raw target while publishing rounded values, so a bar
could read "2.14 raised of 2.14" and still report the goal unmet. Compare the
figures you publish, not the ones behind them.

## Where the browser stops being trusted

Since bid ceilings became private, the browser cannot compute a settlement — it
does not know rivals' maximums and must not. So:

- `Store.market(spot)` reads the settled price from `spots.price`, written by
  the server. In demo mode it falls back to the engine.
- `Store.quote()` can only answer with a **range**: at least the minimum, never
  more than your own maximum. The bid sheet says exactly that rather than
  pretending to know.
- `/api/bid` recomputes everything from the database before asking Stripe.

If you add a screen that needs a price, read `spots.price`. Do not reach for
`Market.settle` on the client — outside demo mode it has nothing to work with.

## Money follows the same shape

Authorise the **maximum**, capture the **settled price** — see the
`mimonim-payments` skill. The gap between the two is a hold, released at close.
The bid sheet shows both numbers because conflating them would be a lie.

## Changing a rule

`RULES` at the top of `market.js` holds `MIN_RAISE`, `ANTI_SNIPE_MIN`,
`MAX_BID`, `MIN_BID`. Changing one changes both the page and the server at once,
which is the intent — but `/api/config` also publishes `minRaise` and
`antiSnipeMinutes` to the page, and the FAQ copy in `public/index.html` states
"15%" and "ten minutes" in prose. Update the prose too, or the site will lie to
people about its own rules.

Run `npm test` after any change here. 106 of the tests are this file alone.
