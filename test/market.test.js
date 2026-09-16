"use strict";

/* =========================================================================
   Tests for public/assets/js/market.js - the proxy-bidding market engine.

   Node's built-in runner only. Run from the project root:

       node --test test/

   Tests named "BUG:" assert what the engine SHOULD do per the documented
   rules and currently FAIL. They are deliberately left failing; each one
   carries a comment explaining the defect and the observed value.
   Tests named "QUIRK:" pin down surprising-but-defensible behaviour so a
   future change to it is at least a conscious one.
   ========================================================================= */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const Market = require("../public/assets/js/market.js");
const {
  RULES, settle, nextMinimum, evaluate, commit,
  quote, campaign, countdown, closingTime, extendIfLate, money, raiseOver,
} = Market;

/* ------------------------------------------------------------------ helpers */
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);          // a fixed "now" for every test
const WINDOW = RULES.ANTI_SNIPE_MIN * MIN;          // 10 minutes in ms

const spot = (over = {}) => Object.assign({ id: "spot-1", floor: 100 }, over);
const bid = (bidder, max, at, over = {}) => Object.assign({ bidder, max, at }, over);

/* settle() returns the raw bid objects too; this trims it to what we assert on. */
const shape = s => ({ holder: s.holder, price: s.price, depth: s.depth });

/* ========================================================================= */
describe("module shape", () => {
  it("exports the documented surface", () => {
    for (const name of ["RULES", "settle", "nextMinimum", "evaluate", "commit",
      "quote", "campaign", "countdown", "closingTime", "extendIfLate",
      "money", "raiseOver"]) {
      assert.ok(name in Market, `missing export: ${name}`);
    }
  });

  it("RULES carry the documented constants", () => {
    assert.equal(RULES.MIN_RAISE, 0.15);
    assert.equal(RULES.ANTI_SNIPE_MIN, 10);
    assert.equal(RULES.MAX_BID, 1000000);
    assert.equal(RULES.MIN_BID, 1);
  });

  it("raiseOver beats a price by 15%, rounded up to a whole unit", () => {
    assert.equal(raiseOver(100), 115);          // 115 exactly
    assert.equal(raiseOver(115), 133);          // 132.25 -> 133
    assert.equal(raiseOver(200), 230);
    assert.equal(raiseOver(1000), 1150);
    assert.equal(raiseOver(1), 2);              // 1.15 -> 2
    assert.equal(raiseOver(250), 288);          // 287.5 -> 288
  });
});

/* ========================================================================= */
describe("settle - no bids", () => {
  it("prices at the floor with no holder", () => {
    assert.deepEqual(shape(settle(spot({ floor: 250 }), [])), {
      holder: null, price: 250, depth: 0,
    });
  });

  it("leader and runnerUp are null", () => {
    const s = settle(spot(), []);
    assert.equal(s.leader, null);
    assert.equal(s.runnerUp, null);
  });

  it("tolerates a null/undefined bid list", () => {
    assert.deepEqual(shape(settle(spot(), null)), { holder: null, price: 100, depth: 0 });
    assert.deepEqual(shape(settle(spot(), undefined)), { holder: null, price: 100, depth: 0 });
  });

  it("nextMinimum with no bids is the floor itself, not the floor plus a raise", () => {
    assert.equal(nextMinimum(spot({ floor: 250 }), []), 250);
    assert.equal(nextMinimum(spot({ floor: 250 }), null), 250);
  });
});

/* ========================================================================= */
describe("settle - one bidder (the core proxy-bidding property)", () => {
  it("a lone bidder pays the floor, however high their maximum", () => {
    for (const max of [100, 101, 500, 5000, RULES.MAX_BID]) {
      const s = settle(spot({ floor: 100 }), [bid("alice", max, T0)]);
      assert.equal(s.holder, "alice", `max ${max}`);
      assert.equal(s.price, 100, `a lone bidder at max ${max} must still pay the floor`);
    }
  });

  it("carries the bidder's brand and logo onto the settlement", () => {
    const s = settle(spot(), [bid("alice", 900, T0, { brand: "Acme", logo: "/a.png" })]);
    assert.equal(s.holderName, "Acme");
    assert.equal(s.holderLogo, "/a.png");
    assert.equal(s.depth, 1);
  });

  it("nextMinimum for a newcomer is a full raise over the standing price", () => {
    assert.equal(nextMinimum(spot({ floor: 100 }), [bid("alice", 5000, T0)]), 115);
  });
});

/* ========================================================================= */
describe("settle - two or more bidders", () => {
  it("the higher max wins and pays just over the runner-up's max", () => {
    const s = settle(spot(), [bid("alice", 200, T0), bid("bob", 1000, T0 + 1)]);
    assert.equal(s.holder, "bob");
    assert.equal(s.price, 230);                 // raiseOver(200)
    assert.equal(s.runnerUp.bidder, "alice");
    assert.equal(s.depth, 2);
  });

  it("the winner never pays more than their own maximum", () => {
    // raiseOver(1000) is 1150, but bob only offered 1100 - he pays 1100.
    const s = settle(spot(), [bid("alice", 1000, T0), bid("bob", 1100, T0 + 1)]);
    assert.equal(s.holder, "bob");
    assert.equal(s.price, 1100);
    assert.ok(s.price <= 1100, "price must be clamped to the leader's own max");
  });

  it("the price never drops below the floor", () => {
    const s = settle(spot({ floor: 500 }), [bid("alice", 500, T0), bid("bob", 900, T0 + 1)]);
    assert.ok(s.price >= 500);
    assert.equal(s.price, 575);                 // raiseOver(500)
  });

  it("with three bidders only the top two set the price", () => {
    const s = settle(spot(), [
      bid("carol", 150, T0),
      bid("alice", 400, T0 + 1),
      bid("bob", 1000, T0 + 2),
    ]);
    assert.equal(s.holder, "bob");
    assert.equal(s.price, 460);                 // raiseOver(400), carol is irrelevant
    assert.equal(s.depth, 3);
  });

  it("does not mutate the bid array it is handed", () => {
    const bids = [bid("alice", 200, T0), bid("bob", 1000, T0 + 1)];
    const before = JSON.stringify(bids);
    settle(spot(), bids);
    nextMinimum(spot(), bids);
    assert.equal(JSON.stringify(bids), before);
  });
});

/* ========================================================================= */
describe("settle - ties on max go to the EARLIER bid", () => {
  it("earlier bid holds when the array is already in time order", () => {
    const s = settle(spot(), [bid("alice", 500, T0), bid("bob", 500, T0 + 1000)]);
    assert.equal(s.holder, "alice");
    assert.equal(s.runnerUp.bidder, "bob");
  });

  it("earlier bid holds even when the array is in reverse time order", () => {
    const s = settle(spot(), [bid("bob", 500, T0 + 1000), bid("alice", 500, T0)]);
    assert.equal(s.holder, "alice");
  });

  it("earlier bid holds when timestamps are ISO strings", () => {
    const s = settle(spot(), [
      bid("bob", 500, new Date(T0 + 1000).toISOString()),
      bid("alice", 500, new Date(T0).toISOString()),
    ]);
    assert.equal(s.holder, "alice");
  });

  it("a tied leader pays their full max (clamped down from the raise)", () => {
    // raiseOver(500) is 575 but alice's ceiling is 500, so she pays 500.
    const s = settle(spot(), [bid("alice", 500, T0), bid("bob", 500, T0 + 1000)]);
    assert.equal(s.price, 500);
  });
});

/* ========================================================================= */
describe("settle - dead and malformed entries", () => {
  it("skips null/undefined entries in the bid array", () => {
    const s = settle(spot(), [null, undefined, bid("alice", 300, T0)]);
    assert.deepEqual(shape(s), { holder: "alice", price: 100, depth: 1 });
  });

  it("skips withdrawn bids entirely - even the top one", () => {
    const s = settle(spot(), [
      bid("whale", 9999, T0, { withdrawn: true }),
      bid("alice", 300, T0 + 1),
    ]);
    assert.equal(s.holder, "alice");
    assert.equal(s.price, 100, "a withdrawn bid must not prop the price up");
    assert.equal(s.depth, 1);
  });

  it("drops bids whose max is under the floor", () => {
    const s = settle(spot({ floor: 100 }), [bid("low", 50, T0), bid("alice", 300, T0 + 1)]);
    assert.equal(s.depth, 1);
    assert.equal(s.holder, "alice");
    assert.equal(s.price, 100, "a sub-floor bid is not a runner-up");
  });

  it("a max exactly at the floor still counts", () => {
    const s = settle(spot({ floor: 100 }), [bid("alice", 100, T0)]);
    assert.equal(s.holder, "alice");
    assert.equal(s.price, 100);
  });

  it("a spot with a missing floor falls back to RULES.MIN_BID", () => {
    assert.deepEqual(shape(settle({ id: "x" }, [])), { holder: null, price: 1, depth: 0 });
    assert.deepEqual(shape(settle({ id: "x" }, [bid("alice", 5, T0)])),
      { holder: "alice", price: 1, depth: 1 });
    assert.equal(nextMinimum({ id: "x" }, []), 1);
  });

  it("a zero or negative floor is lifted to RULES.MIN_BID", () => {
    assert.equal(settle({ id: "x", floor: 0 }, []).price, 1);
    assert.equal(settle({ id: "x", floor: -50 }, []).price, 1);
  });

  it("a floor supplied as a numeric string is honoured", () => {
    assert.equal(settle({ id: "x", floor: "250" }, []).price, 250);
  });

  it("a max supplied as a numeric string is honoured", () => {
    const s = settle(spot(), [bid("alice", "200", T0), bid("bob", "1000", T0 + 1)]);
    assert.equal(s.holder, "bob");
    assert.equal(s.price, 230);
  });
});

/* ========================================================================= */
describe("evaluate - accepting a bid", () => {
  it("a newcomer taking an uncontested spot pays the floor", () => {
    const v = evaluate(spot({ floor: 100 }), [], { bidder: "alice", brand: "Acme", max: 5000, now: T0 });
    assert.equal(v.ok, true);
    assert.equal(v.won, true);
    assert.equal(v.price, 100);
    assert.equal(v.minimum, 100);
    assert.equal(v.holder, "alice");
    assert.equal(v.outbid, null);
    assert.equal(v.pushedTo, null);
    assert.equal(v.max, 5000);
  });

  it("outbidding the holder reports who lost the spot and what they get back", () => {
    const bids = [bid("alice", 200, T0, { brand: "Acme" })];
    const v = evaluate(spot(), bids, { bidder: "bob", brand: "Bee", max: 1000, now: T0 + 1 });
    assert.equal(v.ok, true);
    assert.equal(v.won, true);
    assert.equal(v.price, 230);                       // just over alice's 200
    assert.deepEqual(v.outbid, { bidder: "alice", brand: "Acme", refund: 100 });
    assert.equal(v.pushedTo, null);
  });

  it("a bid exactly at the minimum is accepted", () => {
    const bids = [bid("alice", 5000, T0)];
    assert.equal(nextMinimum(spot(), bids), 115);
    const v = evaluate(spot(), bids, { bidder: "bob", max: 115, now: T0 + 1 });
    assert.equal(v.ok, true);
  });

  it("does not mutate the bid array or the spot", () => {
    const bids = [bid("alice", 200, T0)];
    const sp = spot({ closesAt: T0 + MIN });
    const snapBids = JSON.stringify(bids), snapSpot = JSON.stringify(sp);
    evaluate(sp, bids, { bidder: "bob", max: 1000, now: T0 });
    assert.equal(JSON.stringify(bids), snapBids);
    assert.equal(JSON.stringify(sp), snapSpot);
  });
});

/* ========================================================================= */
describe("evaluate - losing but pushing the price up", () => {
  it("a max under the leader's ceiling loses yet raises the leader's price", () => {
    const bids = [bid("alice", 200, T0)];          // alice holds at the floor, 100
    const v = evaluate(spot(), bids, { bidder: "bob", max: 150, now: T0 + 1 });
    assert.equal(v.ok, true, "the bid is legal, it just is not enough to win");
    assert.equal(v.won, false);
    assert.equal(v.holder, "alice", "alice keeps the spot");
    assert.equal(v.pushedTo, 173, "alice now pays raiseOver(150)");
    assert.equal(v.outbid, null, "nobody is refunded - nobody lost the spot");
  });

  it("pushedTo is null when you win and set when you do not", () => {
    const bids = [bid("alice", 200, T0)];
    assert.equal(evaluate(spot(), bids, { bidder: "bob", max: 1000, now: T0 + 1 }).pushedTo, null);
    assert.equal(evaluate(spot(), bids, { bidder: "bob", max: 150, now: T0 + 1 }).pushedTo, 173);
  });

  it("tying the leader's max exactly loses - the earlier bid holds", () => {
    const bids = [bid("alice", 200, T0)];
    const v = evaluate(spot(), bids, { bidder: "bob", max: 200, now: T0 + 1 });
    assert.equal(v.ok, true);
    assert.equal(v.won, false);
    assert.equal(v.holder, "alice");
    assert.equal(v.pushedTo, 200, "alice is pushed to her ceiling but keeps the spot");
  });

  it("a minimum bid against a deep proxy loses and only nudges the price", () => {
    const bids = [bid("alice", 5000, T0)];
    const v = evaluate(spot(), bids, { bidder: "bob", max: 115, now: T0 + 1 });
    assert.equal(v.won, false);
    assert.equal(v.pushedTo, 133);                 // raiseOver(115)
  });
});

/* ========================================================================= */
describe("evaluate - rejections", () => {
  it("a bid under nextMinimum is rejected with a useful reason", () => {
    const bids = [bid("alice", 5000, T0)];
    const v = evaluate(spot(), bids, { bidder: "bob", max: 114, now: T0 + 1 });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "You need at least 115 to take this spot.");
    assert.equal(v.minimum, 115, "the rejection tells you the number to beat");
    assert.equal(v.price, 100);
    assert.equal(v.holder, "alice");
    assert.ok(/115/.test(v.reason), "the reason should name the required amount");
  });

  it("an under-floor bid on an unheld spot names the floor", () => {
    const v = evaluate(spot({ floor: 250 }), [], { bidder: "bob", max: 249, now: T0 });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "The floor on this spot is 250.");
    assert.equal(v.minimum, 250);
  });

  it("a nonexistent spot is rejected", () => {
    assert.equal(evaluate(null, [], { bidder: "b", max: 500, now: T0 }).reason,
      "That spot does not exist.");
    assert.equal(evaluate({ floor: 100 }, [], { bidder: "b", max: 500, now: T0 }).reason,
      "That spot does not exist.", "a spot with no id does not exist");
  });

  it("a closed spot is rejected", () => {
    const v = evaluate(spot({ closed: true }), [], { bidder: "b", max: 500, now: T0 });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "Bidding on this listing has closed.");
  });

  it("a closed listing is rejected", () => {
    const v = evaluate(spot({ listingClosed: true }), [], { bidder: "b", max: 500, now: T0 });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "Bidding on this listing has closed.");
  });

  it("a bid at or after closesAt is rejected", () => {
    const sp = spot({ closesAt: new Date(T0).toISOString() });
    assert.equal(evaluate(sp, [], { bidder: "b", max: 500, now: T0 }).reason,
      "Bidding on this spot has closed.", "exactly at the closing instant is too late");
    assert.equal(evaluate(sp, [], { bidder: "b", max: 500, now: T0 + 1 }).reason,
      "Bidding on this spot has closed.");
    assert.equal(evaluate(sp, [], { bidder: "b", max: 500, now: T0 - 1 }).ok, true,
      "one millisecond early is still in time");
  });

  it("rejections still report the current state so the UI can redraw", () => {
    const bids = [bid("alice", 5000, T0)];
    const v = evaluate(spot({ closed: true }), bids, { bidder: "bob", max: 9999, now: T0 });
    assert.equal(v.ok, false);
    assert.equal(v.holder, "alice");
    assert.equal(v.price, 100);
    assert.equal(v.minimum, 115);
    assert.equal(v.won, undefined);
  });

  it("QUIRK: spot.closed is truthy-checked but listingClosed must be exactly true", () => {
    // `spot.closed` accepts any truthy value; `listingClosed` is compared with
    // `=== true`, so a listing flagged with 1 / "true" slips through. Pinned
    // here so the asymmetry is at least deliberate.
    assert.equal(evaluate(spot({ closed: 1 }), [], { bidder: "b", max: 500, now: T0 }).ok, false);
    assert.equal(evaluate(spot({ listingClosed: 1 }), [], { bidder: "b", max: 500, now: T0 }).ok, true);
  });
});

/* ========================================================================= */
describe("evaluate - the existing holder bidding again", () => {
  const bids = () => [bid("alice", 1000, T0)];

  it("re-bidding below their own max is rejected", () => {
    const v = evaluate(spot(), bids(), { bidder: "alice", max: 500, now: T0 + MIN });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "You already hold this spot at a higher maximum.");
  });

  it("re-bidding exactly at their own max is rejected", () => {
    const v = evaluate(spot(), bids(), { bidder: "alice", max: 1000, now: T0 + MIN });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "You already hold this spot at a higher maximum.");
  });

  it("raising their own max IS allowed (documented behaviour)", () => {
    const v = evaluate(spot(), bids(), { bidder: "alice", max: 1200, now: T0 + MIN });
    assert.equal(v.ok, true);
    assert.equal(v.won, true);
    assert.equal(v.holder, "alice");
    assert.equal(v.outbid, null, "you do not outbid yourself");
    assert.equal(v.pushedTo, null);
  });

  /* ---------------------------------------------------------------- BUG 1 */
  it("BUG: raising your own max must not raise your own price", () => {
    // Alice is the only bidder on a floor-100 spot, so she pays 100.
    // She raises her ceiling from 1000 to 1200. settle() has no idea the two
    // bids belong to the same person: it makes her OLD bid of 1000 the
    // runner-up and prices her at raiseOver(1000) = 1150.
    // She has bid against herself. Observed: 1150. Expected: 100.
    const v = evaluate(spot({ floor: 100 }), bids(), { bidder: "alice", max: 1200, now: T0 + MIN });
    assert.equal(v.price, 100,
      "BUG: an unopposed holder who raises her ceiling is charged raiseOver(her own previous max)");
  });

  it("BUG: raising by one unit must not charge the holder her entire new ceiling", () => {
    // The same defect, at its sharpest: alice nudges 1000 -> 1001 and the
    // price goes 100 -> 1001 (raiseOver(1000)=1150, clamped to her new max).
    const v = evaluate(spot({ floor: 100 }), bids(), { bidder: "alice", max: 1001, now: T0 + MIN });
    assert.equal(v.price, 100,
      "BUG: observed 1001 - the holder pays her whole new maximum with no competitor");
  });

  it("BUG: a self-raise must not inflate what a newcomer has to bid", () => {
    // Knock-on effect: after alice bids against herself, nextMinimum for a
    // genuine rival jumps from 115 to raiseOver(1150) = 1323.
    const after = commit(spot({ floor: 100 }), bids(), { bidder: "alice", max: 1200, now: T0 + MIN });
    assert.equal(nextMinimum(spot({ floor: 100 }), after.bids), 115,
      "BUG: observed 1323 - self-bidding locks rivals out of a spot nobody is contesting");
  });

  it("a genuine rival is still priced correctly after a self-raise", () => {
    // The same-bidder duplicate only matters when it is the runner-up; with a
    // real rival in between, pricing is right again.
    const s = settle(spot(), [
      bid("alice", 1000, T0), bid("alice", 2000, T0 + 1), bid("bob", 1500, T0 + 2),
    ]);
    assert.equal(s.holder, "alice");
    assert.equal(s.price, 1725);                 // raiseOver(bob's 1500)
  });
});

/* ========================================================================= */
describe("commit", () => {
  it("appends the bid and returns the new standing", () => {
    const bids = [bid("alice", 200, T0, { brand: "Acme" })];
    const r = commit(spot(), bids, { bidder: "bob", brand: "Bee", max: 1000, now: T0 + 1 });
    assert.equal(r.ok, true);
    assert.equal(r.won, true);
    assert.equal(r.holder, "bob");
    assert.equal(r.price, 230);
    assert.deepEqual(r.outbid, { bidder: "alice", brand: "Acme", refund: 100 });
    assert.equal(r.bids.length, 2);
    assert.equal(bids.length, 1, "the original array must not be mutated");
  });

  it("stamps the bid with id, timestamp and normalised max", () => {
    const r = commit(spot(), [], { bidder: "bob", brand: "Bee", max: "150", id: "fixed", now: T0 });
    assert.equal(r.bid.id, "fixed");
    assert.equal(r.bid.bidder, "bob");
    assert.equal(r.bid.brand, "Bee");
    assert.equal(r.bid.logo, null);
    assert.equal(r.bid.max, 150);
    assert.equal(r.bid.at, T0);
  });

  it("mints an id when none is supplied", () => {
    const r = commit(spot(), [], { bidder: "bob", max: 500, now: T0 });
    assert.equal(typeof r.bid.id, "string");
    assert.ok(r.bid.id.length > 0);
  });

  it("refuses an invalid bid and hands the original list straight back", () => {
    const bids = [bid("alice", 5000, T0)];
    const r = commit(spot(), bids, { bidder: "bob", max: 10, now: T0 + 1 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "You need at least 115 to take this spot.");
    assert.equal(r.bids, bids, "the caller gets the untouched list back");
  });

  it("agrees with evaluate on price and holder", () => {
    const bids = [bid("alice", 200, T0)];
    const offer = { bidder: "bob", max: 1000, now: T0 + 1 };
    const v = evaluate(spot(), bids, offer);
    const r = commit(spot(), bids, offer);
    assert.equal(r.price, v.price);
    assert.equal(r.holder, v.holder);
    assert.equal(r.won, v.won);
  });
});

/* ========================================================================= */
describe("closingTime", () => {
  it("reads closesAt as an ISO string or a number", () => {
    assert.equal(closingTime({ id: "s", closesAt: new Date(T0).toISOString() }), T0);
    assert.equal(closingTime({ id: "s", closesAt: T0 }), T0);
  });

  it("reads the snake_case closes_at too", () => {
    assert.equal(closingTime({ id: "s", closes_at: new Date(T0).toISOString() }), T0);
  });

  it("returns null when there is no usable closing time", () => {
    assert.equal(closingTime({ id: "s" }), null);
    assert.equal(closingTime({ id: "s", closesAt: "garbage" }), null);
    assert.equal(closingTime({ id: "s", closesAt: 0 }), null);
    assert.equal(closingTime(null), null);
  });
});

/* ========================================================================= */
describe("anti-snipe", () => {
  const sp = () => spot({ closesAt: new Date(T0).toISOString() });

  it("a spot with no closing time never extends", () => {
    assert.equal(extendIfLate({ id: "s" }, T0), null);
    assert.equal(evaluate(spot(), [], { bidder: "b", max: 500, now: T0 }).closesAt, null);
  });

  it("a bid outside the window leaves closesAt exactly where it was", () => {
    assert.equal(extendIfLate(sp(), T0 - 60 * MIN), T0);
    assert.equal(extendIfLate(sp(), T0 - WINDOW - 1), T0);
    const v = evaluate(sp(), [], { bidder: "b", max: 500, now: T0 - 60 * MIN });
    assert.equal(v.closesAt, T0, "an early bid must not move the clock");
  });

  it("exactly ANTI_SNIPE_MIN minutes out is still outside the window", () => {
    assert.equal(extendIfLate(sp(), T0 - WINDOW), T0, "the boundary is strict: < window, not <=");
  });

  it("a bid inside the window leaves exactly 10 minutes on the clock", () => {
    // Note the shape of the rule: the close is pushed to now + 10 minutes, so
    // there is always exactly one full window left after a late bid. It is not
    // "old close + 10 minutes".
    const late = T0 - MIN;                       // one minute before closing
    assert.equal(extendIfLate(sp(), late), late + WINDOW);
    assert.equal(extendIfLate(sp(), late) - late, WINDOW);
    assert.equal(extendIfLate(sp(), late) - T0, 9 * MIN);
  });

  it("a late bid through evaluate and commit reports the extended close", () => {
    const late = T0 - MIN;
    const v = evaluate(sp(), [], { bidder: "b", max: 500, now: late });
    assert.equal(v.ok, true);
    assert.equal(v.closesAt, late + WINDOW);
    const r = commit(sp(), [], { bidder: "b", max: 500, now: late });
    assert.equal(r.closesAt, late + WINDOW);
  });

  it("a losing bid extends the close too", () => {
    const late = T0 - MIN;
    const v = evaluate(sp(), [bid("alice", 5000, T0 - 60 * MIN)], { bidder: "bob", max: 115, now: late });
    assert.equal(v.won, false);
    assert.equal(v.closesAt, late + WINDOW, "any live bid resets the snipe clock, win or lose");
  });

  it("neither evaluate nor commit mutates the spot - the caller must persist closesAt", () => {
    const s = sp();
    const snap = JSON.stringify(s);
    commit(s, [], { bidder: "b", max: 500, now: T0 - MIN });
    assert.equal(JSON.stringify(s), snap);
    assert.equal(extendIfLate(s, T0 - MIN), T0 - MIN + WINDOW, "still computed off the ORIGINAL close");
  });

  it("repeated late bids ratchet the close forward once each is persisted", () => {
    let closesAt = closingTime(sp());
    const bid1 = T0 - MIN;
    closesAt = extendIfLate({ id: "s", closesAt }, bid1);
    assert.equal(closesAt, T0 + 9 * MIN);

    const bid2 = T0 + MIN;                       // 8 minutes before the new close
    closesAt = extendIfLate({ id: "s", closesAt }, bid2);
    assert.equal(closesAt, T0 + 11 * MIN, "each late bid buys another full window");

    // extendIfLate() on its own will happily push a close that is already in
    // the past, but evaluate() rejects such a bid before it can, so the
    // ratchet only runs while the spot is genuinely still open.
    assert.equal(extendIfLate({ id: "s", closesAt: T0 + 11 * MIN }, T0 + 30 * MIN), T0 + 40 * MIN);
    assert.equal(evaluate({ id: "s", floor: 100, closesAt: T0 + 11 * MIN }, [],
      { bidder: "b", max: 500, now: T0 + 30 * MIN }).ok, false);
  });

  it("an idle spot is never extended by repeat evaluation", () => {
    const early = T0 - 60 * MIN;
    assert.equal(extendIfLate(sp(), early), extendIfLate(sp(), early));
    assert.equal(extendIfLate(sp(), early), T0);
  });
});

/* ========================================================================= */
describe("quote", () => {
  it("returns placement, fee and total", () => {
    assert.deepEqual(quote(100, 10), { placement: 100, fee: 10, total: 110 });
  });

  it("treats a missing or unparseable fee percent as zero", () => {
    assert.deepEqual(quote(100), { placement: 100, fee: 0, total: 100 });
    assert.deepEqual(quote(100, null), { placement: 100, fee: 0, total: 100 });
    assert.deepEqual(quote(100, "nope"), { placement: 100, fee: 0, total: 100 });
  });

  it("accepts a numeric string fee percent", () => {
    assert.deepEqual(quote(100, "8.25"), { placement: 100, fee: 8.25, total: 108.25 });
  });

  it("clears 0.1 + 0.2 floating-point dust", () => {
    assert.equal(0.1 + 0.2 === 0.3, false, "sanity: JS really is that bad");
    assert.deepEqual(quote(0.1 + 0.2, 10), { placement: 0.3, fee: 0.03, total: 0.33 });
  });

  it("rounds 8.25% on 1234.56 to the cent", () => {
    // 1234.56 * 0.0825 = 101.85119999999999 -> 101.85
    assert.deepEqual(quote(1234.56, 8.25), { placement: 1234.56, fee: 101.85, total: 1336.41 });
  });

  it("rounds a fee that lands on a half-cent upward", () => {
    // 19.99 * 0.0825 = 1.6491749999999998 -> 1.65
    assert.deepEqual(quote(19.99, 8.25), { placement: 19.99, fee: 1.65, total: 21.64 });
  });

  it("money() rounds half-cents up despite binary representation", () => {
    assert.equal(money(1.005), 1.01, "1.005 * 100 is 100.49999999999999 in binary");
    assert.equal(money(2.675), 2.68);
    assert.equal(money(0.615), 0.62);
    assert.equal(money(0.1 + 0.2), 0.3);
    assert.equal(money(1.004), 1);
  });

  it("total always equals placement + fee to the cent", () => {
    for (const [amt, pct] of [[1234.56, 8.25], [19.99, 8.25], [0.1 + 0.2, 10],
      [999.995, 3], [7, 33.333], [1000000, 8.25]]) {
      const q = quote(amt, pct);
      assert.equal(q.total, money(q.placement + q.fee), `quote(${amt}, ${pct})`);
      assert.equal(Math.round(q.total * 100), Math.round(q.placement * 100) + Math.round(q.fee * 100),
        `quote(${amt}, ${pct}) must not leave sub-cent dust`);
    }
  });

  it("a zero placement quotes to zero", () => {
    assert.deepEqual(quote(0, 8.25), { placement: 0, fee: 0, total: 0 });
  });
});

/* ========================================================================= */
describe("campaign", () => {
  const spots = [
    { id: "a", floor: 100 },
    { id: "b", floor: 200 },
    { id: "c", floor: 300 },
  ];
  const held = who => ({ [who]: [bid("x", 5000, T0)] });

  it("with no bids nothing is raised and every spot is open", () => {
    const c = campaign(spots, {}, 0);
    assert.equal(c.raised, 0);
    assert.equal(c.held, 0);
    assert.equal(c.open, 3);
    assert.equal(c.total, 3);
    assert.equal(c.pct, 0);
    assert.equal(c.met, false);
  });

  it("goal defaults to the sum of the floors when it is 0, absent or negative", () => {
    assert.equal(campaign(spots, {}, 0).goal, 600);
    assert.equal(campaign(spots, {}).goal, 600);
    assert.equal(campaign(spots, {}, null).goal, 600);
    assert.equal(campaign(spots, {}, -5).goal, 600);
    assert.equal(campaign(spots, {}, "nope").goal, 600);
  });

  it("an explicit positive goal overrides the floor total", () => {
    assert.equal(campaign(spots, {}, 5000).goal, 5000);
    assert.equal(campaign(spots, {}, "5000").goal, 5000);
  });

  it("counts a held spot at its settled price, not its floor", () => {
    // two bidders on spot b: settles at raiseOver(250) = 288, not the 200 floor
    const c = campaign(spots, { b: [bid("x", 250, T0), bid("y", 900, T0 + 1)] }, 0);
    assert.equal(c.raised, 288);
    assert.equal(c.held, 1);
    assert.equal(c.open, 2);
  });

  it("splits held and open spots and totals correctly", () => {
    const c = campaign(spots, Object.assign(held("a"), held("c")), 0);
    assert.equal(c.raised, 400);                 // 100 + 300, each at its floor
    assert.equal(c.held, 2);
    assert.equal(c.open, 1);
    assert.equal(c.total, 3);
  });

  it("met is true at the exact boundary and false one unit short", () => {
    const all = Object.assign(held("a"), held("b"), held("c"));
    const exact = campaign(spots, all, 600);
    assert.equal(exact.raised, 600);
    assert.equal(exact.met, true, "raised == goal counts as met");
    assert.equal(exact.pct, 1);

    const short = campaign(spots, all, 601);
    assert.equal(short.met, false);
    assert.ok(short.pct < 1);
  });

  it("pct is clamped to 1 when the goal is beaten", () => {
    const c = campaign(spots, { a: [bid("x", 400, T0), bid("y", 5000, T0 + 1)] }, 100);
    assert.ok(c.raised > 100);
    assert.equal(c.pct, 1);
    assert.equal(c.met, true);
  });

  it("an empty or absent spot list is inert", () => {
    assert.deepEqual(campaign([], {}, 0),
      { raised: 0, goal: 0, pct: 0, met: true, held: 0, open: 0, total: 0 });
    assert.equal(campaign(undefined, undefined, 0).total, 0);
  });

  it("tolerates a missing bids-by-spot map", () => {
    assert.equal(campaign(spots, undefined, 0).open, 3);
    assert.equal(campaign(spots, {}, 0).open, 3);
  });

  /* ---------------------------------------------------------------- BUG 2 */
  it("BUG: met must agree with the raised/goal figures it publishes", () => {
    // `met` compares the raw floating-point accumulator with the raw target,
    // but `raised` and `goal` are published rounded to the cent. Two spots at
    // 1.00 and 1.14 accumulate to 2.1399999999999997, so against a goal of
    // 2.14 the report reads "raised 2.14 of 2.14" and met === false.
    const odd = [{ id: "a", floor: 1 }, { id: "b", floor: 1.14 }];
    const c = campaign(odd, Object.assign(held("a"), held("b")), 2.14);
    assert.equal(c.raised, 2.14);
    assert.equal(c.goal, 2.14);
    assert.equal(c.met, true,
      "BUG: observed met === false while the published raised equals the published goal");
  });

  it("QUIRK: the implied goal uses the raw floor, so a floorless spot counts for nothing", () => {
    // settle() lifts a missing floor to RULES.MIN_BID (1) but campaign() adds
    // the raw `spot.floor` to the implied target, so this spot raises 1
    // against an implied goal of 0.
    const c = campaign([{ id: "z" }], { z: [bid("x", 50, T0)] }, 0);
    assert.equal(c.raised, 1);
    assert.equal(c.goal, 0);
    assert.equal(c.pct, 0, "a zero target reports 0%, not 100%");
    assert.equal(c.held, 1);
  });
});

/* ========================================================================= */
describe("countdown", () => {
  it("renders days and hours", () => {
    assert.equal(countdown(T0 + 2 * 86400000 + 4 * 3600000 + 30 * MIN, T0), "2d 04h");
    assert.equal(countdown(T0 + 86400000, T0), "1d 00h", "hours are zero padded");
    assert.equal(countdown(T0 + 9 * 86400000 + 23 * 3600000, T0), "9d 23h");
  });

  it("renders hours and minutes under a day", () => {
    assert.equal(countdown(T0 + 3 * 3600000 + 12 * MIN + 9000, T0), "3h 12m");
    assert.equal(countdown(T0 + 3600000, T0), "1h 00m");
    assert.equal(countdown(T0 + 23 * 3600000 + 59 * MIN, T0), "23h 59m");
  });

  it("renders minutes and seconds under an hour", () => {
    assert.equal(countdown(T0 + 5 * MIN + 3000, T0), "5m 03s", "seconds are zero padded");
    assert.equal(countdown(T0 + 59 * MIN + 59000, T0), "59m 59s");
    assert.equal(countdown(T0 + MIN, T0), "1m 00s");
  });

  it("renders bare seconds in the last minute", () => {
    assert.equal(countdown(T0 + 48000, T0), "48s");
    assert.equal(countdown(T0 + 59999, T0), "59s");
    assert.equal(countdown(T0 + 1, T0), "0s");
  });

  it("says closed at and after the deadline", () => {
    assert.equal(countdown(T0, T0), "closed");
    assert.equal(countdown(T0 - 1, T0), "closed");
    assert.equal(countdown(T0 - 86400000, T0), "closed");
  });

  it("renders an em dash for an unusable deadline", () => {
    assert.equal(countdown(null, T0), "—");
    assert.equal(countdown(undefined, T0), "—");
    assert.equal(countdown("not a date", T0), "—");
  });

  it("accepts an ISO string deadline", () => {
    assert.equal(countdown(new Date(T0 + 3600000).toISOString(), T0), "1h 00m");
  });

  it("QUIRK: `now` is not run through the date parser the way `until` is", () => {
    // countdown() does `ts(until) - (now || Date.now())`. A Date object
    // coerces to a number, but an ISO string does not, so the same value that
    // works for `until` yields "—" when passed as `now`.
    assert.equal(countdown(T0 + 3600000, new Date(T0)), "1h 00m");
    assert.equal(countdown(T0 + 3600000, new Date(T0).toISOString()), "—");
  });
});

/* ========================================================================= */
describe("adversarial input", () => {
  const sp = spot({ floor: 100 });

  it("a negative max is rejected against the floor", () => {
    const v = evaluate(sp, [], { bidder: "b", max: -500, now: T0 });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "The floor on this spot is 100.");
  });

  it("NaN is rejected", () => {
    assert.equal(evaluate(sp, [], { bidder: "b", max: NaN, now: T0 }).reason, "Enter an amount.");
    assert.equal(evaluate(sp, [], { bidder: "b", max: "abc", now: T0 }).reason, "Enter an amount.");
    assert.equal(evaluate(sp, [], { bidder: "b", now: T0 }).reason, "Enter an amount.");
  });

  it("Infinity is rejected", () => {
    assert.equal(evaluate(sp, [], { bidder: "b", max: Infinity, now: T0 }).ok, false);
    assert.equal(evaluate(sp, [], { bidder: "b", max: -Infinity, now: T0 }).ok, false);
  });

  it("a max over RULES.MAX_BID is rejected, exactly MAX_BID is not", () => {
    assert.equal(evaluate(sp, [], { bidder: "b", max: RULES.MAX_BID + 1, now: T0 }).reason,
      "That is over the maximum bid.");
    assert.equal(evaluate(sp, [], { bidder: "b", max: RULES.MAX_BID, now: T0 }).ok, true);
  });

  it("an empty string, null or zero max falls through to the floor check", () => {
    assert.equal(evaluate(sp, [], { bidder: "b", max: "", now: T0 }).ok, false);
    assert.equal(evaluate(sp, [], { bidder: "b", max: null, now: T0 }).ok, false);
    assert.equal(evaluate(sp, [], { bidder: "b", max: 0, now: T0 }).ok, false);
  });

  it("a numeric string max is accepted and normalised", () => {
    const v = evaluate(sp, [], { bidder: "b", max: "500", now: T0 });
    assert.equal(v.ok, true);
    assert.equal(v.max, 500);
    assert.equal(typeof v.max, "number");
  });

  it("a bid list full of junk still settles", () => {
    const junk = [null, undefined, false, 0, "",
      bid("gone", 9999, T0, { withdrawn: true }),
      bid("low", 1, T0 + 1),
      bid("alice", 400, T0 + 2)];
    const s = settle(sp, junk);
    assert.equal(s.holder, "alice");
    assert.equal(s.price, 100);
    assert.equal(s.depth, 1);
    assert.equal(nextMinimum(sp, junk), 115);
  });

  it("evaluate survives being called with no offer at all", () => {
    const v = evaluate(sp, [], undefined);
    assert.equal(v.ok, false);
    assert.equal(v.reason, "Enter an amount.");
  });

  it("evaluate survives a spot with a missing floor", () => {
    const v = evaluate({ id: "x" }, [], { bidder: "b", max: 5, now: T0 });
    assert.equal(v.ok, true);
    assert.equal(v.price, 1, "the floor falls back to RULES.MIN_BID");
    assert.equal(v.minimum, 1);
  });

  it("a bid below RULES.MIN_BID on a floorless spot is rejected", () => {
    const v = evaluate({ id: "x" }, [], { bidder: "b", max: 0.5, now: T0 });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "The floor on this spot is 1.");
  });

  it("a max above MAX_BID sitting in the stored bid list is not re-validated", () => {
    // settle() trusts what is already persisted; only evaluate() gates new
    // bids. Pinned so the division of labour stays explicit.
    const s = settle(sp, [bid("whale", RULES.MAX_BID * 10, T0)]);
    assert.equal(s.holder, "whale");
    assert.equal(s.price, 100);
  });
});
