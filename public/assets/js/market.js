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

    /* ---------------------------------------------------- priced by area
       The brand draws the rectangle it wants and the price follows from how
       much of the photograph it covers. These are the fall-backs for a
       listing that has not said otherwise - the publisher sets both on the
       row, and `rateOf`/`frontMultiplierOf` land here when the row is silent,
       out of range, or not a number at all. */
    RATE_PER_PERCENT: 250,
    /* The front of a garment is what the camera is pointed at all evening,
       so the same rectangle costs more there than on the back. */
    FRONT_MULTIPLIER: 1.6,
    /* A box smaller than this carries a price nobody can read on a phone and
       a logo nobody can recognise; a box larger than this is one brand
       buying the whole garment and ending the market. Both are enforced in
       here rather than in the page, so the server agrees by construction. */
    MIN_AREA_PCT: 0.8,
    MAX_AREA_PCT: 12,
  };

  const money = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const up = n => Math.ceil(Number(n) - 1e-9);          // bids step in whole units
  const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

  /* The smallest bid that beats `price`. */
  const raiseOver = price => up(price * (1 + RULES.MIN_RAISE));

  /* ============================================================ the cloth
     The publisher no longer draws the spots. A brand drags out the rectangle
     it wants, anywhere on the front or the back, and the floor under it
     follows from the AREA it covers. Everything in this section is loaded by
     both sides for the same reason `evaluate` is: the page has to quote a
     price while the finger is still moving, and the server has to arrive at
     that identical number from its own copy of the listing. Two
     implementations would be two prices.

     A box is { side, x, y, w, h }, every one of them a PERCENTAGE of the
     photograph - never a pixel. A layout dragged out on a laptop lands in the
     same place on a phone, and replacing the photograph does not move
     anything that was sold on the old one. */

  /* How much of the image the box covers, as a percentage of its area.
     `w` and `h` are each already a percentage, so their product is in
     hundredths of a percent and has to come back down by 100:
     a 27% x 10% box covers 2.7% of the photograph, not 270%. */
  function areaPercent(box) {
    return Number(box && box.w) * Number(box && box.h) / 100;
  }

  /* `rate_per_percent` and `front_multiplier` live on the listing, which its
     owner edits directly under RLS - so they are read defensively. A blank,
     negative or non-numeric rate falls back to the default rather than
     pricing somebody's dress at NaN, which `Math.ceil` would hand straight to
     a NOT NULL numeric column. The bounds match the CHECK constraints on
     those two columns, so what the database refuses this refuses too. */
  /* "Absent" and "zero" are different answers, and `Number` conflates them:
     Number(null) is 0, not NaN. Reading the rate with a bare Number() priced
     every box on a listing whose column is still null - which is every
     listing until the migration runs - at nothing at all, and did it
     silently. A missing column falls back to the default; only a rate that is
     really there and really zero means free. */
  const stated = v => (v === null || v === undefined || v === "" ? NaN : Number(v));

  function rateOf(listing) {
    const r = stated(listing && listing.rate_per_percent);
    return Number.isFinite(r) && r >= 0 ? r : RULES.RATE_PER_PERCENT;
  }
  function frontMultiplierOf(listing) {
    const m = stated(listing && listing.front_multiplier);
    return Number.isFinite(m) && m > 0 ? m : RULES.FRONT_MULTIPLIER;
  }

  /* The floor under a drawn box: area x rate, and more for the front.
     27% x 10% on the front of a default listing is 2.7 x 250 x 1.6 = 1080.

     Rounded with `up`, not with a bare Math.ceil, and that epsilon is load
     bearing: 2.7 * 250 * 1.6 happens to land exactly, but of the fifty
     thousand whole-number boxes on a 100x100 grid, sixteen hundred of them
     come out a dust mote above their own integer - 55.00000000000001 for a
     1% x 50% box at 100/1.1 - and a bare ceil charges the brand a whole extra
     unit for a float. `up` is the same rounding `raiseOver` already uses. */
  function priceForBox(box, listing) {
    const sideFactor = (box && box.side) === "front" ? frontMultiplierOf(listing) : 1;
    /* Math.max keeps a price out of the negatives and, less obviously, turns
       the -0 that `up(0)` produces back into 0 - a publisher who gives space
       away should not have "-0" written onto the spot. */
    return Math.max(0, up(areaPercent(box) * rateOf(listing) * sideFactor));
  }

  /* Two boxes intersect if they overlap on BOTH axes. The comparison is
     strict, with a hair of tolerance, so boxes that merely share an edge -
     x=10,w=20 against x=30 - are neighbours rather than a collision. A
     non-strict test makes it impossible to tile a garment at all, and without
     the tolerance two edges that are mathematically flush but a float apart
     read as an overlap of 0.0000000001% of a photograph. */
  const TOUCHING = 1e-9;
  function boxesOverlap(a, b) {
    return a.x + a.w > b.x + TOUCHING && b.x + b.w > a.x + TOUCHING
        && a.y + a.h > b.y + TOUCHING && b.y + b.h > a.y + TOUCHING;
  }

  const rect = b => b && [b.x, b.y, b.w, b.h].every(v => Number.isFinite(Number(v)))
    ? { x: Number(b.x), y: Number(b.y), w: Number(b.w), h: Number(b.h) }
    : null;

  const no = reason => ({ ok: false, reason });

  /* ---------------------------------------------------------- validateBox
     Everything that decides whether a drawn rectangle may exist, in one
     place: shape, side, bounds, size, and whether somebody is already
     printing there. Answers { ok, reason }, where `reason` is written to be
     shown to the person who drew it.

     `existing` is every spot already on THAT side of THAT listing. Pass the
     unapproved ones too: a rectangle a brand drew ten seconds ago is not
     approved yet, but it is claimed, and letting a second brand draw over it
     means two logos printed on one piece of cloth and one of them refunded
     after the wedding. First to draw holds the ground. */
  function validateBox(box, listing, existing) {
    const r = rect(box);
    if (!r) return no("Draw a box on the photograph.");

    /* The side is part of the price, not just a label: `priceForBox` charges
       the front multiplier only when it reads "front". A box that arrives
       with the side missing or misspelt would be priced as a back one and
       then drawn on the front, which is the front of a garment sold at the
       back's rate. */
    if (box.side !== "front" && box.side !== "back")
      return no("Draw on the front or on the back of the garment.");

    if (r.w <= 0 || r.h <= 0) return no("Drag out a box first.");
    if (r.x < 0 || r.y < 0 || r.x + r.w > 100 || r.y + r.h > 100)
      return no("Keep the whole box inside the photograph.");

    const area = areaPercent(r);
    if (area < RULES.MIN_AREA_PCT - TOUCHING)
      return no(`That is too small. A spot has to cover at least ${RULES.MIN_AREA_PCT}% of the photograph.`);
    if (area > RULES.MAX_AREA_PCT + TOUCHING)
      return no(`That is too big. A spot can cover at most ${RULES.MAX_AREA_PCT}% of the photograph.`);

    for (const other of existing || []) {
      const o = rect(other);
      /* A stored spot we cannot measure cannot be intersected either. Skip it
         rather than letting a NaN comparison quietly answer "no overlap". */
      if (!o) continue;
      if (other && other.id != null && box && box.id != null && other.id === box.id) continue;
      if (boxesOverlap(r, o)) {
        return no(other && other.n != null
          ? `That overlaps spot ${other.n}. Two brands cannot print on the same cloth.`
          : "That overlaps a spot somebody has already taken.");
      }
    }

    return { ok: true, reason: null };
  }

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

  return {
    RULES, settle, nextMinimum, evaluate, commit, quote, campaign, countdown,
    closingTime, extendIfLate, money, raiseOver,
    /* priced by the area a brand draws */
    areaPercent, priceForBox, validateBox, rateOf, frontMultiplierOf, boxesOverlap,
  };
});
