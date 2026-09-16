"use strict";

/* =========================================================================
   End-to-end, in a real Chrome, against the real server.

   Everything runs in DEMO mode: the server is started with a scrubbed
   environment, so /api/config reports nothing configured and store.js keeps
   the whole market in the browser's own localStorage. That is deliberate.
   It is the mode a fresh clone runs in, it needs no keys and no network, and
   it exercises the same rendering, the same escaping and the same engine the
   live mode does.

   Four things about this file are load-bearing.

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

/* Forces the scroll-reveal sections visible before anything is measured. */
const REVEAL = 'document.querySelectorAll(".rv").forEach(e => e.classList.add("shown"));';

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

    it("draws the seeded market: spots, floors and a closing clock", async () => {
      const page = await open();
      const m = await page.evaluate(`
        ${REVEAL}
        return {
          rows: document.querySelectorAll(".srow").length,
          marks: document.querySelectorAll("#garment-wrap .spot").length,
          raised: document.getElementById("goal-raised").textContent,
          total: Number(document.getElementById("goal-total").textContent),
          clock: document.getElementById("goal-clock").textContent,
        };
      `);
      assert.ok(m.rows >= 6, `only ${m.rows} spots were listed`);
      assert.ok(m.marks >= 6, `only ${m.marks} marks were drawn on the garment`);
      assert.equal(m.total, m.rows);
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
        return {
          screen: ${VISIBLE},
          doors: [...document.querySelectorAll(".doors .door")].map(d => d.id),
          featured: document.querySelectorAll("#home-featured .lot").length,
          rows: document.querySelectorAll(".srow").length,
          who: document.getElementById("hero-who").textContent.trim(),
        };
      `);

      assert.deepEqual(m.screen, ["home"], "a visitor with no listing in the URL should land on the front door");
      assert.deepEqual(m.doors, ["door-brand", "door-publisher"],
        "both sides of the market have to be offered, or one of them has no way in");

      /* The old front page opened whichever listing happened to be first,
         which quietly picked a publisher on the visitor's behalf and made the
         other two invisible. Nothing may be loaded until somebody chooses. */
      assert.equal(m.rows, 0, "the front door loaded a listing on its own");
      assert.ok(!/Maya|Roi|Noa/.test(m.who),
        `the campaign screen was filled in behind the door, with "${m.who}"`);

      /* It still has to show that there is something here, though. */
      assert.equal(m.featured, 3, `the door advertised ${m.featured} publishers, not the three that are open`);
      assert.deepEqual(page.errors(), [], `console errors on the front door:\n${page.consoleText()}`);
    });

    it("the directory lists every publisher, and a chip narrows it", async () => {
      const page = await open({ screen: "browse" });

      const names = `[...document.querySelectorAll("#browse-grid .lot h3")].map(h => h.textContent.trim()).sort()`;
      const all = await page.evaluate(`
        ${REVEAL}
        return { screen: ${VISIBLE}, names: ${names},
                 count: document.getElementById("browse-count").textContent };
      `);
      assert.deepEqual(all.screen, ["browse"]);
      assert.deepEqual(all.names, ["Maya & Tal", "Noa Lev", "Roi Avital"],
        "the whole seeded market should be on the directory, not just the first of it");
      assert.equal(all.count, "3 of 3", `the count reads "${all.count}"`);

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
      assert.deepEqual(suits.names, ["Noa Lev", "Roi Avital"], "the suits are Roi's and Noa's");
      assert.equal(suits.count, "2 of 3");
      assert.equal(suits.pressed, "true", "the chip that is filtering does not say so");

      /* Not the same cut as the garment: Noa's suit is a women's one, so she
         is in both lists and Roi is in neither of Maya's. */
      const women = await chip("female");
      assert.deepEqual(women.names, ["Maya & Tal", "Noa Lev"],
        "women's should be the gown plus Noa's suit - it is who is wearing it, not what it is");
      assert.equal(women.count, "2 of 3");

      const back = await chip("all");
      assert.deepEqual(back.names, ["Maya & Tal", "Noa Lev", "Roi Avital"], "the filter did not come off again");
      assert.deepEqual(page.errors(), [], `console errors in the directory:\n${page.consoleText()}`);
    });

    it("opening a card opens that publisher, not the first one on the page", async () => {
      const page = await open({ screen: "browse" });
      const m = await page.evaluate(`
        const lot = [...document.querySelectorAll("#browse-grid .lot")]
          .find(b => b.querySelector("h3").textContent.trim() === "Roi Avital");
        if (!lot) return { error: "Roi Avital has no card in the directory" };
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
      assert.equal(m.who, "Roi Avital",
        `the second card opened "${m.who}" - every card is wired to the same handler, so one of them ` +
        "carrying the wrong id would be invisible until a buyer bid on the wrong garment");
      assert.match(m.where, /Jerusalem/, "the hero is showing somebody else's city");
      assert.ok(m.rows >= 6, `only ${m.rows} spots were listed for this publisher`);
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
      assert.equal(publish.label, "I'm a publisher");
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
      assert.match(m.toasts, /publisher|brand/i);
    });
  });

  /* ==================================================================== */
  describe("the bid sheet", () => {
    /** Sign up as a brand and open the sheet on the first spot. */
    async function atTheSheet(page) {
      await page.evaluate(`${REVEAL} document.querySelector(".srow").click(); await new Promise(r => setTimeout(r, 200)); return true;`);
      await page.evaluate(SIGN_UP("brand", { name: "Buyer", brand: "Acme Tools", email: "b@example.test" }));
      await page.waitFor('!!document.getElementById("bid-max")', 5000, "the bid sheet to open");
    }

    it("tells 'owed if it closed now' apart from 'held on your card'", async () => {
      const page = await open();
      await atTheSheet(page);

      const m = await page.evaluate(`
        const maxEl = document.getElementById("bid-max");
        const floor = Number(maxEl.value);
        maxEl.value = String(floor * 3);
        maxEl.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise(r => setTimeout(r, 100));
        const lines = [...document.querySelectorAll("#bid-quote .ln")].map(ln => ({
          k: ln.querySelector(".k") ? ln.querySelector(".k").textContent.trim() : "",
          v: ln.querySelector(".v") ? ln.querySelector(".v").textContent.trim() : "",
        }));
        return { floor, lines, text: document.getElementById("bid-quote").innerText };
      `);

      const owed = m.lines.find(l => /owed if it closed now/i.test(l.k));
      const held = m.lines.find(l => /held on your card/i.test(l.k));
      assert.ok(owed, `no "Owed if it closed now" line:\n${m.text}`);
      assert.ok(held, `no "Held on your card" line:\n${m.text}`);

      const n = s => Number(String(s).replace(/[^0-9.]/g, ""));
      assert.ok(n(held.v) > n(owed.v),
        `with a maximum of ${m.floor * 3} on a floor of ${m.floor}, the hold (${held.v}) must exceed ` +
        `what is owed (${owed.v}) - conflating the two would be a lie about what is being taken`);

      /* The exact numbers, taken from the shared engine rather than from a
         second implementation written in the test: 1200 * 3 * 1.08 is
         3888.0000000000005 in IEEE 754, which is exactly what Market.quote()
         exists to round. */
      const FEE = 8;
      assert.equal(n(owed.v), Market.quote(m.floor, FEE).total, "owed = the settled price plus the platform fee");
      assert.equal(n(held.v), Market.quote(m.floor * 3, FEE).total, "held = the stated maximum plus the platform fee");
      assert.match(m.text, /only a hold/i, "the gap between the two should be explained, not left to be guessed");
    });

    it("when the maximum IS the settled price the two numbers agree", async () => {
      const page = await open();
      await atTheSheet(page);
      const m = await page.evaluate(`
        const maxEl = document.getElementById("bid-max");
        maxEl.value = maxEl.min;
        maxEl.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise(r => setTimeout(r, 100));
        const txt = document.getElementById("bid-quote").innerText;
        const pick = re => { const m2 = txt.match(re); return m2 ? Number(m2[1].replace(/[^0-9.]/g, "")) : null; };
        return { owed: pick(/Owed if it closed now\\s*\\n?\\s*(\\S+)/i),
                 held: pick(/Held on your card\\s*\\n?\\s*(\\S+)/i),
                 hasHoldNote: /only a hold/i.test(txt) };
      `);
      assert.equal(m.owed, m.held, "at the floor there is no gap, so nothing extra should be held");
      assert.equal(m.hasHoldNote, false, "there is no hold to explain when the two numbers are the same");
    });

    it("refuses a bid below the floor, and says what the floor is", async () => {
      const page = await open();
      await atTheSheet(page);
      const m = await page.evaluate(`
        const maxEl = document.getElementById("bid-max");
        const floor = Number(maxEl.min);
        const out = [];
        for (const v of [String(floor - 1), "1", "0", "-500"]) {
          maxEl.value = v;
          maxEl.dispatchEvent(new Event("input", { bubbles: true }));
          await new Promise(r => setTimeout(r, 60));
          out.push({ tried: v,
                     quote: document.getElementById("bid-quote").innerText.trim(),
                     disabled: document.getElementById("bid-go").getAttribute("aria-disabled") });
        }
        return { floor, out, minAttr: Number(maxEl.min) };
      `);
      assert.equal(m.minAttr, m.floor, "the input's own min should carry the floor");
      for (const attempt of m.out) {
        assert.equal(attempt.disabled, "true",
          `a maximum of ${attempt.tried} against a floor of ${m.floor} left the button live`);
        assert.match(attempt.quote, new RegExp(String(m.floor)),
          `the refusal for ${attempt.tried} did not name the floor: "${attempt.quote}"`);
      }
    });

    it("a refused bid is refused on submit too, not only in the quote", async () => {
      const page = await open();
      await atTheSheet(page);
      const m = await page.evaluate(`
        const maxEl = document.getElementById("bid-max");
        maxEl.value = "1";
        maxEl.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("bid-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 500));
        return { err: document.getElementById("bid-err").hidden ? null : document.getElementById("bid-err").textContent,
                 stillOpen: !document.getElementById("scrim").hidden,
                 raised: document.getElementById("goal-raised").textContent };
      `);
      assert.ok(m.err, "submitting a bid under the floor produced no error");
      assert.equal(m.stillOpen, true, "the sheet closed on a bid that was never placed");
      assert.equal(m.raised, "$0", "a refused bid moved the funding bar");
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
      await page.evaluate(SIGN_UP("brand", { name: "Buyer", brand: "Acme Tools", email: "b@example.test" }));
      await page.waitFor('!!document.getElementById("bid-max")', 5000, "the bid sheet to open");

      const before = await page.evaluate(`
        ${REVEAL}
        return {
          raised: document.getElementById("goal-raised").textContent,
          bar: document.getElementById("goal-bar").style.width,
          open: document.getElementById("goal-open").textContent,
          firstRow: document.querySelector(".srow").textContent.replace(/\\s+/g, " ").trim(),
          wall: document.getElementById("wall").textContent.replace(/\\s+/g, " ").trim(),
          held: document.querySelectorAll(".srow.held").length,
        };
      `);
      assert.equal(before.raised, "$0");
      assert.equal(before.held, 0);
      assert.ok(!before.wall.includes("Acme Tools"));

      const after = await page.evaluate(`
        const maxEl = document.getElementById("bid-max");
        const floor = Number(maxEl.min);
        maxEl.value = String(floor * 2);
        maxEl.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("bid-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 1200));
        ${REVEAL}
        return {
          floor,
          sheetClosed: document.getElementById("scrim").hidden,
          raised: document.getElementById("goal-raised").textContent,
          bar: document.getElementById("goal-bar").style.width,
          open: document.getElementById("goal-open").textContent,
          firstRow: document.querySelector(".srow").textContent.replace(/\\s+/g, " ").trim(),
          wall: document.getElementById("wall").textContent.replace(/\\s+/g, " ").trim(),
          held: document.querySelectorAll(".srow.held").length,
          mineMarks: document.querySelectorAll("#garment-wrap .spot.mine, #garment-wrap .spot.held").length,
          toasts: document.getElementById("toasts").textContent,
        };
      `);

      assert.equal(after.sheetClosed, true, "the sheet stayed up after a successful bid");
      assert.match(after.toasts, /demo mode|authorised|placed/i, "the buyer was not told what happened");

      /* the funding bar */
      assert.notEqual(after.raised, before.raised, "the raised figure did not move");
      assert.match(after.raised, new RegExp(String(after.floor).replace(/(\d)(?=(\d{3})+$)/g, "$1,")),
        `the spot settles at its floor (${after.floor}) for a lone bidder, but the bar reads ${after.raised}`);
      assert.notEqual(after.bar, before.bar, "the meter did not grow");
      assert.equal(Number(after.open), Number(before.open) - 1, "the open-spot count did not drop");

      /* the spot row */
      assert.equal(after.held, 1, "no row is marked as held");
      assert.match(after.firstRow, /Held/i, "the row the bid was placed on does not say it is held");
      assert.match(after.firstRow, /Acme Tools/, "the row does not name who holds it");
      assert.match(after.firstRow, /to take it/i, "a held row should quote what it costs to take it, not its floor");

      /* the wall */
      assert.match(after.wall, /Acme Tools/, "the mark never reached the wall");
      assert.ok(after.mineMarks >= 1, "the mark on the garment was not repainted");
    });

    it("a second, higher bid takes the spot and the price rises", async () => {
      const page = await open();
      const m = await page.evaluate(`
        ${REVEAL}
        return true;
      `);
      await page.evaluate(`${REVEAL} document.querySelector(".srow").click(); await new Promise(r => setTimeout(r, 200)); return true;`);
      await page.evaluate(SIGN_UP("brand", { name: "First", brand: "First Co", email: "first@example.test" }));
      await page.waitFor('!!document.getElementById("bid-max")', 5000, "the bid sheet");

      const first = await page.evaluate(`
        const maxEl = document.getElementById("bid-max");
        const floor = Number(maxEl.min);
        maxEl.value = String(floor * 2);
        maxEl.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("bid-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 1200));
        ${REVEAL}
        return { floor, raised: document.getElementById("goal-raised").textContent };
      `);

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

      assert.ok(out.min > first.floor, "the minimum to take a held spot must exceed its floor");
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
          headline: PAY, names: PAY, tagline: PAY, about: PAY, hashtag: PAY,
          venue: PAY, press: PAY, shooters: PAY,
        });
        const spots = await window.Store.spots.list(id);
        await window.Store.spots.update(spots[0].id, { name: PAY, blurb: PAY, badge: PAY.slice(0, 10) });
        return id;
      `);
      await page.goto(`${ORIGIN}/?l=${encodeURIComponent(listingId)}`, { ready: CAMPAIGN_READY });

      /* …and as a brand name, which reaches the wall and the garment. */
      await page.evaluate(`${REVEAL} document.querySelector(".srow").click(); await new Promise(r => setTimeout(r, 250)); return true;`);
      await page.evaluate(SIGN_UP("brand", { name: "Pwn", brand: XSS, email: "pwn@example.test" }));
      await page.waitFor('!!document.getElementById("bid-max")', 5000, "the bid sheet");
      await page.evaluate(`
        const maxEl = document.getElementById("bid-max");
        maxEl.value = maxEl.min;
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

  /* ==================================================================== */
  describe("the publisher's side", () => {
    it("sign up as a publisher, draw a spot, save it, open bidding, view it as a buyer", async () => {
      const page = await open({ screen: "home" });

      /* 1. an account on the publishing side, taken through the publisher's
         own door on the front page - "Get a spot" is the brand's way in and
         lands in the directory, which would leave this on the wrong side. */
      const user = await page.evaluate(`
        document.getElementById("door-publisher").click();
        await new Promise(r => setTimeout(r, 300));
        ${SIGN_UP("client", { name: "Pub Lisher", email: "publisher@example.test" })}
      `);
      assert.equal(user.role, "client", "the account was not created on the publishing side");

      /* 2. it drops straight into the studio with a listing of its own */
      const studio = await page.evaluate(`
        return {
          screen: ${VISIBLE},
          spots: document.getElementById("studio-spotcount").textContent,
          mine: (await window.Store.listings.mine()).length,
        };
      `);
      assert.deepEqual(studio.screen, ["studio"], "a new publisher was not taken to their studio");
      assert.equal(studio.mine, 1, "no listing was created for the new publisher");
      assert.match(studio.spots, /^0 spots/, `the new listing already had spots: ${studio.spots}`);

      /* 3. drag a rectangle out on the garment */
      const drawn = await page.evaluate(`
        document.getElementById("studio-draw").click();
        await new Promise(r => setTimeout(r, 200));
        const pane = document.querySelector("#studio-garment .garment");
        if (!pane) return { error: "the studio drew no garment to draw on" };
        const r = pane.getBoundingClientRect();
        const at = (fx, fy) => ({ clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, bubbles: true, cancelable: true });
        pane.dispatchEvent(new PointerEvent("pointerdown", at(0.25, 0.25)));
        pane.dispatchEvent(new PointerEvent("pointermove",  at(0.40, 0.35)));
        pane.dispatchEvent(new PointerEvent("pointermove",  at(0.55, 0.45)));
        pane.dispatchEvent(new PointerEvent("pointerup",    at(0.55, 0.45)));
        await new Promise(r2 => setTimeout(r2, 400));
        return { sheetOpen: !document.getElementById("scrim").hidden,
                 title: document.getElementById("sheet-title").textContent,
                 placement: document.querySelector("#sheet-body .quote .v") ? document.querySelector("#sheet-body .quote .v").textContent : null };
      `);
      assert.ok(!drawn.error, drawn.error);
      assert.equal(drawn.sheetOpen, true, "dragging out a rectangle did not open the spot editor");
      assert.match(drawn.title, /spot/i);
      assert.match(drawn.placement || "", /%/, "the placement should be quoted in percentages of the photograph");

      /* 4. name it and save */
      const saved = await page.evaluate(`
        const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
        set("sp-name", "Shoulder Patch");
        set("sp-floor", "450");
        set("sp-blurb", "Sits high and reads in every photograph from the left.");
        document.getElementById("spot-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 800));
        const mine = await window.Store.listings.mine();
        const spots = await window.Store.spots.list(mine[0].id);
        return { sheetClosed: document.getElementById("scrim").hidden,
                 count: document.getElementById("studio-spotcount").textContent,
                 stored: spots.map(s => ({ name: s.name, floor: s.floor, side: s.side,
                                           x: Number(s.x), y: Number(s.y), w: Number(s.w), h: Number(s.h) })) };
      `);
      assert.equal(saved.sheetClosed, true, "the spot editor stayed up after saving");
      assert.match(saved.count, /^1 spot/, `the studio still reads "${saved.count}"`);
      assert.equal(saved.stored.length, 1);
      assert.equal(saved.stored[0].name, "Shoulder Patch");
      assert.equal(Number(saved.stored[0].floor), 450);

      /* Percentages, never pixels - that is what makes a layout drawn on a
         laptop land in the same place on a phone. */
      const box = saved.stored[0];
      for (const k of ["x", "y", "w", "h"]) {
        assert.ok(box[k] >= 0 && box[k] <= 100,
          `${k} is ${box[k]}, which is not a percentage of the photograph - a layout drawn on a ` +
          "laptop would then land somewhere else on a phone");
      }
      assert.ok(box.w > 4 && box.h > 3, `the drawn box is too small to have been accepted: ${box.w} x ${box.h}`);

      /* 5. open the bidding */
      const opened = await page.evaluate(`
        const btn = document.getElementById("terms-open");
        const was = btn.textContent;
        btn.click();
        await new Promise(r => setTimeout(r, 700));
        const mine = await window.Store.listings.mine();
        return { was, now: btn.textContent, isOpen: mine[0].is_open,
                 meta: document.getElementById("studio-meta").textContent };
      `);
      assert.match(opened.was, /open the bidding/i);
      assert.equal(opened.isOpen, true, "the listing did not open");
      assert.match(opened.now, /close the bidding/i, "the button did not flip to its opposite");
      assert.match(opened.meta, /bidding open/i);

      /* 6. view it as a buyer */
      const asBuyer = await page.evaluate(`
        document.getElementById("studio-view").click();
        await new Promise(r => setTimeout(r, 600));
        ${REVEAL}
        return { screen: ${VISIBLE},
                 rows: document.querySelectorAll(".srow").length,
                 list: document.getElementById("spotlist").textContent.replace(/\\s+/g, " ").trim(),
                 marks: document.querySelectorAll("#garment-wrap .spot").length,
                 goal: document.getElementById("goal-total").textContent };
      `);
      assert.deepEqual(asBuyer.screen, ["campaign"], "'view as a buyer' did not leave the studio");
      assert.equal(asBuyer.rows, 1, "the buyer's page does not list the spot that was just drawn");
      assert.match(asBuyer.list, /Shoulder Patch/);
      assert.match(asBuyer.list, /\$450/, "the floor the publisher set is not what a buyer is quoted");
      assert.equal(asBuyer.marks, 1, "the spot was not drawn onto the garment");
      assert.equal(asBuyer.goal, "1");

      assert.deepEqual(page.errors(), [], `console errors during the publisher flow:\n${page.consoleText()}`);
    });

    it("bidding cannot be opened on a garment with no spots on it", async () => {
      const page = await open({ screen: "home" });
      const m = await page.evaluate(`
        document.getElementById("nav-publish").click();
        await new Promise(r => setTimeout(r, 300));
        ${SIGN_UP("client", { name: "Empty Pub", email: "empty@example.test" })}
      `);
      assert.equal(m.role, "client");

      const out = await page.evaluate(`
        document.getElementById("terms-open").click();
        await new Promise(r => setTimeout(r, 500));
        const mine = await window.Store.listings.mine();
        return { isOpen: mine[0].is_open, toasts: document.getElementById("toasts").textContent };
      `);
      assert.equal(out.isOpen, false, "a garment with nothing marked out on it went on sale");
      assert.match(out.toasts, /spot/i);
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
        return { listing: listings[0].id, spot: spots[2].id, name: spots[2].name };
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
