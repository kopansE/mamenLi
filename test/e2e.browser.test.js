"use strict";

/* =========================================================================
   End-to-end, in a real Chrome, against the real server.

   Everything runs in DEMO mode: the server is started with a scrubbed
   environment, so /api/config reports nothing configured and store.js keeps
   the whole market in the browser's own localStorage. That is deliberate.
   It is the mode a fresh clone runs in, it needs no keys and no network, and
   it exercises the same rendering, the same escaping and the same engine the
   live mode does.

   Five things about this file are load-bearing.

     * The viewport comes from Emulation.setDeviceMetricsOverride, never from
       --window-size, which this machine's display scaling distorts.
     * `.rv` sections start at opacity:0 until an IntersectionObserver fires.
       Probes force `.shown` so nothing is measured or read while it is
       mid-reveal.
     * Every test gets a fresh tab with localStorage cleared, so no test can
       inherit another's account or bids.
     * `/` is a front door now, not a listing. `open()` walks through it -
       the brand's door, then the first publisher in the directory - so the
       tests that want a garment in front of them still get one. Nothing may
       wait on `.srow` before that walk has happened.
     * Counts, floors and settled prices are READ BACK out of `window.Store`
       and recomputed with the shared engine, never typed in. The demo seed
       has already changed shape once and took ten hardcoded tests with it;
       the next change to it must not.

   If Chrome is not installed the whole suite skips rather than fails.
   ========================================================================= */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { Browser, findChrome } = require("./helpers/cdp.js");
const { startServer } = require("./helpers/server.js");
const Market = require("../public/assets/js/market.js");

const PORT = 8792;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const CHROME = findChrome();
const SUITE_OPTS = CHROME ? {} : {
  skip: "Chrome was not found - set SQUAREINCH_CHROME to its path, or leave this suite skipped",
};

/* The five screens, in the order they appear in the markup. */
const SCREENS = ["home", "browse", "campaign", "auth", "studio"];

/* The app has booted when Store is up and it has chosen a screen to show.
   This has to be screen-agnostic: `/` lands on the front door, which has no
   spot list on it, so waiting for `.srow` here would hang there for ever. */
const BOOTED =
  `!!(window.Store && ${JSON.stringify(SCREENS)}.some(s => !document.getElementById("screen-" + s).hidden))`;

/* Which screen is up. The app hides every <main> but one, so this is a
   one-element list, and asserting on the whole list catches a second screen
   being left open as well as the wrong one being shown. */
const VISIBLE = `${JSON.stringify(SCREENS)}.filter(s => !document.getElementById("screen-" + s).hidden)`;

/* The two waits the walk from the front door to a listing needs. */
const BROWSE_READY =
  '!!(!document.getElementById("screen-browse").hidden && document.querySelector("#browse-grid .lot"))';
const CAMPAIGN_READY =
  '!!(!document.getElementById("screen-campaign").hidden && document.querySelectorAll(".srow").length)';
/* A campaign with no spots sold on it yet has no `.srow` to wait for. What it
   does have, once the publisher has put both photographs up and opened, is a
   live "Draw an area" toggle - which is the only door a brand has in. */
const CAN_DRAW =
  '!!(!document.getElementById("screen-campaign").hidden && !document.getElementById("draw-toggle").hidden)';

/* Forces the scroll-reveal sections visible before anything is measured. */
const REVEAL = 'document.querySelectorAll(".rv").forEach(e => e.classList.add("shown"));';

/* The listing the campaign screen is actually showing, plus its spots and
   its bids, dug back out of the store. Every expected number below is
   derived from these three with the SHARED engine rather than typed in - a
   second implementation written in the test would only ever be testing
   itself, and a hardcoded figure only ever tests the seed. */
const ON_SCREEN = `
  const who = document.getElementById("hero-who").textContent.trim();
  const __all = await window.Store.listings.list({ openOnly: false });
  const __L = __all.find(l => l.names === who);
  if (!__L) return { error: 'no listing named "' + who + '" is on screen' };
  const __spots = await window.Store.spots.list(__L.id);
  const __bids = await window.Store.bids.list(__L.id);
`;

/* Drawing is ARMED, not always live. A panel only takes a drag after the
   brand has asked for one, and every release disarms it again - so this runs
   before every single box below, not once per tab. It is also the honest
   place the app says no: the toggle hides itself and `#draw-hint` carries the
   reason when a listing cannot be drawn on at all. */
const ARM = `
  const toggle = document.getElementById("draw-toggle");
  if (toggle.hidden) return { error: "the draw toggle is hidden: " + document.getElementById("draw-hint").textContent };
  if (toggle.getAttribute("aria-pressed") !== "true") toggle.click();
  await new Promise(armed => setTimeout(armed, 250));
`;

/* A real drag across a garment panel: pointerdown, two moves and an up,
   dispatched as bubbling PointerEvents, which is exactly what wireDrawing()
   listens for. The coordinates are FRACTIONS of the panel's own box, so the
   percentages that come out the other side are those fractions times a
   hundred whatever size the photograph happens to be rendered at.

   The draft rectangle is read BEFORE the pointerup, because releasing
   destroys it - and that read is the live quote following the hand, which is
   the part worth protecting. */
const DRAG = (sel, x1, y1, x2, y2) => `
  const pane = document.querySelector(${JSON.stringify(sel)});
  if (!pane) return { error: "no garment panel matched " + ${JSON.stringify(sel)} };
  const r = pane.getBoundingClientRect();
  const at = (fx, fy) => ({ clientX: r.left + r.width * fx, clientY: r.top + r.height * fy,
                            bubbles: true, cancelable: true, pointerId: 1, isPrimary: true });
  pane.dispatchEvent(new PointerEvent("pointerdown", at(${x1}, ${y1})));
  pane.dispatchEvent(new PointerEvent("pointermove",  at(${(x1 + x2) / 2}, ${(y1 + y2) / 2})));
  pane.dispatchEvent(new PointerEvent("pointermove",  at(${x2}, ${y2})));
  const draft = pane.querySelector(".spot-draft");
  const live = draft && {
    side: pane.dataset.side,
    label: draft.querySelector("span").textContent,
    x: parseFloat(draft.style.left),  y: parseFloat(draft.style.top),
    w: parseFloat(draft.style.width), h: parseFloat(draft.style.height),
  };
  pane.dispatchEvent(new PointerEvent("pointerup", at(${x2}, ${y2})));
  await new Promise(done => setTimeout(done, 450));
  return live || { error: "nothing was drawn - the panel was not armed for drawing" };
`;
const FRONT_PANEL = '#garment-wrap .garment[data-side="front"]';
const BACK_PANEL = '#garment-wrap .garment[data-side="back"]';

/* Money as the page prints it - "$1,696" - back to a number. */
const n = s => Number(String(s).replace(/[^0-9.]/g, ""));

const XSS = `<img src=x onerror="window.__pwned=1">`;

describe("the page in a real browser", SUITE_OPTS, () => {
  let srv = null, browser = null;
  const openPages = [];

  before(async () => {
    srv = await startServer({ port: PORT });
    browser = await Browser.launch();
  });

  after(async () => {
    for (const p of openPages) await p.close().catch(() => {});
    if (browser) await browser.close();
    if (srv) await srv.stop();
  });

  /**
   * A fresh tab, with this origin's localStorage wiped, on a booted page.
   *
   * `/` is the front door, so by default this walks it - the brand's door
   * through to the directory, then the first publisher's card - and leaves
   * the tab on a campaign, which is what nearly everything below wants to be
   * looking at. `screen: "home"` and `screen: "browse"` stop short of that,
   * and a query string that already names a listing is left to route itself.
   */
  async function open({ width = 1280, height = 900, query = "", screen = "campaign" } = {}) {
    const page = await browser.newPage({ width, height });
    openPages.push(page);
    await page.clearStorage(ORIGIN);
    await page.goto(ORIGIN + "/" + query, { ready: BOOTED });
    if (screen === "browse") await intoDirectory(page);
    else if (screen === "campaign" && !/[?&]l=/.test(query)) await intoFirstListing(page);
    await page.evaluate(REVEAL + " return true;");
    return page;
  }

  /** Through a door and into the directory, waiting for it to fill in. */
  async function intoDirectory(page, via = "door-brand") {
    await page.evaluate(`document.getElementById(${JSON.stringify(via)}).click(); return true;`);
    await page.waitFor(BROWSE_READY, 8000, "the directory to fill in");
  }

  /** …and on into the first publisher listed there. */
  async function intoFirstListing(page, via) {
    await intoDirectory(page, via);
    await page.evaluate(`document.querySelector("#browse-grid .lot").click(); return true;`);
    await page.waitFor(CAMPAIGN_READY, 8000, "the first publisher's garment to draw");
  }

  /* Sign up, on whichever screen we are already on. */
  const SIGN_UP = (role, { name, brand, email }) => `
    window.confirm = () => true;
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    if (${JSON.stringify(role)} === "client") document.getElementById("role-client").click();
    else document.getElementById("role-brand").click();
    set("au-name", ${JSON.stringify(name)});
    set("au-brand", ${JSON.stringify(brand || "")});
    set("au-email", ${JSON.stringify(email)});
    set("au-pw", "hunter2hunter2");
    document.getElementById("auth-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 900));
    return window.Store.auth.current();
  `;

  /* Sign back IN as somebody who already has an account. The header's own
     button is the only thing that puts the form in sign-in mode, so it is
     what this uses - a sign-up submit with an existing email is refused. */
  const SIGN_IN = email => `
    window.confirm = () => true;
    await window.Store.auth.signOut();
    await new Promise(r => setTimeout(r, 250));
    document.getElementById("nav-in").click();
    await new Promise(r => setTimeout(r, 350));
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("au-email", ${JSON.stringify(email)});
    set("au-pw", "hunter2hunter2");
    document.getElementById("auth-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 1400));
    return window.Store.auth.current();
  `;

  /* ==================================================================== */
  describe("it loads", () => {
    for (const [label, width, height] of [["a phone", 390, 844], ["a desktop", 1280, 900]]) {
      it(`has no console errors on ${label} (${width}px)`, async () => {
        const page = await open({ width, height });
        /* Let the 1s ticker run at least once - a throwing interval is the
           classic error that only shows up a second after load. */
        await page.evaluate("await new Promise(r => setTimeout(r, 1300)); return true;");
        const errors = page.errors();
        assert.deepEqual(errors, [], `console errors on ${label}:\n${page.consoleText()}`);
      });

      it(`has no horizontal overflow on ${label} (${width}px)`, async () => {
        const page = await open({ width, height });
        const m = await page.evaluate(`
          ${REVEAL}
          const de = document.documentElement;
          const over = [];
          for (const el of document.querySelectorAll("body *")) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || getComputedStyle(el).position === "fixed") continue;
            if (r.right > de.clientWidth + 2 || r.left < -2) {
              over.push((el.tagName + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).join(".") : "")).slice(0, 90)
                + " [" + Math.round(r.left) + " -> " + Math.round(r.right) + "]");
            }
            if (over.length > 6) break;
          }
          return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, innerWidth: window.innerWidth, over };
        `);
        assert.equal(m.innerWidth, width, "the viewport override did not take effect");
        assert.ok(m.scrollWidth <= m.clientWidth + 1,
          `the page scrolls sideways at ${width}px (${m.scrollWidth} > ${m.clientWidth}). ` +
          `Widest offenders:\n  ${m.over.join("\n  ")}`);
      });
    }

    it("says it is in demo mode, because nothing is configured", async () => {
      /* The footer carries this on every screen, so the front door will do. */
      const page = await open({ screen: "home" });
      assert.equal(await page.evaluate("window.Store.mode"), "demo");
      assert.match(await page.evaluate('document.getElementById("foot-mode").textContent'), /demo mode/i);
    });

    it("draws the seeded market: every spot, what it has raised, and a closing clock", async () => {
      const page = await open();
      const m = await page.evaluate(`
        ${REVEAL}
        ${ON_SCREEN}
        /* The seed is whatever the seed is. Read it back and compare the page
           against it, rather than against a spot count typed in here - that is
           what turned one change to seed() into ten red tests. */
        const approved = __spots.filter(s => s.approved !== false);
        const c = window.Store.campaign(approved, window.Store.bids.bySpot(__bids), __L.goal);
        return {
          seeded: approved.length,
          raisedShould: c.raised, openShould: c.open,
          rows: document.querySelectorAll(".srow").length,
          marks: document.querySelectorAll("#garment-wrap .spot").length,
          raised: document.getElementById("goal-raised").textContent,
          open: Number(document.getElementById("goal-open").textContent),
          total: Number(document.getElementById("goal-total").textContent),
          clock: document.getElementById("goal-clock").textContent,
        };
      `);

      assert.ok(!m.error, m.error);
      assert.ok(m.seeded >= 2, `the seed put only ${m.seeded} spots on this listing`);
      assert.equal(m.rows, m.seeded, `${m.seeded} spots are stored but ${m.rows} were listed`);
      assert.equal(m.marks, m.seeded, `${m.seeded} spots are stored but ${m.marks} were drawn on the garment`);
      assert.equal(m.total, m.rows);

      /* Every seeded spot arrives already held by a brand, so a raised figure
         of zero here means the bids were seeded and then never read - which is
         exactly what a page looks like when `bySpot` is keyed on the wrong
         column. */
      assert.equal(n(m.raised), m.raisedShould, `the bar reads ${m.raised}, not the ${m.raisedShould} that is committed`);
      assert.ok(n(m.raised) > 0, "the seeded market shows nothing raised at all");
      assert.equal(m.open, m.openShould);

      assert.match(m.clock, /\d/, "the countdown never rendered");
      assert.notEqual(m.clock, "closed");
    });

    it("the front/back toggle collapses once both panels fit", async () => {
      const phone = await open({ width: 390, height: 844 });
      assert.equal(await phone.evaluate('document.getElementById("side-toggle").hidden'), false);
      assert.equal(await phone.evaluate('document.querySelectorAll("#garment-wrap .garment").length'), 1);

      const desk = await open({ width: 1280, height: 900 });
      assert.equal(await desk.evaluate('document.getElementById("side-toggle").hidden'), true,
        "with both panels side by side the toggle has nothing left to toggle");
      assert.equal(await desk.evaluate('document.querySelectorAll("#garment-wrap .garment").length'), 2);
    });
  });

  /* ==================================================================== */
  describe("the front door and the directory", () => {
    it("the door asks which side of the table you are on, and picks nobody for you", async () => {
      const page = await open({ screen: "home" });
      const m = await page.evaluate(`
        ${REVEAL}
        await new Promise(r => setTimeout(r, 600));
        const seeded = await window.Store.listings.list({ openOnly: true });
        return {
          screen: ${VISIBLE},
          doors: [...document.querySelectorAll(".doors .door")].map(d => d.id),
          featured: document.querySelectorAll("#home-featured .lot").length,
          seeded: seeded.length,
          names: seeded.map(l => l.names),
          rows: document.querySelectorAll(".srow").length,
          who: document.getElementById("hero-who").textContent.trim(),
        };
      `);

      assert.deepEqual(m.screen, ["home"], "a visitor with no listing in the URL should land on the front door");
      assert.deepEqual(m.doors, ["door-brand", "door-publisher"],
        "both sides of the market have to be offered, or one of them has no way in");

      /* The old front page opened whichever listing happened to be first,
         which quietly picked a publisher on the visitor's behalf and made the
         others invisible. Nothing may be loaded until somebody chooses. */
      assert.equal(m.rows, 0, "the front door loaded a listing on its own");
      assert.ok(!m.names.some(name => m.who.includes(name)),
        `the campaign screen was filled in behind the door, with "${m.who}"`);

      /* It still has to show that there is something here, though. The door
         advertises three of them however many are open - it is a shop window,
         not the directory. */
      assert.ok(m.seeded >= 3, `only ${m.seeded} listings are open, so the door has nothing to choose between`);
      assert.equal(m.featured, 3, `the door advertised ${m.featured} publishers, not the three it has room for`);
      assert.deepEqual(page.errors(), [], `console errors on the front door:\n${page.consoleText()}`);
    });

    it("the directory lists every publisher, and a chip narrows it", async () => {
      const page = await open({ screen: "browse" });

      const names = `[...document.querySelectorAll("#browse-grid .lot h3")].map(h => h.textContent.trim()).sort()`;
      const all = await page.evaluate(`
        ${REVEAL}
        /* What the seed actually holds, cut the three ways the chips cut it.
           A chip is only right or wrong relative to the market behind it. */
        const seeded = await window.Store.listings.list({ openOnly: true });
        const wears = l => l.wears || (l.garment === "suit" ? "male" : "female");
        return { screen: ${VISIBLE}, names: ${names},
                 count: document.getElementById("browse-count").textContent,
                 seeded: {
                   all: seeded.map(l => l.names).sort(),
                   suit: seeded.filter(l => l.garment === "suit").map(l => l.names).sort(),
                   female: seeded.filter(l => wears(l) === "female").map(l => l.names).sort(),
                 } };
      `);
      assert.deepEqual(all.screen, ["browse"]);
      assert.ok(all.seeded.all.length >= 3, "the seed is too small for this test to prove anything");
      assert.deepEqual(all.names, all.seeded.all,
        "the whole seeded market should be on the directory, not just the first of it");
      assert.equal(all.count, `${all.seeded.all.length} of ${all.seeded.all.length}`,
        `the count reads "${all.count}"`);

      /* A chip that filters the grid but not the count, or the other way
         round, is worse than one that does nothing: it misreports the market.
         Both are read back on every facet below. */
      const chip = facet => page.evaluate(`
        const b = document.querySelector('[data-filter="${facet}"]');
        b.click();
        await new Promise(r => setTimeout(r, 400));
        return { names: ${names},
                 count: document.getElementById("browse-count").textContent,
                 pressed: b.getAttribute("aria-pressed") };
      `);

      const suits = await chip("suit");
      assert.ok(all.seeded.suit.length, "no suit is seeded, so the suit chip cannot be tested");
      assert.deepEqual(suits.names, all.seeded.suit, "the suit chip is not showing the suits");
      assert.equal(suits.count, `${all.seeded.suit.length} of ${all.seeded.all.length}`);
      assert.equal(suits.pressed, "true", "the chip that is filtering does not say so");

      /* Not the same cut as the garment: this facet is who is WEARING it, off
         the `wears` column, not what it is. They happen to agree on today's
         seed - every gown on it is a woman's and every suit a man's - so the
         expectation is derived rather than written down, and the day somebody
         seeds a women's suit this follows it instead of failing. */
      const women = await chip("female");
      assert.deepEqual(women.names, all.seeded.female,
        "women's should be everyone whose `wears` says so, whatever they are wearing");
      assert.equal(women.count, `${all.seeded.female.length} of ${all.seeded.all.length}`);

      const back = await chip("all");
      assert.deepEqual(back.names, all.seeded.all, "the filter did not come off again");
      assert.deepEqual(page.errors(), [], `console errors in the directory:\n${page.consoleText()}`);
    });

    it("opening a card opens that publisher, not the first one on the page", async () => {
      const page = await open({ screen: "browse" });

      /* Somebody who is demonstrably not first in the directory. */
      const target = await page.evaluate(`
        const seeded = await window.Store.listings.list({ openOnly: true });
        const pick = seeded[seeded.length - 1];
        const spots = (await window.Store.spots.list(pick.id)).filter(s => s.approved !== false);
        return { names: pick.names, city: pick.city, spots: spots.length, first: seeded[0].names };
      `);
      assert.notEqual(target.names, target.first, "the seed has only one listing in it");

      const m = await page.evaluate(`
        const lot = [...document.querySelectorAll("#browse-grid .lot")]
          .find(b => b.querySelector("h3").textContent.trim() === ${JSON.stringify(target.names)});
        if (!lot) return { error: ${JSON.stringify(target.names)} + " has no card in the directory" };
        lot.click();
        await new Promise(r => setTimeout(r, 900));
        ${REVEAL}
        return {
          screen: ${VISIBLE},
          who: document.getElementById("hero-who").textContent.trim(),
          where: document.getElementById("hero-where").textContent,
          rows: document.querySelectorAll(".srow").length,
          total: Number(document.getElementById("goal-total").textContent),
        };
      `);

      assert.ok(!m.error, m.error);
      assert.deepEqual(m.screen, ["campaign"], "a card in the directory did not open a campaign");
      assert.equal(m.who, target.names,
        `the last card opened "${m.who}" - every card is wired to the same handler, so one of them ` +
        "carrying the wrong id would be invisible until a buyer bid on the wrong garment");
      assert.match(m.where, new RegExp(target.city), "the hero is showing somebody else's city");
      assert.equal(m.rows, target.spots, `${target.spots} spots are stored for this publisher, ${m.rows} were listed`);
      assert.equal(m.total, m.rows);
    });

    it("the signed-out header sends a brand to the market and a publisher to an account", async () => {
      const page = await open({ screen: "home" });

      /* "Get a spot" used to open an empty sign-up form, which asked someone
         to commit before they had seen anything. It shows them the market. */
      const get = await page.evaluate(`
        document.getElementById("nav-get").click();
        await new Promise(r => setTimeout(r, 500));
        return ${VISIBLE};
      `);
      assert.deepEqual(get, ["browse"], "'Get a spot' should show a brand what there is to buy");

      const publish = await page.evaluate(`
        document.getElementById("nav-publish").click();
        await new Promise(r => setTimeout(r, 400));
        return { screen: ${VISIBLE},
                 publisherPressed: document.getElementById("role-client").getAttribute("aria-pressed"),
                 label: document.getElementById("role-client").textContent.trim(),
                 brandFieldShown: !document.getElementById("au-brand-fld").hidden };
      `);
      assert.deepEqual(publish.screen, ["auth"], "a signed-out publisher needs an account before a studio");
      assert.equal(publish.publisherPressed, "true",
        "the publisher's door has to arrive with the publishing side already chosen - the side cannot " +
        "be changed after the account exists");
      assert.equal(publish.label, "I'm the one wearing it");
      assert.equal(publish.brandFieldShown, false, "a publisher is not asked for a brand name");

      /* Sign in is the other button, and it is a different thing again: no
         role to pick, because the account already has one. */
      const signIn = await page.evaluate(`
        document.getElementById("nav-in").click();
        await new Promise(r => setTimeout(r, 400));
        return { screen: ${VISIBLE},
                 cta: document.getElementById("auth-go").textContent.trim(),
                 roleHidden: document.getElementById("role-toggle").hidden };
      `);
      assert.deepEqual(signIn.screen, ["auth"]);
      assert.equal(signIn.cta, "Sign in", `the form still offers to "${signIn.cta}"`);
      assert.equal(signIn.roleHidden, true, "signing in must not offer to change which side you are on");
    });

    /* ------------------------------------------------------------ the showcase
       The front door has to answer "what is this?" before anybody reads a word,
       and the only answer that works is a photograph of a person with somebody
       else's logo printed on them. */
    it("shows a front and a back of the same person with sponsors on the cloth, men first", async () => {
      const page = await open({ screen: "home" });
      const m = await page.evaluate(`
        await new Promise(r => setTimeout(r, 700));
        /* Every slide is in the DOM at once - the track is shifted sideways
           rather than rebuilt - so "what is on screen" is the first SLIDE,
           not the first image on the page. */
        const slide = document.querySelector(".slide");
        const shots = [...slide.querySelectorAll(".garment-photo")];
        return {
          men: document.getElementById("show-male").getAttribute("aria-pressed"),
          women: document.getElementById("show-female").getAttribute("aria-pressed"),
          srcs: shots.map(i => i.getAttribute("src")),
          complete: shots.map(i => i.complete && i.naturalWidth > 0),
          marks: [...slide.querySelectorAll(".mark img")].map(i => i.getAttribute("alt")),
          logos: [...slide.querySelectorAll(".mark img")].map(i => i.getAttribute("src")),
          caption: document.getElementById("show-caption").textContent,
          dots: document.querySelectorAll("#show-dots [data-show]").length,
        };
      `);

      assert.equal(m.men, "true", "the men's tab is the default and was not selected");
      assert.equal(m.women, "false");
      assert.equal(m.srcs.length, 2, "the showcase is a PAIR - one person, front and back");

      /* Both halves must be the same person. A front of one and a back of
         another is the one mistake this component can make that nobody
         notices in review and everybody notices on the page. */
      const who = m.srcs.map(s => (s.match(/\/(p\d)-/) || [])[1]);
      assert.equal(who[0], who[1], `the pair shows ${who[0]} and ${who[1]}, which are two different people`);
      assert.match(m.srcs[0], /-front\.jpg$/);
      assert.match(m.srcs[1], /-back\.jpg$/);

      /* The photographs have to have actually loaded. A broken path here is a
         front door with two empty rectangles on it. */
      assert.deepEqual(m.complete, [true, true], "a showcase photograph did not load");

      assert.equal(m.marks.length, 2, "the point of the picture is the logo on the cloth");
      assert.ok(m.marks.every(t => t && t.trim().length),
        "a sponsor patch rendered with no alt text, so it is invisible to a screen reader");
      for (const src of m.logos) {
        assert.ok(src.startsWith("/assets/logos/"), `a patch is loading artwork from ${src}`);
      }
      assert.match(m.caption, /·/, "the caption should name who this is and where");
      assert.ok(m.dots >= 2, "there is more than one man to show, so there should be dots");

      assert.deepEqual(page.errors(), [], page.consoleText());
    });

    it("moves on by itself, and the women's tab shows women", async () => {
      const page = await open({ screen: "home" });
      const m = await page.evaluate(`
        const track = document.getElementById("show-track");
        await new Promise(r => setTimeout(r, 700));
        const first = track.style.transform;

        /* Wait out the real interval rather than reaching in and calling the
           advance directly - the thing under test is that it happens without
           being asked. */
        await new Promise(r => setTimeout(r, 4800));
        const second = track.style.transform;

        document.getElementById("show-female").click();
        await new Promise(r => setTimeout(r, 400));
        const women = [...document.querySelectorAll(".slide .garment-photo")]
          .map(i => i.getAttribute("src"));
        return { first, second, women,
                 pressed: document.getElementById("show-female").getAttribute("aria-pressed") };
      `);

      assert.notEqual(m.second, m.first,
        `the showcase never advanced on its own - the track stayed at ${m.first}`);
      assert.equal(m.pressed, "true");

      /* p1-p3 are the women in the set and p4-p5 the men. Switching tabs has to
         actually change who is on screen, not just which button looks pressed. */
      for (const src of m.women) {
        assert.match(src, /\/p[123]-/, `the women's tab is showing ${src}`);
      }
      assert.deepEqual(page.errors(), [], page.consoleText());
    });

    /* ------------------------------------------------------- a slow boot
       Twice now this page has been reported as "blank". Both times the cause
       was the same: every screen ships hidden and boot decides which to show,
       so anything that stalls boot - a sleeping free-tier dyno takes the better
       part of a minute to wake - renders a header, a footer, and nothing at
       all in between, with no error a reader can see. */
    it("still shows the front door when the config request never answers", async () => {
      const page = await browser.newPage({ width: 1280, height: 900 });
      openPages.push(page);
      await page.clearStorage(ORIGIN);
      await page.send("Network.setBlockedURLs", { urls: ["*/api/config"] });
      await page.send("Page.navigate", { url: ORIGIN + "/" });
      await new Promise(r => setTimeout(r, 4000));

      const m = await page.evaluate(`
        const home = document.getElementById("screen-home");
        return {
          homeVisible: !home.hidden,
          headline: (document.querySelector("#screen-home h1") || {}).textContent || "",
          doors: document.querySelectorAll(".door").length,
          photos: document.querySelectorAll(".slide .garment-photo").length,
        };
      `);

      assert.ok(m.homeVisible, "the front door was hidden, so the page rendered as blank");
      assert.match(m.headline, /\S/, "there was no headline on screen");
      assert.equal(m.doors, 2, "neither door was reachable");
      assert.ok(m.photos >= 2,
        "the showcase is drawn from constants, not the network, so it must survive this");
    });
  });

  /* ==================================================================== */
  describe("signing in to bid", () => {
    it("a signed-out tap on a spot row routes to the auth screen", async () => {
      const page = await open({ width: 390, height: 844 });
      const m = await page.evaluate(`
        ${REVEAL}
        document.querySelector(".srow").click();
        await new Promise(r => setTimeout(r, 200));
        return {
          screen: ${VISIBLE},
          brandFieldShown: !document.getElementById("au-brand-fld").hidden,
          sheetHidden: document.getElementById("scrim").hidden,
        };
      `);
      assert.deepEqual(m.screen, ["auth"], "a spot row did not route a signed-out visitor to the account screen");
      assert.equal(m.brandFieldShown, true, "it should land on the buying side, with the brand field showing");
      assert.equal(m.sheetHidden, true, "no bid sheet should be up before there is an account");
    });

    it("a signed-out tap on a mark ON the garment routes there too", async () => {
      const page = await open({ width: 390, height: 844 });
      const m = await page.evaluate(`
        ${REVEAL}
        document.querySelector("#garment-wrap .spot").click();
        await new Promise(r => setTimeout(r, 250));
        return ${VISIBLE};
      `);
      assert.deepEqual(m, ["auth"]);
    });

    it("signing up as a brand reopens the bid sheet on the spot that was tapped", async () => {
      const page = await open({ width: 390, height: 844 });
      const target = await page.evaluate(`
        ${REVEAL}
        const row = document.querySelectorAll(".srow")[1];
        const name = row.querySelector(".nm").textContent.trim().split("\\n")[0].trim();
        row.click();
        await new Promise(r => setTimeout(r, 200));
        return name;
      `);

      const user = await page.evaluate(SIGN_UP("brand", {
        name: "Buyer One", brand: "Acme Tools", email: "buyer@example.test",
      }));
      assert.equal(user.role, "brand", "the account was not created on the buying side");
      assert.equal(user.brand, "Acme Tools");

      const m = await page.evaluate(`
        return {
          screen: ${VISIBLE},
          sheetOpen: !document.getElementById("scrim").hidden,
          title: document.getElementById("sheet-title").textContent,
          brandPrefilled: document.getElementById("bid-brand").value,
        };
      `);
      assert.deepEqual(m.screen, ["campaign"], "it should be back on the campaign, behind the sheet");
      assert.equal(m.sheetOpen, true, "the bid sheet did not reopen after signing up");
      assert.equal(m.title, target, `the sheet reopened on "${m.title}" rather than on "${target}"`);
      assert.equal(m.brandPrefilled, "Acme Tools");
    });

    it("a publisher account is told bidding is not for them", async () => {
      const page = await open({ width: 1280, height: 900 });
      await page.evaluate(`
        ${REVEAL}
        document.querySelector(".srow").click();
        await new Promise(r => setTimeout(r, 200));
        return true;
      `);
      await page.evaluate(SIGN_UP("client", { name: "Pub One", email: "pub-one@example.test" }));
      const m = await page.evaluate(`
        /* Signing up already answered the tap that sent them here, and said
           so in a toast. Clear it, so what is read below can only be the
           refusal for the tap that follows it. */
        document.getElementById("toasts").innerHTML = "";
        ${REVEAL}
        document.querySelector(".srow").click();
        await new Promise(r => setTimeout(r, 250));
        return { screen: ${VISIBLE},
                 sheetOpen: !document.getElementById("scrim").hidden,
                 toasts: document.getElementById("toasts").textContent };
      `);
      assert.deepEqual(m.screen, ["campaign"], "a publisher who taps a spot should stay where they are");
      assert.equal(m.sheetOpen, false, "a publisher was shown a bid sheet");
      assert.match(m.toasts, /wearer|sponsor/i);
    });
  });

  /* ==================================================================== */
  describe("the bid sheet", () => {
    /**
     * Sign up as a brand and open the sheet on the first spot listed.
     *
     * It hands back the account, the spot the sheet is on, and every bid
     * already standing against that spot. All of that is needed now: every
     * seeded spot arrives ALREADY HELD by a brand, so what the sheet quotes
     * is a takeover price computed from somebody else's sealed ceiling, not a
     * floor - and the only honest way to predict it is the same engine the
     * page used.
     */
    async function atTheSheet(page) {
      await page.evaluate(`${REVEAL} document.querySelector(".srow").click(); await new Promise(r => setTimeout(r, 200)); return true;`);
      const user = await page.evaluate(SIGN_UP("brand", { name: "Buyer", brand: "Acme Tools", email: "b@example.test" }));
      await page.waitFor('!!document.getElementById("bid-max")', 5000, "the bid sheet to open");
      const ctx = await page.evaluate(`
        ${ON_SCREEN}
        const id = document.querySelector(".srow").dataset.spot;
        const spot = __spots.find(s => s.id === id);
        return { spot, bids: __bids.filter(b => b.spotId === id) };
      `);
      assert.ok(ctx.spot, "the first row on the page names a spot the store does not have");
      return { user, ...ctx };
    }

    it("tells 'owed if it closed now' apart from 'held on your card'", async () => {
      const page = await open();
      const { user, spot, bids } = await atTheSheet(page);

      const m = await page.evaluate(`
        const maxEl = document.getElementById("bid-max");
        const min = Number(maxEl.value);
        maxEl.value = String(min * 3);
        maxEl.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise(r => setTimeout(r, 100));
        const lines = [...document.querySelectorAll("#bid-quote .ln")].map(ln => ({
          k: ln.querySelector(".k") ? ln.querySelector(".k").textContent.trim() : "",
          v: ln.querySelector(".v") ? ln.querySelector(".v").textContent.trim() : "",
        }));
        return { min, lines, text: document.getElementById("bid-quote").innerText };
      `);

      const owed = m.lines.find(l => /owed if it closed now/i.test(l.k));
      const held = m.lines.find(l => /held on your card/i.test(l.k));
      assert.ok(owed, `no "Owed if it closed now" line:\n${m.text}`);
      assert.ok(held, `no "Held on your card" line:\n${m.text}`);

      assert.ok(n(held.v) > n(owed.v),
        `with a maximum of ${m.min * 3} against a minimum of ${m.min}, the hold (${held.v}) must exceed ` +
        `what is owed (${owed.v}) - conflating the two would be a lie about what is being taken`);

      /* The exact numbers, taken from the shared engine rather than from a
         second implementation written in the test. The spot is already held,
         so the settled price is a raise over the STANDING holder's sealed
         maximum, not the bidder's own and not the floor - and the page has to
         reach the same figure the server would. */
      const FEE = 8;
      const v = Market.evaluate(spot, bids, { bidder: user.id, brand: "Acme Tools", max: m.min * 3 });
      assert.equal(v.ok, true, `the engine refused the very bid the page quoted: ${v.reason}`);
      assert.equal(n(owed.v), Market.quote(v.price, FEE).total, "owed = the settled price plus the platform fee");
      assert.equal(n(held.v), Market.quote(m.min * 3, FEE).total, "held = the stated maximum plus the platform fee");
      assert.match(m.text, /only a hold/i, "the gap between the two should be explained, not left to be guessed");
    });

    it("when the settled price IS the maximum, the two numbers agree", async () => {
      const page = await open();
      const { spot, bids } = await atTheSheet(page);

      /* One raise over the standing holder's ceiling is the exact maximum
         that both takes the spot and settles at itself. Bid it and there is
         no gap left to hold, so the sheet must not invent one. The old
         version of this test used the input's own `min`, which worked only
         while spots arrived unsold: on a held spot the minimum is the least
         that PUSHES the holder, not the least that beats them. */
      const take = Market.raiseOver(Market.settle(spot, bids).leader.max);

      const m = await page.evaluate(`
        const maxEl = document.getElementById("bid-max");
        maxEl.value = "${take}";
        maxEl.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise(r => setTimeout(r, 100));
        const txt = document.getElementById("bid-quote").innerText;
        const pick = re => { const m2 = txt.match(re); return m2 ? Number(m2[1].replace(/[^0-9.]/g, "")) : null; };
        return { owed: pick(/Owed if it closed now\\s*\\n?\\s*(\\S+)/i),
                 held: pick(/Held on your card\\s*\\n?\\s*(\\S+)/i),
                 hasHoldNote: /only a hold/i.test(txt),
                 text: txt };
      `);
      assert.equal(m.owed, Market.quote(take, 8).total, `the sheet reads:\n${m.text}`);
      assert.equal(m.owed, m.held, "when the spot settles at your own maximum there is nothing extra to hold");
      assert.equal(m.hasHoldNote, false, "there is no hold to explain when the two numbers are the same");
    });

    it("refuses a bid below the minimum, and says what the minimum is", async () => {
      const page = await open();
      await atTheSheet(page);
      const m = await page.evaluate(`
        const maxEl = document.getElementById("bid-max");
        const min = Number(maxEl.min);
        const out = [];
        for (const v of [String(min - 1), "1", "0", "-500"]) {
          maxEl.value = v;
          maxEl.dispatchEvent(new Event("input", { bubbles: true }));
          await new Promise(r => setTimeout(r, 60));
          out.push({ tried: v,
                     quote: document.getElementById("bid-quote").innerText.trim(),
                     disabled: document.getElementById("bid-go").getAttribute("aria-disabled") });
        }
        return { min, out, minAttr: Number(maxEl.min) };
      `);
      assert.equal(m.minAttr, m.min, "the input's own min should carry the minimum");
      for (const attempt of m.out) {
        assert.equal(attempt.disabled, "true",
          `a maximum of ${attempt.tried} against a minimum of ${m.min} left the button live`);
        assert.match(attempt.quote, new RegExp(String(m.min)),
          `the refusal for ${attempt.tried} did not name the minimum: "${attempt.quote}"`);
      }
    });

    it("a refused bid is refused on submit too, not only in the quote", async () => {
      const page = await open();
      await atTheSheet(page);
      const m = await page.evaluate(`
        const wasRaised = document.getElementById("goal-raised").textContent;
        const maxEl = document.getElementById("bid-max");
        maxEl.value = "1";
        maxEl.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("bid-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 500));
        return { err: document.getElementById("bid-err").hidden ? null : document.getElementById("bid-err").textContent,
                 stillOpen: !document.getElementById("scrim").hidden,
                 wasRaised,
                 raised: document.getElementById("goal-raised").textContent };
      `);
      assert.ok(m.err, "submitting a bid under the minimum produced no error");
      assert.equal(m.stillOpen, true, "the sheet closed on a bid that was never placed");
      /* Not "$0" any more - the seeded market arrives with money already on
         it, so what matters is that this bid did not add to it. */
      assert.equal(m.raised, m.wasRaised, "a refused bid moved the funding bar");
    });

    it("Escape closes the sheet", async () => {
      const page = await open();
      await atTheSheet(page);
      const closed = await page.evaluate(`
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await new Promise(r => setTimeout(r, 400));
        return document.getElementById("scrim").hidden;
      `);
      assert.equal(closed, true);
    });
  });

  /* ==================================================================== */
  describe("placing a bid", () => {
    it("moves the funding bar, the spot row and the wall of marks", async () => {
      const page = await open();
      await page.evaluate(`${REVEAL} document.querySelector(".srow").click(); await new Promise(r => setTimeout(r, 200)); return true;`);
      const user = await page.evaluate(SIGN_UP("brand", { name: "Buyer", brand: "Acme Tools", email: "b@example.test" }));
      await page.waitFor('!!document.getElementById("bid-max")', 5000, "the bid sheet to open");

      const before = await page.evaluate(`
        ${REVEAL}
        const id = document.querySelector(".srow").dataset.spot;
        ${ON_SCREEN}
        return {
          spot: __spots.find(s => s.id === id),
          bids: __bids.filter(b => b.spotId === id),
          raised: document.getElementById("goal-raised").textContent,
          bar: document.getElementById("goal-bar").style.width,
          open: document.getElementById("goal-open").textContent,
          firstRow: document.querySelector(".srow").textContent.replace(/\\s+/g, " ").trim(),
          whoLine: document.querySelector(".srow .who") ? document.querySelector(".srow .who").textContent : "",
          wall: document.getElementById("wall").textContent.replace(/\\s+/g, " ").trim(),
          held: document.querySelectorAll(".srow.held").length,
        };
      `);
      assert.ok(!before.error, before.error);

      /* The seed sells the whole garment before anyone arrives, so this is a
         takeover, not a first claim. The brand already on the cloth is named
         in the row and on the wall, and has to be gone from both afterwards. */
      const was = Market.settle(before.spot, before.bids);
      assert.ok(was.holder, "the first row is not held - this test is meant to prove a takeover");
      assert.match(before.whoLine, new RegExp(was.holderName), "the row does not name the brand that holds it");
      assert.match(before.wall, new RegExp(was.holderName), "the wall does not carry the brand that holds it");
      assert.ok(!before.wall.includes("Acme Tools"));

      const after = await page.evaluate(`
        const maxEl = document.getElementById("bid-max");
        const min = Number(maxEl.min);
        maxEl.value = String(min * 2);
        maxEl.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("bid-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 1200));
        ${REVEAL}
        return {
          min,
          sheetClosed: document.getElementById("scrim").hidden,
          raised: document.getElementById("goal-raised").textContent,
          bar: document.getElementById("goal-bar").style.width,
          open: document.getElementById("goal-open").textContent,
          firstRow: document.querySelector(".srow").textContent.replace(/\\s+/g, " ").trim(),
          whoLine: document.querySelector(".srow .who") ? document.querySelector(".srow .who").textContent : "",
          wall: document.getElementById("wall").textContent.replace(/\\s+/g, " ").trim(),
          held: document.querySelectorAll(".srow.held").length,
          mineMarks: document.querySelectorAll("#garment-wrap .spot.mine, #garment-wrap .spot.held").length,
          toasts: document.getElementById("toasts").textContent,
        };
      `);

      assert.equal(after.sheetClosed, true, "the sheet stayed up after a successful bid");
      assert.match(after.toasts, /demo mode|authorised|placed/i, "the buyer was not told what happened");

      /* the funding bar. The whole campaign moves by exactly what this one
         spot moved by, and the engine is what says how much that is. */
      const now = Market.evaluate(before.spot, before.bids,
        { bidder: user.id, brand: "Acme Tools", max: after.min * 2 });
      assert.equal(now.won, true, "a maximum of twice the minimum should have taken the spot");
      assert.equal(n(after.raised) - n(before.raised), Market.money(now.price - was.price),
        `the bar went ${before.raised} -> ${after.raised}, but the spot went ${was.price} -> ${now.price}`);
      assert.notEqual(after.bar, before.bar, "the meter did not grow");
      assert.equal(Number(after.open), Number(before.open),
        "taking a spot off another brand does not open or close one - the count must not move");

      /* the spot row */
      assert.equal(after.held, before.held, "a takeover changed how many spots are held");
      assert.match(after.firstRow, /Held/i, "the row the bid was placed on does not say it is held");
      /* Read off the "Held by …" line rather than the whole row: the seed
         NAMES each spot after the brand that drew it, so the outbid brand's
         name legitimately stays in the row as the spot's own title. Who holds
         it is the separate sentence underneath. */
      assert.match(after.whoLine, /Acme Tools/, "the row does not name who holds it");
      assert.ok(!after.whoLine.includes(was.holderName), "the outbid brand is still shown as holding it");
      assert.match(after.firstRow, /to take it/i, "a held row should quote what it costs to take it, not its floor");

      /* the wall */
      assert.match(after.wall, /Acme Tools/, "the mark never reached the wall");
      assert.ok(after.mineMarks >= 1, "the mark on the garment was not repainted");
    });

    it("a second, higher bid takes the spot and the price rises", async () => {
      const page = await open();
      await page.evaluate(`${REVEAL} document.querySelector(".srow").click(); await new Promise(r => setTimeout(r, 200)); return true;`);
      await page.evaluate(SIGN_UP("brand", { name: "First", brand: "First Co", email: "first@example.test" }));
      await page.waitFor('!!document.getElementById("bid-max")', 5000, "the bid sheet");

      const first = await page.evaluate(`
        const maxEl = document.getElementById("bid-max");
        const min = Number(maxEl.min);
        maxEl.value = String(min * 2);
        maxEl.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("bid-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 1200));
        ${REVEAL}
        return { min, raised: document.getElementById("goal-raised").textContent,
                 row: document.querySelector(".srow").textContent.replace(/\\s+/g, " ").trim() };
      `);
      assert.match(first.row, /First Co/, "the first bid did not take the spot");

      const second = await page.evaluate(`
        await window.Store.auth.signOut();
        await new Promise(r => setTimeout(r, 200));
        ${REVEAL}
        document.querySelector(".srow").click();
        await new Promise(r => setTimeout(r, 250));
        return ${VISIBLE};
      `);
      assert.deepEqual(second, ["auth"], "signing out did not put the next visitor back at the door");

      await page.evaluate(SIGN_UP("brand", { name: "Second", brand: "Second Co", email: "second@example.test" }));
      await page.waitFor('!!document.getElementById("bid-max")', 5000, "the bid sheet");

      const out = await page.evaluate(`
        const maxEl = document.getElementById("bid-max");
        const min = Number(maxEl.min);
        maxEl.value = String(min * 4);
        maxEl.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("bid-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 1200));
        ${REVEAL}
        return { min,
                 raised: document.getElementById("goal-raised").textContent,
                 row: document.querySelector(".srow").textContent.replace(/\\s+/g, " ").trim(),
                 wall: document.getElementById("wall").textContent.replace(/\\s+/g, " ").trim() };
      `);

      assert.ok(out.min > first.min, "the minimum to take a spot must rise once somebody has taken it");
      assert.match(out.row, /Second Co/, "the spot did not change hands");
      assert.ok(!out.row.includes("First Co"), "the outbid brand is still shown as holding it");
      assert.notEqual(out.raised, first.raised, "the price did not rise when the spot changed hands");
      assert.match(out.wall, /Second Co/);
    });
  });

  /* ==================================================================== */
  describe("XSS: everything a stranger types is text, never markup", () => {
    it("a publisher headline, a spot name and a brand name all render as literal text", async () => {
      const page = await open();

      /* Write the payload into the listing and a spot the way a publisher
         would, then reload so it is rendered from storage on a cold boot.
         The reload deep-links straight back to the same listing: `/` is the
         front door now, and the point here is the campaign screen. */
      const listingId = await page.evaluate(`
        const PAY = ${JSON.stringify(XSS)};
        const listings = await window.Store.listings.list({ openOnly: false });
        const id = listings[0].id;
        await window.Store.listings.update(id, {
          headline: PAY, names: PAY, tagline: PAY, about: PAY, venue: PAY,
        });
        const spots = await window.Store.spots.list(id);
        await window.Store.spots.update(spots[0].id, { name: PAY, blurb: PAY, badge: PAY.slice(0, 10) });
        return id;
      `);
      await page.goto(`${ORIGIN}/?l=${encodeURIComponent(listingId)}`, { ready: CAMPAIGN_READY });

      /* …and as a brand name, which reaches the wall and the garment. The
         maximum has to be enough to actually WIN the spot: every seeded spot
         already has a brand sitting on it, and a payload that loses never
         reaches the wall, so the test would pass on a page that escaped
         nothing. */
      await page.evaluate(`${REVEAL} document.querySelector(".srow").click(); await new Promise(r => setTimeout(r, 250)); return true;`);
      await page.evaluate(SIGN_UP("brand", { name: "Pwn", brand: XSS, email: "pwn@example.test" }));
      await page.waitFor('!!document.getElementById("bid-max")', 5000, "the bid sheet");
      await page.evaluate(`
        const maxEl = document.getElementById("bid-max");
        maxEl.value = String(Number(maxEl.min) * 4);
        maxEl.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("bid-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 1200));
        return true;
      `);

      /* Out to the directory and back in through the publisher's own card.
         Everything on the way is redrawn from storage, and the card carries
         the payload too - the publisher's name is what titles it. */
      const m = await page.evaluate(`
        ${REVEAL}
        document.getElementById("nav-browse").click();
        await new Promise(r => setTimeout(r, 700));
        const lot = [...document.querySelectorAll("#browse-grid .lot")]
          .find(b => b.dataset.listing === ${JSON.stringify(listingId)});
        const inDirectory = document.getElementById("browse-grid").textContent;
        if (lot) lot.click();
        await new Promise(r => setTimeout(r, 700));
        ${REVEAL}
        await new Promise(r => setTimeout(r, 400));
        const PAY = ${JSON.stringify(XSS)};
        const text = document.body.innerText;
        return {
          screen: ${VISIBLE},
          pwned: window.__pwned === undefined ? "undefined" : window.__pwned,
          injectedImgs: document.querySelectorAll('img[src="x"]').length,
          onerrorAttrs: document.querySelectorAll("[onerror]").length,
          literalInHeadline: document.getElementById("hero-h1").textContent.includes(PAY),
          literalInList: document.getElementById("spotlist").textContent.includes(PAY),
          literalOnWall: document.getElementById("wall").textContent.includes(PAY),
          literalInDirectory: inDirectory.includes(PAY),
          headlineHtml: document.getElementById("hero-h1").innerHTML.slice(0, 200),
          anyPayloadText: text.includes(PAY),
        };
      `);

      assert.deepEqual(m.screen, ["campaign"], "the walk out to the directory and back never arrived");
      assert.equal(m.pwned, "undefined", "the payload executed: window.__pwned was set");
      assert.equal(m.injectedImgs, 0, `an <img src="x"> was built from user text (${m.injectedImgs} of them)`);
      assert.equal(m.onerrorAttrs, 0, "an onerror attribute was built from user text");

      /* Proving it is inert is only half of it: it also has to be VISIBLE as
         text, otherwise a test would pass just as happily on a blank page. */
      assert.equal(m.literalInHeadline, true, `the headline did not render the payload as text: ${m.headlineHtml}`);
      assert.equal(m.literalInList, true, "the spot list did not render the payload as text");
      assert.equal(m.literalOnWall, true, "the wall of marks did not render the brand name as text");
      assert.equal(m.literalInDirectory, true, "the directory card did not render the publisher's name as text");
      assert.match(m.headlineHtml, /&lt;img/, "the headline should be escaped, not stripped");

      assert.deepEqual(page.errors(), [], `console errors while rendering the payload:\n${page.consoleText()}`);
    });

    it("a javascript: logo URL is never put in a src", async () => {
      const page = await open();
      const id = await page.evaluate(`
        const listings = await window.Store.listings.list({ openOnly: false });
        await window.Store.listings.update(listings[0].id, {
          photo_front: "javascript:window.__pwned=1",
          photo_back: "data:text/html,<script>window.__pwned=1<\\/script>",
        });
        return listings[0].id;
      `).catch(() => null);
      /* Straight back to the same listing, where both photographs are drawn. */
      await page.goto(`${ORIGIN}/?l=${encodeURIComponent(id)}`, { ready: CAMPAIGN_READY });
      const out = await page.evaluate(`
        ${REVEAL}
        return {
          pwned: window.__pwned === undefined ? "undefined" : window.__pwned,
          bad: [...document.querySelectorAll("img")].map(i => i.getAttribute("src"))
                 .filter(s => s && /^(javascript:|data:text)/i.test(s)).length,
        };
      `);
      assert.equal(out.pwned, "undefined");
      assert.equal(out.bad, 0, "a javascript: or data:text URL reached an img src");
    });
  });

  /* =====================================================================
     A brand draws its own spot.

     This is the change the whole product turns on. The publisher no longer
     lays out a menu of rectangles and prices them; they price ONE PERCENT of
     the fabric, and a brand drags out whatever shape it wants. So the drag
     itself, the number that follows the hand, the two refusals, and above all
     what happens to a rectangle the publisher has not agreed to yet, are now
     the load-bearing paths on the buying side.
     ===================================================================== */
  describe("a brand draws its own spot", () => {
    /** On the first seeded listing, signed in as a brand, sheet out of the way. */
    async function asABrand(page, { brand = "Acme Tools", email = "brand@example.test" } = {}) {
      await page.evaluate(`${REVEAL} document.querySelector(".srow").click(); await new Promise(r => setTimeout(r, 200)); return true;`);
      const user = await page.evaluate(SIGN_UP("brand", { name: "Buyer", brand, email }));
      assert.equal(user.role, "brand");
      /* Signing up answered the tap by reopening the bid sheet on that row.
         It is over the photograph, so put it away before anything is drawn. */
      await page.evaluate(`
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await new Promise(r => setTimeout(r, 400));
        document.getElementById("toasts").innerHTML = "";
        ${REVEAL}
        return true;
      `);
      return user;
    }

    it("quotes the area under the hand, and charges the front more for the same rectangle", async () => {
      const page = await open();
      await asABrand(page);
      const L = await page.evaluate(`${ON_SCREEN} return __L;`);
      assert.ok(!L.error, L.error);

      /* A patch of clear fabric high on the left, well away from the two
         brands the seed has already printed on this garment. */
      const front = await page.evaluate(`${ARM} ${DRAG(FRONT_PANEL, 0.10, 0.10, 0.25, 0.30)}`);
      assert.ok(!front.error, front.error);
      assert.equal(front.side, "front");

      /* The number chasing the cursor is the whole feature. If it is computed
         anywhere but in the shared engine it will disagree with the server
         the moment the bid is submitted, and the brand will have been quoted
         one price and charged another. */
      assert.equal(n(front.label), Market.priceForBox(front, L),
        `the live label read "${front.label}" for a ${Market.areaPercent(front).toFixed(2)}% box ` +
        `at ${L.rate_per_percent} per percent`);

      const sheet = await page.evaluate(`
        return { open: !document.getElementById("scrim").hidden,
                 kicker: document.getElementById("sheet-kicker").textContent,
                 title: document.getElementById("sheet-title").textContent,
                 quote: document.querySelector("#sheet-body .quote").innerText.replace(/\\s+/g, " ").trim(),
                 min: Number(document.getElementById("bid-max").min) };
      `);
      assert.equal(sheet.open, true, "releasing the drag did not open a bid sheet on the rectangle");
      assert.match(sheet.kicker, /front/i, "the sheet does not say which side was drawn on");
      assert.equal(sheet.min, Market.priceForBox(front, L),
        "the floor in the sheet has to be the same number the label quoted mid-drag");
      assert.match(sheet.quote,
        new RegExp(Market.areaPercent(front).toFixed(1).replace(".", "\\.") + "%"),
        `the sheet never says how much of the photograph was drawn on: ${sheet.quote}`);

      /* The same rectangle on the back. Nothing about it has changed except
         which photograph it is on, so the front multiplier is the only thing
         that can move the price - and it must. */
      const back = await page.evaluate(`
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await new Promise(r => setTimeout(r, 450));
        ${ARM}
        ${DRAG(BACK_PANEL, 0.10, 0.10, 0.25, 0.30)}
      `);
      assert.ok(!back.error, back.error);
      assert.equal(back.side, "back");
      assert.deepEqual([back.w, back.h], [front.w, front.h], "the two drags did not draw the same rectangle");

      assert.equal(n(back.label), Market.priceForBox(back, L));
      assert.equal(n(front.label), Market.priceForBox({ ...back, side: "front" }, L),
        "the same box quoted on the front is not the back's price times the listing's front multiplier");
      assert.ok(n(front.label) > n(back.label),
        `the front (${front.label}) has to cost more than the back (${back.label}) - it is the side ` +
        `the cameras are pointed at, and this listing charges x${L.front_multiplier} for it`);

      assert.deepEqual(page.errors(), [], `console errors while drawing:\n${page.consoleText()}`);
    });

    it("refuses a box over somebody else's spot, and one too small to read, and says why", async () => {
      const page = await open();
      await asABrand(page);
      const taken = await page.evaluate(`
        ${ON_SCREEN}
        return __spots.filter(s => s.side === "front").sort((a, b) => a.n - b.n)[0];
      `);
      assert.ok(taken, "the seed put no spot on the front, so there is nothing to collide with");

      /* Straight across the first spot on the front. Two logos printed on one
         piece of cloth is a refund after the wedding, not a bug report, so
         the engine has to stop it before any money moves. */
      const overlap = await page.evaluate(`
        ${ARM}
        document.getElementById("toasts").innerHTML = "";
        ${DRAG(FRONT_PANEL, 0.42, 0.28, 0.60, 0.44)}
      `);
      assert.ok(!overlap.error, overlap.error);
      /* The refusal is pinned to the rectangle that caused it - a toast beside
         a garment the reader is still looking at is a message about a box they
         can no longer see. Read it off the box. */
      const clash = await page.evaluate(`
        const bad = document.querySelector("#garment-wrap .spot-draft.bad");
        return { sheetOpen: !document.getElementById("scrim").hidden,
                 toasts: (bad ? bad.textContent : "") + document.getElementById("toasts").textContent,
                 pinned: !!bad,
                 spots: (await window.Store.spots.list(${JSON.stringify(taken.listing_id)})).length };
      `);
      assert.equal(Market.validateBox(overlap, { }, [taken]).ok, false,
        "the box this test drags out does not actually overlap the seeded spot any more");
      assert.equal(clash.sheetOpen, false, "a box drawn over a spot somebody holds opened a bid sheet");
      assert.ok(clash.pinned, "the refused rectangle vanished instead of staying put with its reason on it");
      assert.match(clash.toasts, /overlap/i, `the brand was not told why: "${clash.toasts}"`);
      assert.match(clash.toasts, new RegExp(`spot ${taken.n}\\b`, "i"),
        "the refusal should name the spot it collided with, or there is nothing to move away from");

      /* And a rectangle nobody could read a logo in. The floor under it would
         be a couple of dollars, which is the other way to end a market. */
      const tiny = await page.evaluate(`
        ${ARM}
        document.getElementById("toasts").innerHTML = "";
        ${DRAG(FRONT_PANEL, 0.10, 0.10, 0.13, 0.145)}
      `);
      assert.ok(!tiny.error, tiny.error);
      assert.ok(Market.areaPercent(tiny) < Market.RULES.MIN_AREA_PCT,
        `the box this test drags out covers ${Market.areaPercent(tiny)}%, which is not under the minimum`);
      const small = await page.evaluate(`
        const bad = document.querySelector("#garment-wrap .spot-draft.bad");
        return { sheetOpen: !document.getElementById("scrim").hidden,
                 toasts: (bad ? bad.textContent : "") + document.getElementById("toasts").textContent,
                 pinned: !!bad,
                 spots: (await window.Store.spots.list(${JSON.stringify(taken.listing_id)})).length };
      `);
      assert.equal(small.sheetOpen, false, "a box under the minimum area opened a bid sheet");
      assert.ok(small.pinned, "the refused rectangle vanished instead of staying put with its reason on it");
      assert.match(small.toasts, /too small/i, `the brand was not told why: "${small.toasts}"`);
      assert.match(small.toasts, new RegExp(String(Market.RULES.MIN_AREA_PCT).replace(".", "\\.")),
        "the refusal should say how big a spot has to be, not just that this one is not");

      /* Neither refusal may leave anything behind. */
      assert.equal(small.spots, clash.spots, "a refused rectangle was written to the store anyway");
    });
  });

  /* ==================================================================== */
  describe("the publisher's side", () => {
    /**
     * A publisher, a listing, both photographs on it, a rate, and the bidding
     * open - everything that has to be true before a brand may draw anything.
     *
     * The photographs go onto the row through the store. The studio's two
     * drop zones are not wired to anything in app.js, so there is no click
     * path to upload one; see the note at the foot of this file.
     */
    async function aGarmentOnSale(page, {
      name = "Pub Lisher", email = "publisher@example.test", rate = 400, front = 2,
    } = {}) {
      await page.evaluate(`
        document.getElementById("door-publisher").click();
        await new Promise(r => setTimeout(r, 300));
        ${SIGN_UP("client", { name, email })}
      `);
      const out = await page.evaluate(`
        const mine = await window.Store.listings.mine();
        if (!mine.length) return { error: "no listing was created for the new publisher" };
        const before = {
          screen: ${VISIBLE},
          spots: document.getElementById("studio-spotcount").textContent,
          drawButtons: document.querySelectorAll("#studio-draw, #studio-clear").length,
        };
        await window.Store.listings.update(mine[0].id, {
          photo_front: "/assets/garments/p1-front.jpg",
          photo_back:  "/assets/garments/p1-back.jpg",
        });
        const set = (id, v) => { const el = document.getElementById(id); el.value = v;
                                 el.dispatchEvent(new Event("input", { bubbles: true })); };
        set("t-rate", "${rate}");
        set("t-frontmul", "${front}");
        const example = document.getElementById("rate-example").textContent;
        document.getElementById("terms-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 800));
        document.getElementById("toasts").innerHTML = "";
        const wasLabel = document.getElementById("terms-open").textContent;
        document.getElementById("terms-open").click();
        await new Promise(r => setTimeout(r, 800));
        const L = (await window.Store.listings.mine())[0];
        return { before, example, wasLabel, id: L.id, isOpen: L.is_open,
                 rate: L.rate_per_percent, front: L.front_multiplier,
                 nowLabel: document.getElementById("terms-open").textContent,
                 meta: document.getElementById("studio-meta").textContent };
      `);
      assert.ok(!out.error, out.error);
      return out;
    }

    it("a publisher prices one percent of the cloth, and the brands draw on it", async () => {
      const page = await open({ screen: "home" });
      const RATE = 400, FRONT = 2;
      const studio = await aGarmentOnSale(page, { rate: RATE, front: FRONT });

      /* 1. a publisher lands in their own studio with an empty listing */
      assert.deepEqual(studio.before.screen, ["studio"], "a new publisher was not taken to their studio");
      assert.match(studio.before.spots, /^0 spots/, `the new listing already had spots: ${studio.before.spots}`);

      /* 2. and no way to draw one. The publisher used to lay out thirteen
         rectangles by hand; a leftover draw button would be a second, silent
         way for spots to appear that nothing else in the app expects. */
      assert.equal(studio.before.drawButtons, 0,
        "the studio still has a draw or clear button on it - the publisher does not mark out spots any more");

      /* 3. what they set instead is the rate and the premium on the front,
         and the worked example under the fields has to follow them. Those two
         numbers ARE the price list now, so a form that quietly failed to save
         them would sell somebody's dress at the default rate. */
      assert.equal(Number(studio.rate), RATE, "the rate was not saved onto the listing");
      assert.equal(Number(studio.front), FRONT, "the front multiplier was not saved onto the listing");
      const priced = { rate_per_percent: RATE, front_multiplier: FRONT };
      const quoted = studio.example.match(/[\d,]+(?:\.\d+)?/g).map(s => Number(s.replace(/,/g, "")));
      assert.deepEqual(quoted, [
        Market.priceForBox({ side: "front", w: 27, h: 10 }, priced),
        Market.priceForBox({ side: "back", w: 14, h: 8 }, priced),
      ], `the example under the rate reads "${studio.example}"`);

      /* 4. and then the bidding opens, which it could not have done before
         both photographs were up. */
      assert.match(studio.wasLabel, /open the bidding/i);
      assert.equal(studio.isOpen, true, "the listing did not open");
      assert.match(studio.nowLabel, /close the bidding/i, "the button did not flip to its opposite");
      assert.match(studio.meta, /bidding open/i);

      /* 5. seen from the buying side: no menu of spots, a rate card in place
         of the old "standout spot" pitch, and an invitation to drag. */
      const asBuyer = await page.evaluate(`
        document.getElementById("studio-view").click();
        await new Promise(r => setTimeout(r, 700));
        ${REVEAL}
        return { screen: ${VISIBLE},
                 rows: document.querySelectorAll(".srow").length,
                 list: document.getElementById("spotlist").textContent.replace(/\\s+/g, " ").trim(),
                 feature: document.getElementById("feature").innerText.replace(/\\s+/g, " ").trim(),
                 drawOffered: !document.getElementById("draw-toggle").hidden,
                 drawHint: document.getElementById("draw-hint").textContent,
                 goal: document.getElementById("goal-total").textContent };
      `);
      assert.deepEqual(asBuyer.screen, ["campaign"], "'view as a brand' did not leave the studio");
      assert.equal(asBuyer.rows, 0, "a listing nobody has bought anything on should list no spots");
      assert.equal(asBuyer.goal, "0");
      assert.match(asBuyer.list, /drag a box/i, "the empty spot list does not tell a brand what to do");
      assert.equal(asBuyer.drawOffered, true,
        "both photographs are up and the bidding is open, so a brand must be offered the drag");
      assert.ok(!/upload|not open/i.test(asBuyer.drawHint),
        `the hint under the toggle is still making excuses: "${asBuyer.drawHint}"`);
      assert.match(asBuyer.feature, new RegExp(`\\$${RATE}`), `the rate card does not quote the rate: ${asBuyer.feature}`);
      assert.match(asBuyer.feature, new RegExp(`×${FRONT}`), "the rate card does not quote the front premium");

      /* 6. and its call to action arms the drag and sends them to the
         photograph. It used to open a bid on one nominated "standout"
         rectangle; there is no such thing to open one on any more, and a
         sheet here would be a bid on nothing at all. */
      const go = await page.evaluate(`
        document.getElementById("toasts").innerHTML = "";
        document.getElementById("feature-go").click();
        await new Promise(r => setTimeout(r, 500));
        return { sheetOpen: !document.getElementById("scrim").hidden,
                 pressed: document.getElementById("draw-toggle").getAttribute("aria-pressed"),
                 armed: document.querySelectorAll("#garment-wrap .garment.drawable").length,
                 toasts: document.getElementById("toasts").textContent };
      `);
      assert.equal(go.sheetOpen, false, "'Draw your own' opened a bid sheet instead of sending them to the garment");
      assert.equal(go.pressed, "true", "'Draw your own' did not arm the drag it invites");
      assert.equal(go.armed, 2, "both photographs are up, so both panels should take the drag once it is armed");
      assert.match(go.toasts, /drag a rectangle/i, "nothing told the brand what to do when it got there");

      assert.deepEqual(page.errors(), [], `console errors during the publisher flow:\n${page.consoleText()}`);
    });

    it("the bidding cannot be opened until BOTH photographs are up", async () => {
      const page = await open({ screen: "home" });
      const me = await page.evaluate(`
        document.getElementById("nav-publish").click();
        await new Promise(r => setTimeout(r, 300));
        ${SIGN_UP("client", { name: "Empty Pub", email: "empty@example.test" })}
      `);
      assert.equal(me.role, "client");

      /* The old refusal here was "mark out at least one spot first". There
         are no spots to mark out any more - the brand draws its own - so what
         a listing cannot open without is the two photographs it draws ON. */
      const none = await page.evaluate(`
        document.getElementById("toasts").innerHTML = "";
        document.getElementById("terms-open").click();
        await new Promise(r => setTimeout(r, 500));
        const mine = await window.Store.listings.mine();
        return { isOpen: mine[0].is_open, toasts: document.getElementById("toasts").textContent };
      `);
      assert.equal(none.isOpen, false, "a garment nobody can see went on sale");
      assert.match(none.toasts, /upload a front and a back photograph first/i,
        `the refusal read "${none.toasts}"`);

      /* One side up is its own case, and it needs its own sentence: half the
         garment is unsellable and nothing else on the page would say so. */
      const half = await page.evaluate(`
        const mine = await window.Store.listings.mine();
        await window.Store.listings.update(mine[0].id, { photo_front: "/assets/garments/p1-front.jpg" });
        /* Saving the terms is what makes the studio re-read the row it just
           wrote - state.listing is otherwise still the one with no photos. */
        document.getElementById("terms-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 800));
        document.getElementById("toasts").innerHTML = "";
        document.getElementById("terms-open").click();
        await new Promise(r => setTimeout(r, 500));
        const after = await window.Store.listings.mine();
        return { isOpen: after[0].is_open, toasts: document.getElementById("toasts").textContent };
      `);
      assert.equal(half.isOpen, false, "a garment with only a front photograph went on sale");
      assert.match(half.toasts, /upload the (other|back|front) photograph first/i,
        `a publisher one photograph short was told "${half.toasts}"`);
    });

    /* ------------------------------------------------------------------
       The two tests below are the load-bearing pair on this side.

       A drawn rectangle is a stranger's request to print their logo on
       somebody's wedding dress. It holds their money and none of our
       opinions. Until the person wearing the dress says yes, it must not
       appear anywhere a member of the public can see it - and when they do
       say yes, it must appear everywhere at once.
       ------------------------------------------------------------------ */

    /**
     * A publisher's listing, opened, with a brand's rectangles drawn on it.
     *
     * Each box is dragged out for real - that is what proves the drag, the
     * validation and the bid sheet agree about what was drawn - and the bid
     * itself then goes through Store.bids.place, which is the identical call
     * the sheet's own submit handler makes. It has to, because the sheet's
     * button cannot currently be clicked: see the note at the foot of this
     * file. What these two tests are about is what happens to a rectangle
     * AFTER the money is behind it, and that must not be held hostage to a
     * bug in the quote above it.
     *
     * It ends on a cold boot of the listing, so everything read afterwards is
     * drawn from storage rather than from whatever was left in memory.
     */
    async function withDrawnBoxes(page, boxes) {
      const studio = await aGarmentOnSale(page);
      await page.evaluate("await window.Store.auth.signOut(); return true;");

      /* One navigation for the whole drawing phase. It cannot be one per box:
         demo mode writes the session to local storage but never reads it back
         on boot, so every reload signs the brand out again. */
      await page.goto(`${ORIGIN}/?l=${encodeURIComponent(studio.id)}`, { ready: CAN_DRAW });
      await page.evaluate(REVEAL + " return true;");

      const drawn = [];
      for (const [i, b] of boxes.entries()) {
        const box = await page.evaluate(`${ARM} ${DRAG(FRONT_PANEL, ...b)}`);
        assert.ok(!box.error, box.error);

        if (i === 0) {
          /* The drag comes first and the account second on purpose: that is
             the order a real brand meets this page in, and the rectangle has
             to survive the detour. */
          const at = await page.evaluate(`return ${VISIBLE};`);
          assert.deepEqual(at, ["auth"], "a signed-out brand that drew a box was not asked for an account");
          const user = await page.evaluate(SIGN_UP("brand", {
            name: "Buyer", brand: "Acme Tools", email: "acme@example.test",
          }));
          assert.equal(user.role, "brand");
        }
        await page.waitFor('!!document.getElementById("bid-max")', 5000,
          "the drawn rectangle to open its own bid sheet (and to survive the sign-up on the first one)");

        const placed = await page.evaluate(`
          const floor = Number(document.getElementById("bid-max").min);
          const brand = document.getElementById("bid-brand").value.trim();
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          await new Promise(r => setTimeout(r, 400));
          /* Exactly what the sheet's submit handler sends: the shape, never
             the price - the price is worked out again on the other side. */
          const res = await window.Store.bids.place({
            listingId: ${JSON.stringify(studio.id)}, spotId: null,
            draw: ${JSON.stringify({ side: box.side, x: box.x, y: box.y, w: box.w, h: box.h })},
            max: floor, brand, logo: null,
          });
          return { floor, brand, demo: !!res.demo };
        `);
        drawn.push({ ...box, floor: placed.floor });
      }

      await page.goto(`${ORIGIN}/?l=${encodeURIComponent(studio.id)}`, { ready: CAN_DRAW });
      await page.evaluate(REVEAL + " return true;");
      return { studio, drawn };
    }

    it("a drawn spot is a request, not a purchase: nothing about it reaches the public page", async () => {
      const page = await open({ screen: "home" });
      const { studio, drawn } = await withDrawnBoxes(page, [[0.10, 0.10, 0.25, 0.30]]);

      const after = await page.evaluate(`
        ${REVEAL}
        const spots = await window.Store.spots.list(${JSON.stringify(studio.id)});
        const bids = await window.Store.bids.list(${JSON.stringify(studio.id)});
        return {
          stored: spots.map(s => ({ approved: s.approved, side: s.side, w: s.w, h: s.h, floor: s.floor })),
          bids: bids.length,
          rows: document.querySelectorAll(".srow").length,
          list: document.getElementById("spotlist").textContent.replace(/\\s+/g, " ").trim(),
          marks: document.querySelectorAll("#garment-wrap .spot").length,
          total: document.getElementById("goal-total").textContent,
          open: document.getElementById("goal-open").textContent,
          raised: document.getElementById("goal-raised").textContent,
          wall: document.getElementById("wall").textContent.replace(/\\s+/g, " ").trim(),
        };
      `);

      /* The money and the rectangle are real and recorded… */
      assert.equal(after.stored.length, 1, "the drawn rectangle was not written to the store at all");
      assert.equal(after.bids, 1, "no bid was recorded against the drawn rectangle");
      assert.equal(after.stored[0].approved, false,
        "a rectangle a brand drew on a stranger's garment arrived already approved");
      assert.equal(Number(after.stored[0].floor), drawn[0].floor,
        "the spot was stored at a different price from the one the brand was quoted");

      /* …and NONE of it is on the page anyone can see. Every one of these is
         a separate reader of the spot list, and each of them has its own
         filter; one of them forgetting to check `approved` is how a logo
         nobody consented to ends up printed next to a bride's face. */
      assert.equal(after.rows, 0, "an unapproved spot was listed for sale");
      assert.equal(after.marks, 0, "an unapproved spot was drawn onto the garment");
      assert.equal(after.total, "0", "an unapproved spot was counted in the goal");
      assert.equal(after.open, "0", "an unapproved spot was counted as open");
      assert.equal(n(after.raised), 0, "an unapproved spot's money was counted as raised");
      assert.ok(!/Acme Tools/.test(after.wall), "an unapproved brand reached the wall of marks");
      assert.ok(!/Acme Tools/.test(after.list), "an unapproved brand reached the spot list");

      assert.deepEqual(page.errors(), [], `console errors after a drawn bid:\n${page.consoleText()}`);
    });

    it("the publisher accepts one and declines the other, and the page follows", async () => {
      const page = await open({ screen: "home" });
      /* Two rectangles, far apart, so neither refuses the other. */
      const { studio } = await withDrawnBoxes(page, [[0.10, 0.10, 0.25, 0.30], [0.60, 0.10, 0.72, 0.25]]);

      /* Back in as the person wearing the garment. */
      const pub = await page.evaluate(SIGN_IN("publisher@example.test"));
      assert.equal(pub.role, "client", "signing back in did not land on the publishing side");

      const waiting = await page.evaluate(`
        return { screen: ${VISIBLE},
                 cardShown: !document.getElementById("pending-card").hidden,
                 count: document.getElementById("pending-count").textContent,
                 accepts: document.querySelectorAll("#pending-list [data-approve]").length,
                 declines: document.querySelectorAll("#pending-list [data-decline]").length,
                 who: document.getElementById("pending-list").textContent.replace(/\\s+/g, " ").trim(),
                 onTheGarment: document.querySelectorAll("#studio-garment .spot").length };
      `);
      assert.deepEqual(waiting.screen, ["studio"]);
      assert.equal(waiting.cardShown, true, "two brands are waiting and the publisher is not told");
      assert.equal(waiting.count, "2");
      assert.equal(waiting.accepts, 2, "there is no way to accept one of them");
      assert.equal(waiting.declines, 2, "there is no way to decline one of them");
      assert.match(waiting.who, /Acme Tools/, "the publisher is not told which brand wants the space");
      /* The studio's own panel passes showPending, so the owner - and only
         the owner - sees where these people are asking to be. */
      assert.equal(waiting.onTheGarment, 2,
        "the publisher cannot see where on their own garment the brands want to print");

      const accepted = await page.evaluate(`
        const btn = document.querySelector("#pending-list [data-approve]");
        const id = btn.dataset.approve;
        btn.click();
        await new Promise(r => setTimeout(r, 900));
        const spots = await window.Store.spots.list(${JSON.stringify(studio.id)});
        return { id, count: document.getElementById("pending-count").textContent,
                 stored: spots.map(s => ({ id: s.id, approved: s.approved })) };
      `);
      assert.equal(accepted.count, "1", "accepting one did not take it out of the waiting list");
      assert.equal(accepted.stored.find(s => s.id === accepted.id).approved, true);

      /* Declining is a sheet, not a confirm(): it releases somebody's money and
         the native dialog cannot say whose, or how much. */
      const declined = await page.evaluate(`
        document.querySelector("#pending-list [data-decline]").click();
        await new Promise(r => setTimeout(r, 400));
        const sheetOpen = !document.getElementById("scrim").hidden;
        const asked = document.getElementById("sheet-title").textContent;
        document.getElementById("dec-go").click();
        await new Promise(r => setTimeout(r, 1200));
        const spots = await window.Store.spots.list(${JSON.stringify(studio.id)});
        return { sheetOpen, asked,
                 cardShown: !document.getElementById("pending-card").hidden,
                 stored: spots.map(s => ({ id: s.id, approved: s.approved, declined: !!s.declined })) };
      `);
      assert.ok(declined.sheetOpen, "declining fired without asking, on a sheet that names the sponsor");
      assert.match(declined.asked, /say no to/i, "the sheet did not say whose money it is about to release");
      assert.equal(declined.cardShown, false, "the waiting list stayed up with nobody in it");

      /* The row is KEPT and marked, never deleted. `bids.spot_id` is
         `on delete cascade`, so deleting the spot deletes the bid that carries
         `stripe_payment_intent` - after which the hold on that sponsor's card
         cannot be cancelled by anyone, while the page says it was released.
         The strong assertion is therefore that the row survives AND that it is
         nowhere near the public page, which is checked directly below. */
      const dead = declined.stored.filter(s => s.id !== accepted.id);
      assert.equal(dead.length, 1, "the declined rectangle was deleted, which strands the hold on it");
      assert.deepEqual(dead[0], { id: dead[0].id, approved: false, declined: true },
        "a declined rectangle must stay unapproved and be marked declined");

      /* And now the public page, which said nothing at all a moment ago. */
      const publicPage = await page.evaluate(`
        document.getElementById("studio-view").click();
        await new Promise(r => setTimeout(r, 700));
        ${REVEAL}
        return { screen: ${VISIBLE},
                 rows: document.querySelectorAll(".srow").length,
                 marks: document.querySelectorAll("#garment-wrap .spot").length,
                 total: document.getElementById("goal-total").textContent,
                 raised: document.getElementById("goal-raised").textContent,
                 wall: document.getElementById("wall").textContent.replace(/\\s+/g, " ").trim() };
      `);
      assert.deepEqual(publicPage.screen, ["campaign"]);
      assert.equal(publicPage.rows, 1, "the accepted spot is still not on the page a brand reads");
      assert.equal(publicPage.marks, 1, "the accepted spot was not drawn onto the garment");
      assert.equal(publicPage.total, "1", "the accepted spot was not counted in the goal");
      assert.ok(n(publicPage.raised) > 0, "the accepted spot's money is still not counted as raised");
      assert.match(publicPage.wall, /Acme Tools/, "the accepted brand never reached the wall");

      assert.deepEqual(page.errors(), [], `console errors around approval:\n${page.consoleText()}`);
    });
  });

  /* ==================================================================== */
  describe("deep links", () => {
    it("?l=&spot= selects that spot", async () => {
      /* This tab only reads ids back out of the store, so it can stay put. */
      const first = await open({ screen: "home" });
      const ids = await first.evaluate(`
        const listings = await window.Store.listings.list({ openOnly: false });
        const spots = await window.Store.spots.list(listings[0].id);
        const last = spots[spots.length - 1];
        return { listing: listings[0].id, spot: last.id, name: last.name };
      `);

      const page = await open({ query: `?l=${encodeURIComponent(ids.listing)}&spot=${encodeURIComponent(ids.spot)}` });
      const m = await page.evaluate(`
        ${REVEAL}
        await new Promise(r => setTimeout(r, 400));
        return { selected: document.querySelectorAll("#garment-wrap .spot.sel").length,
                 bar: document.getElementById("actionbar").className,
                 barText: document.getElementById("ab-v").textContent };
      `);
      assert.ok(m.selected >= 1, "the deep-linked spot was not selected on the garment");
      assert.match(m.bar, /show/, "the action bar did not appear for a deep-linked spot");
      assert.ok(m.barText.includes(ids.name), `the action bar reads "${m.barText}", not "${ids.name}"`);
    });

    it("?paid=1 and ?paid=0 tell the buyer what happened on the way back from Stripe", async () => {
      for (const [q, re] of [["?paid=1", /authorised/i], ["?paid=0", /cancelled/i]]) {
        /* Neither of these names a listing, so both land on the front door.
           The message has to be waiting there all the same. */
        const page = await open({ query: q, screen: "home" });
        const toasts = await page.evaluate('document.getElementById("toasts").textContent');
        assert.match(toasts, re, `${q} said nothing useful: "${toasts}"`);
      }
    });
  });
});

/* =========================================================================
   Three things this file works around rather than asserts, because they are
   the app's to fix and not the test's to paper over:

     * A DRAWN BOX CANNOT ACTUALLY BE BID ON. app.js draftSpot() gives the
       rectangle `id: null` (it has no row yet - the server makes one as part
       of taking the bid), and Market.evaluate() opens with
       `if (!spot || spot.id == null) return reject("That spot does not
       exist.")`. So openBid()'s quote refuses every drawn box, #bid-go stays
       aria-disabled, and the submit handler bails before it ever reaches
       Store.bids.place. The server's drawn path (server/index.js:380+) is
       complete and never gets called. The two approval tests above therefore
       drive the bid through Store.bids.place directly - the identical call
       the submit handler makes one line later.

     * NO PHOTOGRAPH CAN BE UPLOADED THROUGH THE INTERFACE. app.js defines
       `async function upload(side, file, drop)` and nothing anywhere calls
       it; the studio's two `.drop[data-side]` file inputs in index.html have
       no listener at all. Since the bidding will not open without both
       photographs, no publisher who signs up today can sell anything. The
       helpers above write the two photo_ columns through the store instead.

     * "OWED IF IT CLOSED NOW" IS NOT WHAT YOU OWE WHEN YOU LOSE. Inside
       openBid()'s draw(), the quote labels Market.quote(v.price) that way
       even when v.won is false - but a bid that does not take the spot owes
       nothing, and v.price is what the CURRENT HOLDER will pay. On a held
       spot at the input's own minimum the sheet prints an "owed" figure
       LARGER than the "held on your card" figure directly beneath it.
   ========================================================================= */
