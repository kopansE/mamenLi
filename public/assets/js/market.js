/* =========================================================================
   Square Inch - the market engine.

   One file, no dependencies, loaded by BOTH the browser and the server. That
   is deliberate: the server revalidates every bid with the same code the page
   used to quote it, so a tampered client can never invent a price the rules
   would not allow.
   ========================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;   // node
  else root.Market = api;                                                   // browser
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const RULES = {
    /* A bid has to beat the standing price by this much. The reference site
       doubles the last sale, which locks out everyone after two takeovers;
       15% keeps a spot contestable all the way to close. */
    MIN_RAISE: 0.15,
    /* A bid inside the last ANTI_SNIPE minutes pushes the close out by the
       same amount, so a spot cannot be stolen in the final second. */
    ANTI_SNIPE_MIN: 10,
    MAX_BID: 1000000,
    MIN_BID: 1,
  };

  const money = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const up = n => Math.ceil(Number(n) - 1e-9);          // bids step in whole units
  const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

  /* The smallest bid that beats `price`. */
  const raiseOver = price => up(price * (1 + RULES.MIN_RAISE));

  /* ---------------------------------------------------------------- settle
     Proxy bidding, the way an auction house runs it. Everyone states a
     maximum; the spot sits at the least the leader needs to hold it, not at
     whatever they were willing to pay. Nobody is punished for bidding their
     true ceiling early, which is what stops the last-minute scramble. */
  function settle(spot, bids) {
    const floor = Math.max(Number(spot && spot.floor) || 0, RULES.MIN_BID);
    const live = (bids || [])
      .filter(b => b && !b.withdrawn && Number(b.max) >= floor)
      .slice()
      .sort((a, b) => (Number(b.max) - Number(a.max)) || (ts(a.at) - ts(b.at)));

    if (!live.length) return { holder: null, price: floor, leader: null, runnerUp: null, depth: 0 };

    /* Keep only each bidder's strongest live bid. Without this, a holder who
       raises their own ceiling becomes their own runner-up and bids against
       themselves: alice alone at 1000 pays the floor, but the moment she
       raises to 1200 her own old bid sets the price and she pays 1150. It
       also ratchets the bar for genuine rivals, so it doubles as a lockout.
       `live` is already sorted by (max desc, at asc), so the first sighting
       of a bidder is their best and earliest one. */
    const strongest = [];
    const seen = new Set();
    for (const b of live) {
      if (b.bidder != null) {
        if (seen.has(b.bidder)) continue;
        seen.add(b.bidder);
      }
      strongest.push(b);
    }

    const leader = strongest[0];
    const runnerUp = strongest[1] || null;
    const price = runnerUp
      ? clamp(raiseOver(Number(runnerUp.max)), floor, Number(leader.max))
      : floor;

    return {
      holder: leader.bidder,
      holderName: leader.brand || null,
      holderLogo: leader.logo || null,
      price: money(price),
      leader,
      runnerUp,
      depth: strongest.length,      // distinct bidders, not rows
    };
  }

  /* The least a newcomer must offer to take the spot from its current holder. */
  function nextMinimum(spot, bids) {
    const s = settle(spot, bids);
    return s.holder ? raiseOver(s.price) : s.price;
  }

  /* ---------------------------------------------------------------- evaluate
     Answers "what happens if this bidder offers this maximum" without
     changing anything. The page calls it on every keystroke to draw the
     quote; the server calls it before it will take a payment. */
  function evaluate(spot, bids, offer) {
    const now = offer && offer.now ? ts(offer.now) : Date.now();
    const bidder = offer && offer.bidder;
    const max = Number(offer && offer.max);
    const before = settle(spot, bids);
    const minimum = nextMinimum(spot, bids);

    const reject = reason => ({ ok: false, reason, minimum, price: before.price, holder: before.holder });

    if (!spot || spot.id == null) return reject("That spot does not exist.");
    if (spot.closed || (spot.listingClosed === true)) return reject("Bidding on this listing has closed.");
    const closes = closingTime(spot);
    if (closes && now >= closes) return reject("Bidding on this spot has closed.");
    if (!Number.isFinite(max)) return reject("Enter an amount.");
    if (max > RULES.MAX_BID) return reject("That is over the maximum bid.");
    if (max < minimum) {
      return reject(before.holder
        ? `You need at least ${minimum} to take this spot.`
        : `The floor on this spot is ${minimum}.`);
    }
    if (before.holder && bidder && before.holder === bidder && max <= Number(before.leader.max)) {
      return reject("You already hold this spot at a higher maximum.");
    }

    const after = settle(spot, (bids || []).concat([{ bidder, brand: offer.brand, max, at: now }]));
    const won = after.holder === bidder;

    return {
      ok: true,
      won,
      /* what you pay right now if you take it */
      price: after.price,
      minimum,
      /* the maximum you are exposed to - never more than you typed */
      max: money(max),
      /* who loses the spot, and what they get back */
      outbid: won && before.holder && before.holder !== bidder
        ? { bidder: before.holder, brand: before.holderName, refund: before.price }
        : null,
      /* you raised the leader's price but did not take the spot */
      pushedTo: !won ? after.price : null,
      holder: after.holder,
      closesAt: extendIfLate(spot, now),
    };
  }

  /* ---------------------------------------------------------------- commit
     Applies an accepted bid. Returns the new bid list and everything the
     caller has to act on - who to refund, when the spot now closes. */
  function commit(spot, bids, offer) {
    const verdict = evaluate(spot, bids, offer);
    if (!verdict.ok) return { ok: false, reason: verdict.reason, bids };

    const now = offer.now ? ts(offer.now) : Date.now();
    const bid = {
      id: offer.id || uid(),
      bidder: offer.bidder,
      brand: offer.brand,
      logo: offer.logo || null,
      max: money(offer.max),
      at: now,
    };
    const next = (bids || []).concat([bid]);
    const after = settle(spot, next);

    return {
      ok: true,
      bid,
      bids: next,
      holder: after.holder,
      price: after.price,
      won: verdict.won,
      outbid: verdict.outbid,
      closesAt: verdict.closesAt,
    };
  }

  /* ---------------------------------------------------------------- closing */
  function closingTime(spot) {
    const t = ts(spot && (spot.closesAt || spot.closes_at));
    return Number.isFinite(t) && t > 0 ? t : null;
  }

  /* A bid landing inside the anti-snipe window pushes the close out. */
  function extendIfLate(spot, now) {
    const closes = closingTime(spot);
    if (!closes) return null;
    const windowMs = RULES.ANTI_SNIPE_MIN * 60000;
    return (closes - now < windowMs) ? now + windowMs : closes;
  }

  /* ---------------------------------------------------------------- money */
  function quote(amount, feePercent) {
    const placement = money(amount);
    const fee = money(placement * (Number(feePercent) || 0) / 100);
    return { placement, fee, total: money(placement + fee) };
  }

  /* ---------------------------------------------------------- the campaign
     What the progress bar reads. `goal` is the publisher's target; a spot
     counts at its settled price, not at its floor. */
  function campaign(spots, bidsBySpot, goal) {
    let raised = 0, held = 0, open = 0, floorTotal = 0;
    for (const spot of spots || []) {
      const s = settle(spot, (bidsBySpot && bidsBySpot[spot.id]) || []);
      floorTotal += Number(spot.floor) || 0;
      if (s.holder) { raised += s.price; held++; } else { open++; }
    }
    /* Compare the figures we actually publish, not the float accumulators
       behind them: 1 + 1.14 is 2.1399999999999997, which renders as
       "2.14 raised of 2.14" and would still report the goal as missed. */
    const raisedOut = money(raised);
    const goalOut = money(Number(goal) > 0 ? Number(goal) : floorTotal);
    return {
      raised: raisedOut,
      goal: goalOut,
      pct: goalOut > 0 ? clamp(raisedOut / goalOut, 0, 1) : 0,
      met: raisedOut >= goalOut,
      held, open, total: (spots || []).length,
    };
  }

  /* ---------------------------------------------------------------- utils */
  function ts(v) {
    if (v == null) return NaN;
    if (typeof v === "number") return v;
    const t = Date.parse(v);
    return Number.isNaN(t) ? NaN : t;
  }

  function uid() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  /* Human countdown: "2d 04h", "3h 12m", "48s". */
  function countdown(until, now) {
    const ms = ts(until) - (now || Date.now());
    if (!Number.isFinite(ms)) return "—";
    if (ms <= 0) return "closed";
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${String(h % 24).padStart(2, "0")}h`;
    if (h > 0) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
    if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
    return `${s}s`;
  }

  return { RULES, settle, nextMinimum, evaluate, commit, quote, campaign, countdown, closingTime, extendIfLate, money, raiseOver };
});
