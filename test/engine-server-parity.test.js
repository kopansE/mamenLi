"use strict";

/* =========================================================================
   The auction engine is loaded by BOTH the browser and the server, and that
   is the whole reason a tampered client cannot invent a price: the page
   quotes with the same evaluate() the server revalidates with.

   Two things have to hold for that claim to be true.

   1. They must literally be the same file. `public/index.html` script-tags
      it; `server/index.js` require()s it. If those two paths ever drift -
      a copy, a bundle step, a move that updates one and not the other -
      the guarantee is gone and nothing else in the suite would notice.
      (`test/market.test.js` required `../assets/js/market.js` for exactly
      one commit after the move into `public/`, and simply stopped running.)

   2. The rules it implements have to hold for every input, not just the
      hand-picked ones. So the second half of this file is property-style:
      a few hundred seeded, deterministic bid sequences driven through
      Market.commit, checking invariants that must be true universally.

   The PRNG is fixed, so a failure here is reproducible from the seed printed
   in the assertion message rather than being a coin toss in CI.
   ========================================================================= */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const Market = require("../public/assets/js/market.js");

/* =========================================================================
   1. One file, two consumers
   ========================================================================= */
describe("the browser and the server load the same engine", () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, "server", "index.js"), "utf8");
  const pageSrc = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");

  it("server/index.js requires a market.js that exists", () => {
    const m = serverSrc.match(/require\(\s*["']([^"']*market\.js)["']\s*\)/);
    assert.ok(m, "server/index.js no longer requires market.js by name");
    const resolved = path.resolve(path.join(ROOT, "server"), m[1]);
    assert.ok(fs.existsSync(resolved), `server/index.js requires ${m[1]}, which does not exist`);
  });

  it("index.html script-tags a market.js that exists", () => {
    const m = pageSrc.match(/<script[^>]+src="([^"]*market\.js)"/);
    assert.ok(m, "index.html no longer loads market.js");
    const resolved = path.resolve(path.join(ROOT, "public"), m[1]);
    assert.ok(fs.existsSync(resolved), `index.html loads ${m[1]}, which does not exist`);
  });

  it("and it is the SAME file, byte for byte the same path", () => {
    const fromServer = path.resolve(
      path.join(ROOT, "server"),
      serverSrc.match(/require\(\s*["']([^"']*market\.js)["']\s*\)/)[1]);
    const fromPage = path.resolve(
      path.join(ROOT, "public"),
      pageSrc.match(/<script[^>]+src="([^"]*market\.js)"/)[1]);
    assert.equal(fromServer, fromPage,
      "the server and the page are loading two different copies of the engine - " +
      "the price the page quotes can now diverge from the price the server charges");
  });

  it("this suite is testing that same file", () => {
    assert.equal(
      path.resolve(path.join(ROOT, "public"), "assets/js/market.js"),
      path.resolve(require.resolve("../public/assets/js/market.js")));
  });

  it("the engine is UMD: require()-able in node and self-attaching in a browser", () => {
    const src = fs.readFileSync(path.join(ROOT, "public", "assets", "js", "market.js"), "utf8");
    assert.match(src, /module\.exports/, "node needs module.exports");
    assert.match(src, /root\.Market\s*=/, "the browser needs window.Market");
    assert.ok(!/\brequire\s*\(/.test(src.replace(/require\(\)/g, "")),
      "the engine must have no dependencies - the browser cannot resolve them");
  });

  it("the rules the server publishes to the page come from the engine, not a copy", () => {
    const m = serverSrc.match(/minRaise:\s*([^,\n]+)/);
    assert.ok(m, "/api/config no longer publishes minRaise");
    assert.match(m[1], /Market\.RULES\.MIN_RAISE/,
      "minRaise must be read from the engine; a literal here can drift from it");
    assert.match(serverSrc, /antiSnipeMinutes:\s*Market\.RULES\.ANTI_SNIPE_MIN/);
  });
});

/* =========================================================================
   2. Properties, over seeded pseudo-random markets
   ========================================================================= */

/* mulberry32: 32 bits of state, no dependencies, identical on every run. */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const BIDDERS = ["alice", "bob", "carol", "dave", "erin", "frank", "grace"];

/* One deterministic market: a spot, and a run of offers to push at it. */
function market(seed) {
  const r = rng(seed);
  const pick = arr => arr[Math.floor(r() * arr.length)];
  const floor = [1, 50, 100, 350, 700, 1200, 5000][Math.floor(r() * 7)];

  /* Closing far enough out that the anti-snipe window never fires; the
     clock is its own set of tests in market.test.js. */
  const spot = { id: `spot-${seed}`, floor, closesAt: T0 + 30 * 86400000 };

  const offers = [];
  const n = 2 + Math.floor(r() * 7);
  for (let i = 0; i < n; i++) {
    /* A spread that reaches under the floor, around it, and well over it, so
       rejections are part of the sample rather than an edge case. */
    const shape = r();
    const max = shape < 0.2
      ? Math.max(0, Math.round(floor * r()))                       // below the floor
      : shape < 0.5
        ? Math.round(floor * (1 + r()))                            // just over it
        : Math.round(floor * (1 + r() * 9));                       // well over
    offers.push({
      bidder: pick(BIDDERS),
      brand: pick(["Acme", "Nimbus", "Vortex", "Halcyon", "Quill"]),
      max,
      /* Ties on `at` happen on purpose: whole minutes, with repeats. */
      now: T0 + Math.floor(r() * 12) * 60000,
    });
  }
  return { spot, offers };
}

/* Drive the offers through commit(), keeping only the accepted ones - which
   is exactly what the server does when Stripe confirms an authorisation. */
function play(spot, offers) {
  let bids = [];
  const accepted = [], refused = [];
  for (const offer of offers) {
    const before = Market.settle(spot, bids);
    const out = Market.commit(spot, bids, offer);
    if (out.ok) { bids = out.bids; accepted.push({ offer, out, before }); }
    else refused.push({ offer, out, before });
  }
  return { bids, accepted, refused };
}

const RUNS = 400;
const seeds = Array.from({ length: RUNS }, (_, i) => 1000 + i * 7);

const where = (seed, extra = "") =>
  `seed ${seed}${extra ? " - " + extra : ""} (reproduce: market(${seed}))`;

describe("invariants over 400 seeded markets", () => {
  it("the holder is always the bidder with the highest maximum", () => {
    for (const seed of seeds) {
      const { spot, offers } = market(seed);
      const { bids } = play(spot, offers);
      const s = Market.settle(spot, bids);

      /* Only bids at or above the floor are live at all. */
      const live = bids.filter(b => Number(b.max) >= Math.max(spot.floor, Market.RULES.MIN_BID));
      if (!live.length) {
        assert.equal(s.holder, null, where(seed, "no live bid, yet somebody holds the spot"));
        continue;
      }
      const best = Math.max(...live.map(b => Number(b.max)));
      const holderBest = Math.max(...live.filter(b => b.bidder === s.holder).map(b => Number(b.max)));
      assert.equal(holderBest, best,
        where(seed, `holder ${s.holder} tops out at ${holderBest}, but ${best} was on the table`));
    }
  });

  it("ties go to the earlier bid", () => {
    for (const seed of seeds) {
      const { spot, offers } = market(seed);
      const { bids } = play(spot, offers);
      const s = Market.settle(spot, bids);
      if (!s.holder) continue;

      const best = Math.max(...bids.map(b => Number(b.max)));
      const tied = bids.filter(b => Number(b.max) === best);
      if (tied.length < 2) continue;
      const earliest = Math.min(...tied.map(b => b.at));
      const holderAt = Math.min(...tied.filter(b => b.bidder === s.holder).map(b => b.at));
      assert.equal(holderAt, earliest,
        where(seed, `a tie at ${best} went to a bid placed at ${holderAt}, not ${earliest}`));
    }
  });

  it("an explicit tie is broken by time, not by insertion order", () => {
    /* Constructed rather than sampled: the generator produces ties, but this
       pins the rule down on its own. */
    const spot = { id: "s", floor: 100 };
    const late = { bidder: "late", brand: "L", max: 500, at: T0 + 60000 };
    const early = { bidder: "early", brand: "E", max: 500, at: T0 };
    assert.equal(Market.settle(spot, [late, early]).holder, "early");
    assert.equal(Market.settle(spot, [early, late]).holder, "early");
  });

  it("the settled price is never below the floor and never above the holder's own maximum", () => {
    for (const seed of seeds) {
      const { spot, offers } = market(seed);
      const { bids } = play(spot, offers);
      const s = Market.settle(spot, bids);
      const floor = Math.max(spot.floor, Market.RULES.MIN_BID);

      assert.ok(s.price >= floor, where(seed, `price ${s.price} is under the floor ${floor}`));
      if (!s.holder) {
        assert.equal(s.price, floor, where(seed, "an unheld spot must sit exactly at its floor"));
        continue;
      }
      const holderMax = Math.max(...bids.filter(b => b.bidder === s.holder).map(b => Number(b.max)));
      assert.ok(s.price <= Market.money(holderMax),
        where(seed, `price ${s.price} exceeds the holder's maximum ${holderMax}`));
    }
  });

  it("nobody is ever charged more than the number they typed", () => {
    for (const seed of seeds) {
      const { spot, offers } = market(seed);
      const { bids, accepted } = play(spot, offers);
      const s = Market.settle(spot, bids);
      if (!s.holder) continue;

      /* The winning row is what settlement captures against. */
      assert.ok(s.price <= Market.money(Number(s.leader.max)),
        where(seed, `leader would be charged ${s.price} against a stated ${s.leader.max}`));

      /* And the quote the page drew said the same thing at the time. */
      for (const { out, offer } of accepted) {
        assert.ok(out.price <= Market.money(Number(offer.max)) || out.holder !== offer.bidder,
          where(seed, `commit quoted ${out.price} to a bidder whose maximum was ${offer.max}`));
      }
    }
  });

  it("removing a NON-LEADER bid never changes who holds the spot", () => {
    /* Releasing a loser's authorisation must not hand the spot to somebody
       else. It may well change the PRICE - that is the whole point of a
       second-price auction - but never the holder. */
    for (const seed of seeds) {
      const { spot, offers } = market(seed);
      const { bids } = play(spot, offers);
      const s = Market.settle(spot, bids);
      if (!s.holder || bids.length < 2) continue;

      for (const victim of bids) {
        if (s.leader && victim.id === s.leader.id) continue;      // by ROW, not by bidder
        const after = Market.settle(spot, bids.filter(b => b.id !== victim.id));
        assert.equal(after.holder, s.holder,
          where(seed, `dropping ${victim.bidder}'s ${victim.max} moved the spot from ${s.holder} to ${after.holder}`));
      }
    }
  });

  it("removing a non-leader bid never RAISES the price either", () => {
    for (const seed of seeds) {
      const { spot, offers } = market(seed);
      const { bids } = play(spot, offers);
      const s = Market.settle(spot, bids);
      if (!s.holder || bids.length < 2) continue;

      for (const victim of bids) {
        if (s.leader && victim.id === s.leader.id) continue;
        const after = Market.settle(spot, bids.filter(b => b.id !== victim.id));
        assert.ok(after.price <= s.price + 1e-9,
          where(seed, `dropping ${victim.bidder} pushed the price UP from ${s.price} to ${after.price}`));
      }
    }
  });

  it("a bid below the current minimum is refused, and changes nothing", () => {
    for (const seed of seeds) {
      const { spot, offers } = market(seed);
      const { bids } = play(spot, offers);
      const before = Market.settle(spot, bids);
      const minimum = Market.nextMinimum(spot, bids);

      for (const under of [minimum - 1, Math.floor(minimum / 2), 0, -100]) {
        const out = Market.commit(spot, bids, { bidder: "intruder", brand: "Lowball", max: under, now: T0 + 3600000 });
        assert.equal(out.ok, false, where(seed, `a maximum of ${under} was accepted below a minimum of ${minimum}`));
        assert.equal(out.bids, bids, where(seed, "a refused bid must return the untouched list"));

        const after = Market.settle(spot, out.bids);
        assert.equal(after.holder, before.holder, where(seed, "a refused bid moved the holder"));
        assert.equal(after.price, before.price, where(seed, "a refused bid moved the price"));
      }
    }
  });

  it("a bid AT the minimum is always accepted, and always moves the market", () => {
    /* The minimum is the least you are ALLOWED to offer, not the least that
       wins: against a proxy whose ceiling is higher, the same money buys you
       nothing but the satisfaction of making them pay more. Either outcome
       is fine; standing still is not. */
    for (const seed of seeds) {
      const { spot, offers } = market(seed);
      const { bids } = play(spot, offers);
      const before = Market.settle(spot, bids);
      const minimum = Market.nextMinimum(spot, bids);
      if (minimum > Market.RULES.MAX_BID) continue;

      const out = Market.commit(spot, bids, { bidder: "newcomer", brand: "Fresh", max: minimum, now: T0 + 3600000 });
      assert.equal(out.ok, true, where(seed, `the stated minimum ${minimum} was refused: ${out.reason}`));

      if (out.holder === "newcomer") {
        assert.ok(out.price <= minimum,
          where(seed, `the newcomer took the spot at ${out.price} having offered only ${minimum}`));
      } else {
        assert.equal(out.holder, before.holder, where(seed, "a losing bid handed the spot to a third party"));
        assert.ok(out.price > before.price,
          where(seed, `a bid of ${minimum} neither took the spot nor raised the price from ${before.price}`));
      }
    }
  });

  it("one unit BELOW the minimum is always refused", () => {
    for (const seed of seeds) {
      const { spot, offers } = market(seed);
      const { bids } = play(spot, offers);
      const minimum = Market.nextMinimum(spot, bids);
      const out = Market.commit(spot, bids, { bidder: "newcomer", brand: "Fresh", max: minimum - 1, now: T0 + 3600000 });
      assert.equal(out.ok, false,
        where(seed, `${minimum - 1} was accepted although the stated minimum is ${minimum}`));
    }
  });

  it("an accepted bid never lowers the price", () => {
    for (const seed of seeds) {
      const { spot, offers } = market(seed);
      const { accepted } = play(spot, offers);
      for (const { before, out, offer } of accepted) {
        assert.ok(out.price >= before.price - 1e-9,
          where(seed, `a bid of ${offer.max} dropped the price from ${before.price} to ${out.price}`));
      }
    }
  });

  it("a lowball that loses still pushes the holder's price up", () => {
    /* The documented behaviour: "a bidder under the leader's ceiling does not
       win, but pushes the leader's price up - so a lowball still costs the
       holder money". */
    const spot = { id: "s", floor: 100 };
    const leader = [{ id: "a", bidder: "alice", brand: "A", max: 5000, at: T0 }];
    assert.equal(Market.settle(spot, leader).price, 100);

    const pushed = Market.commit(spot, leader, { bidder: "bob", brand: "B", max: 1000, now: T0 + 60000 });
    assert.equal(pushed.ok, true);
    assert.equal(pushed.holder, "alice", "a bid under the ceiling must not take the spot");
    assert.ok(pushed.price > 100, "…but it must cost the holder more than the floor");
    assert.equal(pushed.price, Market.raiseOver(1000));
  });

  it("commit and evaluate agree on every sampled offer", () => {
    /* The page draws its quote with evaluate(); the server revalidates with
       evaluate() and then the row is written. If commit disagreed with the
       quote the buyer saw, the two would be charging different prices. */
    for (const seed of seeds) {
      const { spot, offers } = market(seed);
      let bids = [];
      for (const offer of offers) {
        const v = Market.evaluate(spot, bids, offer);
        const c = Market.commit(spot, bids, offer);
        assert.equal(c.ok, v.ok, where(seed, "commit and evaluate disagreed on whether to accept"));
        if (!v.ok) { assert.equal(c.reason, v.reason, where(seed, "different reasons")); continue; }
        assert.equal(c.price, v.price, where(seed, `commit priced at ${c.price}, evaluate quoted ${v.price}`));
        assert.equal(c.holder, v.holder, where(seed, "commit and evaluate disagreed on the holder"));
        assert.equal(c.won, v.won, where(seed, "commit and evaluate disagreed on who won"));
        bids = c.bids;
      }
    }
  });

  it("settle is pure: it neither mutates nor reorders the list it is given", () => {
    for (const seed of seeds) {
      const { spot, offers } = market(seed);
      const { bids } = play(spot, offers);
      const snapshot = JSON.stringify(bids);
      Market.settle(spot, bids);
      Market.nextMinimum(spot, bids);
      Market.evaluate(spot, bids, { bidder: "x", brand: "X", max: 10 ** 6, now: T0 });
      assert.equal(JSON.stringify(bids), snapshot, where(seed, "the engine mutated its input"));
    }
  });

  it("settle is deterministic - the same market always prices the same", () => {
    for (const seed of seeds) {
      const { spot, offers } = market(seed);
      const a = play(spot, offers);
      const b = play(spot, offers);
      assert.deepEqual(
        JSON.parse(JSON.stringify(a.bids.map(x => ({ bidder: x.bidder, max: x.max, at: x.at })))),
        JSON.parse(JSON.stringify(b.bids.map(x => ({ bidder: x.bidder, max: x.max, at: x.at })))),
        where(seed, "two identical runs produced different markets"));
      assert.deepEqual(
        { ...Market.settle(spot, a.bids), leader: null, runnerUp: null },
        { ...Market.settle(spot, b.bids), leader: null, runnerUp: null },
        where(seed, "settle is not deterministic"));
    }
  });

  it("the money quoted is never negative and the fee is never charged twice", () => {
    for (const seed of seeds) {
      const { spot, offers } = market(seed);
      const { bids } = play(spot, offers);
      const s = Market.settle(spot, bids);
      const q = Market.quote(s.price, 8);
      assert.ok(q.placement >= 0 && q.fee >= 0 && q.total >= 0, where(seed, "a negative quote"));
      assert.equal(q.total, Market.money(q.placement + q.fee), where(seed, "the total is not placement + fee"));
      assert.ok(Math.abs(q.fee - Market.money(s.price * 0.08)) < 0.005, where(seed, "the fee is not 8%"));
    }
  });

  it("a holder raising their own ceiling never bids against themselves", () => {
    /* Keeping every row would make the holder their own runner-up: alice
       alone at 1000 pays the floor, but the moment she raises to 1200 her own
       old bid sets the price and she pays 1150.

       The price IS allowed to move when the old ceiling was capping it - the
       clamp in settle() means a holder whose runner-up is close pays their
       full maximum, and raising the ceiling reveals the real second price.
       What must never happen is the holder's OWN earlier rows influencing it,
       so the control here is the same market with those rows deleted. */
    const NOW = T0 + 7200000;
    for (const seed of seeds) {
      const { spot, offers } = market(seed);
      const { bids } = play(spot, offers);
      const s = Market.settle(spot, bids);
      if (!s.holder) continue;

      const higher = Math.min(
        Market.RULES.MAX_BID,
        Math.max(Market.nextMinimum(spot, bids), Math.max(...bids.map(b => Number(b.max))) * 2 + 1000));

      const out = Market.commit(spot, bids, { bidder: s.holder, brand: "Same", max: higher, now: NOW });
      assert.equal(out.ok, true, where(seed, `raising a ceiling to ${higher} was refused: ${out.reason}`));
      assert.equal(out.holder, s.holder, where(seed, "raising a ceiling lost the spot"));

      const control = Market.settle(spot, bids
        .filter(b => b.bidder !== s.holder)
        .concat([{ bidder: s.holder, brand: "Same", max: higher, at: NOW }]));

      assert.equal(out.price, control.price,
        where(seed, `the holder's own earlier rows moved the price to ${out.price}; ` +
          `with only the new ceiling on the table it would be ${control.price}`));
      assert.ok(out.price <= Market.money(higher),
        where(seed, `raising the ceiling charged ${out.price} against a stated ${higher}`));
    }
  });

  it("raising your own ceiling on an uncontested spot still pays the floor", () => {
    const spot = { id: "s", floor: 1000 };
    const alone = [{ id: "a1", bidder: "alice", brand: "A", max: 1000, at: T0 }];
    assert.equal(Market.settle(spot, alone).price, 1000);

    const raised = Market.commit(spot, alone, { bidder: "alice", brand: "A", max: 1200, now: T0 + 60000 });
    assert.equal(raised.ok, true);
    assert.equal(raised.holder, "alice");
    assert.equal(raised.price, 1000, "alice was made to bid against her own earlier row");
  });

  it("depth counts distinct bidders, never rows", () => {
    for (const seed of seeds) {
      const { spot, offers } = market(seed);
      const { bids } = play(spot, offers);
      const s = Market.settle(spot, bids);
      const floor = Math.max(spot.floor, Market.RULES.MIN_BID);
      const distinct = new Set(bids.filter(b => Number(b.max) >= floor).map(b => b.bidder));
      assert.equal(s.depth, distinct.size,
        where(seed, `depth ${s.depth} against ${distinct.size} distinct live bidders`));
    }
  });

  it("the campaign total is the sum of the settled prices, not of the floors", () => {
    for (const seed of seeds.slice(0, 120)) {
      const a = market(seed), b = market(seed + 3), c = market(seed + 5);
      const spots = [a.spot, b.spot, c.spot];
      const bidsBySpot = {
        [a.spot.id]: play(a.spot, a.offers).bids,
        [b.spot.id]: play(b.spot, b.offers).bids,
        [c.spot.id]: play(c.spot, c.offers).bids,
      };
      const totals = Market.campaign(spots, bidsBySpot, 0);
      const expected = Market.money(spots
        .map(s => Market.settle(s, bidsBySpot[s.id]))
        .filter(s => s.holder)
        .reduce((n, s) => n + s.price, 0));
      assert.equal(totals.raised, expected, where(seed, "campaign() disagreed with settle()"));
      assert.equal(totals.held + totals.open, totals.total, where(seed, "held + open must be every spot"));
      assert.ok(totals.pct >= 0 && totals.pct <= 1, where(seed, `pct out of range: ${totals.pct}`));
    }
  });
});

/* =========================================================================
   The generator itself, so a green run cannot be a green run over nothing.
   ========================================================================= */
describe("the generator produces a market worth testing", () => {
  it("is deterministic across runs", () => {
    assert.deepEqual(market(1234), market(1234));
    assert.notDeepEqual(market(1234), market(1235));
  });

  it("produces both accepted and refused bids", () => {
    let accepted = 0, refused = 0, contested = 0, held = 0;
    for (const seed of seeds) {
      const { spot, offers } = market(seed);
      const r = play(spot, offers);
      accepted += r.accepted.length;
      refused += r.refused.length;
      if (new Set(r.bids.map(b => b.bidder)).size > 1) contested++;
      if (Market.settle(spot, r.bids).holder) held++;
    }
    assert.ok(accepted > 200, `only ${accepted} bids were ever accepted`);
    assert.ok(refused > 200, `only ${refused} bids were ever refused - the sample is not adversarial enough`);
    assert.ok(contested > RUNS * 0.3, `only ${contested} of ${RUNS} markets had more than one bidder`);
    assert.ok(held > RUNS * 0.8, `only ${held} of ${RUNS} markets ended up held`);
  });
});

/* =========================================================================
   3. The drawn box, priced identically on both sides of the wire

   The brand drags out a rectangle and the page quotes a floor for it while
   the finger is still moving. The server then recomputes that floor from its
   own copy of the listing before it writes a spot or takes a card. Those two
   numbers have to be the same number, every time, or the product is quoting
   one price and charging another.

   The mechanism is the same one the auction has always relied on: there is
   one implementation of the arithmetic and both sides require() it. The tests
   here prove that the server has no second one - no literal rate, no local
   ceil, no rounding of its own - and that the formula itself is what the
   README says it is.
   ========================================================================= */
describe("a drawn box is priced the same in the browser and on the server", () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, "server", "index.js"), "utf8");

  it("the server prices a drawn box with the engine and nothing else", () => {
    assert.match(serverSrc, /Market\.priceForBox\s*\(/,
      "the server must take the floor from the shared engine; its own multiplication can drift from the page's");
    assert.match(serverSrc, /Market\.validateBox\s*\(/,
      "the server must re-run the size and overlap rules itself - the browser's answer is an intent, not a verdict");
  });

  it("the server never recomputes the price by hand", () => {
    /* The literals are the giveaway. A `* 250` or a `* 1.6` in server code is
       a second copy of the price list that nobody will remember to change. */
    const body = serverSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/\b1\.6\b/.test(body), "a front multiplier literal has appeared in the server");
    assert.ok(!/rate_per_percent\s*\*/.test(body), "the server is multiplying the rate itself");
    assert.ok(!/\bdraw\.(w|h)\s*\*/.test(body), "the server is computing an area itself");
  });

  it("the server never takes a price, a floor or an area from the request body", () => {
    /* "The browser says WHICH spot and WHAT IT IS WILLING TO PAY. It never
       says what something costs." A drawn box moves the boundary - the
       browser now says WHERE too - but not the part after the comma. */
    const body = serverSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const field of ["floor", "price", "area", "areaPercent"]) {
      assert.ok(!new RegExp(`req\\.body\\.${field}\\b`).test(body), `the server reads req.body.${field}`);
      assert.ok(!new RegExp(`\\bdraw\\.${field}\\b`).test(body), `the server reads draw.${field}`);
    }
  });

  it("the documented worked example holds end to end", () => {
    /* README: "a 27% x 10% box on the front is 2.7% area -> 2.7 x 250 x 1.6
       = $1080". If this number ever moves, the documentation is wrong or the
       engine is. */
    const listing = { rate_per_percent: 250, front_multiplier: 1.6 };
    assert.equal(Market.areaPercent({ w: 27, h: 10 }), 2.7);
    assert.equal(Market.priceForBox({ side: "front", x: 12, y: 30, w: 27, h: 10 }, listing), 1080);
  });

  it("every box on a 100x100 grid prices identically from both directions", () => {
    /* One engine, so "both sides" cannot literally be two implementations -
       what is actually at risk is that the two sides read the LISTING
       differently. The page has the row from PostgREST, where a numeric
       column arrives as a string; the server has the same row from the
       service-role client. A rate of "250.00" and a rate of 250 must price
       the same, or the quote and the charge differ by a rounding. */
    const asNumbers = { rate_per_percent: 250, front_multiplier: 1.6 };
    const asStrings = { rate_per_percent: "250.00", front_multiplier: "1.60" };

    let checked = 0;
    for (let w = 1; w <= 100; w++) {
      for (let h = 1; h <= 100; h++) {
        for (const side of ["front", "back"]) {
          const box = { side, x: 0, y: 0, w, h };
          const a = Market.priceForBox(box, asNumbers);
          const b = Market.priceForBox(box, asStrings);
          assert.equal(a, b, `a ${w}x${h} box on the ${side} priced ${a} as numbers and ${b} as strings`);
          checked++;
        }
      }
    }
    assert.equal(checked, 20000);
  });

  it("the price is a whole number, never a float the two sides could round apart", () => {
    const r = rng(90210);
    const listing = { rate_per_percent: 250, front_multiplier: 1.6 };
    for (let i = 0; i < 2000; i++) {
      const w = Math.round(r() * 10000) / 100;
      const h = Math.round(r() * 10000) / 100;
      const side = r() < 0.5 ? "front" : "back";
      const price = Market.priceForBox({ side, x: 0, y: 0, w, h }, listing);
      assert.equal(price, Math.trunc(price),
        `a ${w}x${h} box on the ${side} priced at ${price}, which is not a whole unit`);
      assert.ok(price >= 0, `a ${w}x${h} box priced negative: ${price}`);
    }
  });

  it("the front always costs at least as much as the same box on the back", () => {
    const r = rng(1379);
    for (let i = 0; i < 1000; i++) {
      const listing = { rate_per_percent: Math.round(r() * 900) + 1, front_multiplier: 1 + r() * 3 };
      const box = { x: 0, y: 0, w: Math.round(r() * 99) + 1, h: Math.round(r() * 99) + 1 };
      const front = Market.priceForBox(Object.assign({ side: "front" }, box), listing);
      const back = Market.priceForBox(Object.assign({ side: "back" }, box), listing);
      assert.ok(front >= back,
        `the front (${front}) came out cheaper than the back (${back}) at x${listing.front_multiplier}`);
    }
  });

  it("validateBox and priceForBox agree on what a valid box is worth", () => {
    /* A box the rules accept must always have a price a card can be charged
       for: at the 0.8% minimum and the default rate that is 200 on the back,
       which clears RULES.MIN_BID with room to spare. A validated box that
       priced under the minimum bid would be accepted by the page and then
       refused by evaluate() on the server, with nothing the brand could do
       about it. */
    const listing = { rate_per_percent: 250, front_multiplier: 1.6 };
    const r = rng(4242);
    let accepted = 0;
    for (let i = 0; i < 4000; i++) {
      const box = {
        side: r() < 0.5 ? "front" : "back",
        x: Math.round(r() * 10000) / 100,
        y: Math.round(r() * 10000) / 100,
        w: Math.round(r() * 5000) / 100,
        h: Math.round(r() * 5000) / 100,
      };
      if (!Market.validateBox(box, listing, []).ok) continue;
      accepted++;
      const price = Market.priceForBox(box, listing);
      assert.ok(price >= Market.RULES.MIN_BID,
        `an accepted ${box.w}x${box.h} box priced at ${price}, under the minimum bid`);
      /* And the spot it becomes must be biddable: the floor is what
         nextMinimum answers on a spot nobody has bid on yet. */
      assert.equal(Market.nextMinimum({ id: "s", floor: price }, []), price);
    }
    assert.ok(accepted > 200, `only ${accepted} boxes out of 4000 were ever valid - the sample proves nothing`);
  });

  it("no valid box can overlap another valid box that was accepted before it", () => {
    /* Two brands cannot print on the same cloth. Played as a sequence, the
       way the server plays it: each accepted box joins the list the next one
       is checked against, and nothing that survives may intersect anything
       that came earlier. */
    const listing = { rate_per_percent: 250, front_multiplier: 1.6 };
    const r = rng(777);
    for (let seed = 0; seed < 60; seed++) {
      const placed = [];
      for (let i = 0; i < 40; i++) {
        const box = {
          n: i + 1, side: "front",
          x: Math.round(r() * 9000) / 100,
          y: Math.round(r() * 9000) / 100,
          w: Math.round(r() * 2000) / 100,
          h: Math.round(r() * 2000) / 100,
        };
        if (Market.validateBox(box, listing, placed).ok) placed.push(box);
      }
      for (let a = 0; a < placed.length; a++) {
        for (let b = a + 1; b < placed.length; b++) {
          assert.ok(!Market.boxesOverlap(placed[a], placed[b]),
            `spot ${placed[a].n} and spot ${placed[b].n} ended up on the same cloth`);
        }
      }
    }
  });
});
