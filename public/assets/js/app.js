/* =========================================================================
   Square Inch - the application.

   Five screens behind one page:

     home      the front door, where you say which side of the table you are on
     browse    the directory of every publisher taking bids
     campaign  one publisher's garment, which is what a brand actually buys from
     auth      opening an account
     studio    the publisher's own side of it

   Everything below assumes a phone first; the desktop layout is what the CSS
   adds on top, not the other way round.
   ========================================================================= */
"use strict";

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* --------------------------------------------------- the two sides, spoken
   The stored role values are "client" and "brand", frozen on first choice by
   a database trigger, so they cannot be renamed. Every word the reader sees
   for a role comes from here instead - which is the only thing that stops the
   display drifting from the value underneath it. */
const SIDE = { client: "wearer", brand: "sponsor" };
const Side = role => SIDE[role].charAt(0).toUpperCase() + SIDE[role].slice(1);

/* ------------------------------------------------------------------ state */
const state = {
  screen: "home",
  listing: null,
  spots: [],
  bids: [],
  side: "front",
  studioSide: "front",
  selected: null,
  arming: false,
  unsubscribe: null,
  /* the directory: every open listing, and which facet is being shown */
  directory: [],
  filter: "all",
};

/* ------------------------------------------------------------- formatting */
const CUR = () => (Store.config.currency || "usd").toUpperCase();
function money(n, opts = {}) {
  const v = Number(n) || 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency: CUR(),
      minimumFractionDigits: opts.cents ? 2 : 0,
      maximumFractionDigits: opts.cents ? 2 : 0,
    }).format(v);
  } catch { return "$" + v.toFixed(opts.cents ? 2 : 0); }
}
const num = n => new Intl.NumberFormat().format(Math.round(Number(n) || 0));
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + "s")}`;

/* The fee is the platform's, not the publisher's, so it is read from the
   config the server sends and never from the listing row. */
const feePercent = () => Number(Store.config.feePercent) || 0;
/* "A 8% fee" reads as a typo. The article follows how the number is SAID, so
   it is the leading digits that decide it: eight, eighteen, eleven. */
const article = n => (/^(8|11|18)/.test(String(n)) ? "An" : "A");

/* ---------------------------------------------------------- local clocks
   An <input type="datetime-local"> holds LOCAL wall-clock time, by
   definition. Filling one from `toISOString()` puts a UTC wall clock in it,
   which the browser then reads back as local - so Save moved the close by
   the browser's offset, and because the shifted value was written back and
   filled in again on the next render, every Save moved it again. Two saves
   from London in summer is two hours; from Sydney it is twenty.

   The fix is here and only here. The save path does `new Date(value)`, which
   is correct the moment the field genuinely holds local time; correcting
   both sides would cancel out and put the drift straight back. */
const MIN_LEAD_MS = 3600000;                 // an hour, so a last bid can be answered

function localInputValue(when) {
  const d = when == null ? null : new Date(when);
  if (!d || Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

/* Whose clock the field is keeping. The input never says, and a publisher
   setting the moment their campaign ends should not have to guess. */
function localZoneName() {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (z) return z;
  } catch { /* fall through to the offset */ }
  const off = -new Date().getTimezoneOffset();
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/* Everything that reaches innerHTML goes through this. User-supplied brand
   names and blurbs are rendered all over the page; none of them are trusted. */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
/* A URL that is safe to put in src=. Blocks javascript: and data: text.

   Root-relative paths under /assets/ are allowed so a listing can point at a
   photograph we ship ourselves. It must be a single leading slash: `//evil.com`
   is protocol-relative and would load off another origin entirely. */
function safeUrl(u) {
  const s = String(u || "").trim();
  if (/^\/assets\/[A-Za-z0-9._\-/]+$/.test(s) && !s.includes("..")) return s;
  if (/^(https?:|blob:)/i.test(s)) return s;
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(s)) return s;
  return "";
}

/* ----------------------------------------------------------------- toasts */
function toast(text, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.innerHTML = `<span class="dot"></span><span>${esc(text)}</span>`;
  $("#toasts").append(el);
  setTimeout(() => {
    el.style.transition = "opacity .3s, transform .3s";
    el.style.opacity = "0"; el.style.transform = "translateY(8px)";
    setTimeout(() => el.remove(), 320);
  }, 4200);
}

/* ------------------------------------------------------------- refusing a field
   Every form on this page used to refuse the same way: write a sentence into
   an `.err` block and stop. Nothing marked the field, nothing moved to it,
   and a screen reader was never told the block had appeared - so on a form
   as long as the publisher's terms the refusal could be a screen and a half
   above whatever the person was looking at, and the only clue that Save had
   done nothing was that nothing happened.

   One helper, used by all of them. The message, the red border, the scroll
   and the focus travel together, and the whole lot clears on the next
   keystroke, because a field still marked wrong while it is being fixed is
   telling somebody about a mistake they have already corrected.

   Returns false so a caller can write `return fail(el, "…")` in one line. */
function fail(el, msg, box) {
  /* Unhide before writing: a role="alert" region that is revealed and filled
     in the same breath is announced, one that is filled while hidden is not. */
  if (box) { box.hidden = false; box.textContent = msg; }

  if (!el) return false;

  const host = el.closest(".fld") || el.parentElement;
  let note = null;
  if (!box && host) {
    note = $(".fld-err", host);
    if (!note) {
      note = document.createElement("p");
      note.className = "fld-err";
      note.id = (el.id || "fld") + "-err";
      host.append(note);
    }
    note.textContent = msg;
    /* Described by, not merely near: focus is about to land on the field, and
       this is what makes the reason audible when it does. */
    const d = (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    if (!d.includes(note.id)) el.setAttribute("aria-describedby", d.concat(note.id).join(" "));
  }

  el.setAttribute("aria-invalid", "true");
  el.scrollIntoView({ block: "center" });
  el.focus();

  el.addEventListener("input", function cleared() {
    el.removeAttribute("aria-invalid");
    if (box) box.hidden = true;
    if (note) {
      const d = (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(x => x && x !== note.id);
      if (d.length) el.setAttribute("aria-describedby", d.join(" "));
      else el.removeAttribute("aria-describedby");
      note.remove();
    }
  }, { once: true });

  return false;
}

/* ------------------------------------------------------------------ sheet */
/* Remembered as a SELECTOR, not a node: the spot list re-renders while the
   sheet is open, so the element that opened it is usually detached by the
   time we try to hand focus back, and .focus() on a detached node silently
   does nothing. */
let lastFocusSel = null;

const OUTSIDE = "header.topbar, main, footer.foot, .actionbar";

function openSheet({ kicker = "", title, body, onOpen }) {
  const active = document.activeElement;
  lastFocusSel = active && active.dataset && active.dataset.spot
    ? `[data-spot="${CSS.escape(active.dataset.spot)}"]`
    : (active && active.id ? "#" + CSS.escape(active.id) : null);

  $("#sheet-kicker").textContent = kicker;
  $("#sheet-title").textContent = title;
  $("#sheet-body").innerHTML = body;
  const scrim = $("#scrim");
  scrim.hidden = false;
  requestAnimationFrame(() => scrim.classList.add("open"));
  document.body.style.overflow = "hidden";

  /* Everything behind the dialog is inert, so neither Tab nor a screen
     reader's virtual cursor can wander out of it. */
  $$(OUTSIDE).forEach(el => { el.inert = true; });

  if (onOpen) onOpen($("#sheet-body"));

  /* Focus goes in on every screen size. Gating this on a min-width meant the
     dialog opened on a phone with focus still on the button behind it, which
     also stopped the focus trap from ever seeing a keystroke. */
  const first = $("#sheet-body input, #sheet-body button, #sheet-body select, #sheet-body textarea");
  if (first) first.focus();
  else { const sheet = $("#sheet"); sheet.tabIndex = -1; sheet.focus(); }
}

function closeSheet() {
  if (chatStop) { clearInterval(chatStop); chatStop = null; }   // the chat poll dies with its sheet
  const scrim = $("#scrim");
  scrim.classList.remove("open");
  document.body.style.overflow = "";
  $$(OUTSIDE).forEach(el => { el.inert = false; });
  setTimeout(() => { scrim.hidden = true; $("#sheet-body").innerHTML = ""; }, 240);

  const back = lastFocusSel && $(lastFocusSel);
  (back || $("#spotlist") || document.body).focus?.();
  lastFocusSel = null;
}
$("#sheet-x").addEventListener("click", closeSheet);
$("#scrim").addEventListener("click", e => { if (e.target.id === "scrim") closeSheet(); });
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !$("#scrim").hidden) closeSheet();
});
/* Keep tab focus inside the sheet while it is up. Bound to the document, not
   to the scrim: a handler on the scrim only fires once focus is already
   inside it, which is exactly the case it is supposed to guarantee. */
document.addEventListener("keydown", e => {
  if (e.key !== "Tab" || $("#scrim").hidden) return;
  const f = $$("#sheet button, #sheet input, #sheet select, #sheet textarea, #sheet a[href]")
    .filter(el => !el.disabled && el.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

/* =========================================================================
   the garment
   A photograph when the publisher has uploaded one, a drawn silhouette when
   they have not - so a listing is legible from the moment it is created.
   ========================================================================= */
const SILHOUETTE = {
  "gown-female": {
    front: `<path d="M112 58 L188 58 L178 168 C178 168 250 244 254 384 L46 384 C50 244 122 168 122 168 Z"/>
            <path d="M138 58 Q150 84 162 58" fill="none" stroke-width="2" opacity=".45"/>
            <path d="M150 168 L150 384" fill="none" stroke-width="1.5" opacity=".2"/>`,
    back:  `<path d="M112 58 L188 58 L178 168 C178 168 250 244 254 384 L46 384 C50 244 122 168 122 168 Z"/>
            <path d="M150 58 L150 168" fill="none" stroke-width="2" opacity=".45"/>
            <path d="M126 92 Q150 104 174 92" fill="none" stroke-width="1.5" opacity=".3"/>`,
  },
  /* a floor-length coat rather than a dress, so a man listing a "gown" still
     gets a drawing that looks like the thing he is going to wear */
  "gown-male": {
    front: `<path d="M104 60 L196 60 L206 154 L198 380 L102 380 L94 154 Z"/>
            <path d="M150 60 L128 130 L150 196 L172 130 Z" fill="none" stroke-width="2" opacity=".45"/>
            <path d="M150 196 L150 380" fill="none" stroke-width="1.5" opacity=".2"/>`,
    back:  `<path d="M104 60 L196 60 L206 154 L198 380 L102 380 L94 154 Z"/>
            <path d="M150 60 L150 380" fill="none" stroke-width="2" opacity=".35"/>
            <path d="M108 118 L192 118" fill="none" stroke-width="1.5" opacity=".25"/>`,
  },
  /* The jacket hem and the sleeve seams are what stop a suit reading as a
     jumpsuit - without them the outline is one unbroken shape from shoulder
     to ankle and nobody can tell where the jacket ends. */
  "suit-male": {
    front: `<path d="M96 62 L204 62 L214 196 L198 384 L156 384 L150 236 L144 384 L102 384 L86 196 Z"/>
            <path d="M86 196 L214 196" fill="none" stroke-width="1.5" opacity=".4"/>
            <path d="M114 64 L104 194 M186 64 L196 194" fill="none" stroke-width="1.5" opacity=".3"/>
            <path d="M150 62 L132 130 L150 200 L168 130 Z" fill="none" stroke-width="2" opacity=".45"/>
            <path d="M150 236 L150 384" fill="none" stroke-width="1.5" opacity=".25"/>`,
    back:  `<path d="M96 62 L204 62 L214 196 L198 384 L156 384 L150 236 L144 384 L102 384 L86 196 Z"/>
            <path d="M86 196 L214 196" fill="none" stroke-width="1.5" opacity=".4"/>
            <path d="M114 64 L104 194 M186 64 L196 194" fill="none" stroke-width="1.5" opacity=".3"/>
            <path d="M150 62 L150 196" fill="none" stroke-width="2" opacity=".3"/>
            <path d="M104 112 L196 112" fill="none" stroke-width="1.5" opacity=".25"/>`,
  },
  /* narrower shoulders, a waist, a longer line through the leg */
  "suit-female": {
    front: `<path d="M108 62 L192 62 L200 150 L192 208 L188 384 L154 384 L150 240 L146 384 L112 384 L108 208 L100 150 Z"/>
            <path d="M104 186 L196 186" fill="none" stroke-width="1.5" opacity=".4"/>
            <path d="M122 64 L112 184 M178 64 L188 184" fill="none" stroke-width="1.5" opacity=".3"/>
            <path d="M150 62 L134 124 L150 190 L166 124 Z" fill="none" stroke-width="2" opacity=".45"/>
            <path d="M150 240 L150 384" fill="none" stroke-width="1.5" opacity=".25"/>`,
    back:  `<path d="M108 62 L192 62 L200 150 L192 208 L188 384 L154 384 L150 240 L146 384 L112 384 L108 208 L100 150 Z"/>
            <path d="M104 186 L196 186" fill="none" stroke-width="1.5" opacity=".4"/>
            <path d="M122 64 L112 184 M178 64 L188 184" fill="none" stroke-width="1.5" opacity=".3"/>
            <path d="M150 62 L150 186" fill="none" stroke-width="2" opacity=".3"/>
            <path d="M110 110 L190 110" fill="none" stroke-width="1.5" opacity=".25"/>`,
  },
};

/* What the publisher is wearing, normalised. Older listings predate the
   column, so a gown reads as women's and a suit as men's unless told. */
function wornBy(L) {
  const w = String((L && L.wears) || "").toLowerCase();
  if (w === "male" || w === "female") return w;
  return (L && L.garment) === "suit" ? "male" : "female";
}
const GARMENT_WORD = { gown: "gown", suit: "suit" };
function garmentWord(L) {
  return GARMENT_WORD[L && L.garment] || "garment";
}

function silhouetteSvg(garment, side, wears) {
  const key = `${GARMENT_WORD[garment] || "gown"}-${wears === "male" ? "male" : "female"}`;
  const g = SILHOUETTE[key] || SILHOUETTE["gown-female"];
  return `<svg viewBox="0 0 300 420" role="img" aria-label="${esc(garment)}, ${esc(side)}">
    <g fill="rgba(20,18,14,.05)" stroke="rgba(20,18,14,.34)" stroke-width="1.5"
       stroke-linejoin="round">${g[side] || g.front}</g></svg>`;
}

/* One panel: the picture plus every spot on that side. It defaults to the
   listing on screen, but takes an explicit one so the front door can show a
   real listing without the campaign screen being the one loaded. */
function garmentPanel(side, opts = {}) {
  const {
    listing: L = state.listing,
    spots: allSpots = state.spots,
    bids: allBids = state.bids,
    interactive = true,
    showPending = false,
  } = opts;
  if (!L) return "";
  const photo = safeUrl(L["photo_" + side]);
  const bySpot = Store.bids.bySpot(allBids);
  /* A spot the publisher has not accepted is not on the garment. The studio
     passes showPending so the owner can see what is waiting on them. */
  const spots = allSpots.filter(s =>
    !s.declined && s.side === side && (showPending || s.approved !== false));

  const art = photo
    ? `<img src="${esc(photo)}" alt="The ${esc(garmentWord(L))}, ${esc(side)}" loading="lazy" decoding="async">`
    : silhouetteSvg(L.garment, side, wornBy(L)) +
      `<div class="empty"><p class="lbl">No photograph yet</p>
         <p>Spots are marked out on the drawing until one is uploaded.</p></div>`;

  const marks = spots.map(s => {
    const settled = Store.market(s, bySpot[s.id]);
    const mine = Store.auth.current() && settled.holder === Store.auth.current().id;
    const cls = ["spot",
      settled.holder ? (mine ? "mine" : "held") : "",
      s.badge === "MEGA" ? "featured" : "",
      state.selected === s.id ? "sel" : "",
      settled.holderLogo ? "has-logo" : ""].filter(Boolean).join(" ");
    const logo = safeUrl(settled.holderLogo);
    return `<button class="${cls}" data-spot="${esc(s.id)}"
        style="top:${+s.y}%;left:${+s.x}%;width:${+s.w}%;height:${+s.h}%"
        ${interactive ? "" : "disabled"}
        aria-label="Spot ${+s.n} ${esc(s.name)}, ${settled.holder ? "held at" : "floor"} ${money(settled.price)}">
      ${logo ? `<img class="logo" src="${esc(logo)}" alt="${esc(settled.holderName || "")}">` : ""}
      <span class="n">${String(+s.n).padStart(2, "0")}</span>
      <span class="p">${money(settled.price)}</span>
    </button>`;
  }).join("");

  return `<div>
    <div class="garment${photo ? " photo" : ""}" data-side="${side}">
      ${art}<span class="side-tag">${side}</span>${marks}
    </div>
  </div>`;
}

function renderGarment(force = false) {
  const wrap = $("#garment-wrap");
  /* A rectangle on the cloth - one being dragged, or one that was refused and
     is still carrying its reason - stops a BACKGROUND redraw. The listing is
     re-read every four seconds, and that redraw detached the pane out from
     under a finger mid-drag and deleted a refusal a second after it appeared,
     which is most of why a refused drag seemed to vanish on its own. Nothing
     has to be remembered to know this: the draft is in the DOM. Anything the
     reader asked for - the side toggle, the draw toggle, a resize - passes
     force and redraws regardless. */
  if (!force && $(".spot-draft", wrap)) return;
  /* Wide enough for both panels side by side, and then the front/back toggle
     has nothing left to toggle, so it goes away. */
  const both = window.matchMedia("(min-width:680px)").matches;
  wrap.className = "garment-wrap" + (both ? " both" : "");
  $("#side-toggle").hidden = both;
  wrap.innerHTML = both
    ? garmentPanel("front") + garmentPanel("back")
    : garmentPanel(state.side);

  $$("#garment-wrap .spot").forEach(b =>
    b.addEventListener("click", () => selectSpot(b.dataset.spot, true)));

  /* Every panel on screen is drawable. The refusal is checked on release
     rather than here, so somebody who is not signed in still gets the drag
     and then a reason, instead of a photograph that quietly ignores them. */
  /* Drawing is armed, not always on. See the note on .drawable in the CSS:
     a permanently drawable panel cannot be scrolled past on a phone. */
  $$("#garment-wrap .garment").forEach(pane => {
    if (!state.arming) return;
    pane.classList.add("drawable");
    /* Arming is NOT dropped here. It used to be, before `claimBox` had even
       looked at the box, so a refused drag also switched drawing off and the
       brand had to hunt for the toggle again to try the thing it had just
       been told to do differently. `claimBox` disarms itself at the one
       moment it is right to: when the bid sheet actually opens. Whatever it
       returns is the reason it would not, and goes back to the drag. */
    wireDrawing(pane, box => claimBox(box));
  });
  syncDrawToggle();
}

/* =========================================================================
   campaign screen - one publisher's garment
   ========================================================================= */

/* "Women's gown", "men's suit" - the two facts a brand skims for. */
function garmentLabel(L) {
  return `${wornBy(L) === "male" ? "Men's" : "Women's"} ${garmentWord(L)}`;
}

/* What the public page is allowed to see. A spot the publisher has not yet
   accepted holds a brand's money but has no place on the garment, in the
   spot list, in the goal, or in the count of what is still open. */
const approvedSpots = () => state.spots.filter(s => s.approved !== false && !s.declined);

function renderCampaign() {
  const L = state.listing;
  if (!L) return;
  const bySpot = Store.bids.bySpot(state.bids);
  const c = Store.campaign(approvedSpots(), bySpot, L.goal);

  /* hero ------------------------------------------------------------- */
  $("#hero-kicker").textContent = L.is_open
    ? [`Live`, garmentLabel(L).toLowerCase(), L.city].filter(Boolean).join(" · ")
    : "Bidding has not opened yet";
  $("#hero-h1").innerHTML = L.headline
    ? esc(L.headline)
    : `Walking billboard <em>for your mark</em>`;
  $("#hero-lead").textContent = L.tagline ||
    `Your logo on ${L.names || "the garment"}, worn all day, in every photograph taken.`;

  $("#hero-avatar").textContent = (L.names || "?").trim()[0] || "?";
  $("#hero-who").textContent = L.names || "The wearer";
  $("#hero-where").textContent =
    [garmentLabel(L), L.city, L.event_date].filter(Boolean).join(" · ");

  /* goal ------------------------------------------------------------- */
  $("#goal-raised").textContent = money(c.raised);
  $("#goal-target").textContent = money(c.goal);
  $("#goal-open").textContent = c.open;
  $("#goal-total").textContent = c.total;
  $("#goal-total-word").textContent = c.total === 1 ? "sponsor on board" : "sponsors on board";
  requestAnimationFrame(() => { $("#goal-bar").style.width = (c.pct * 100).toFixed(1) + "%"; });
  $("#goal-refund").textContent = c.met
    ? "Goal reached — this is going ahead"
    : "Every hold is released if the goal is not reached";
  $("#perks-h2").textContent = L.names
    ? `What ${L.names} are offering`
    : "What the wearer is offering";
  $("#garment-pill").innerHTML = L.is_open
    ? `<span class="beat"></span> Live`
    : `Not open`;

  renderGarment();
  renderSpotList(bySpot);
  renderFeature();
  renderWall(bySpot);
  renderEventCard(c);
  renderAbout();
  renderSocial();
  tickClock();
}

/* the list of spots, grouped front then back */
function renderSpotList(bySpot) {
  const sides = ["front", "back"];
  const html = sides.map(side => {
    const rows = approvedSpots().filter(s => s.side === side);
    if (!rows.length) return "";
    return `<div class="side-hd"><p class="lbl">${side} of the ${esc(garmentWord(state.listing))}</p>
              <span class="pill">${rows.length} spot${rows.length === 1 ? "" : "s"}</span></div>` +
      rows.map(s => {
        const st = Store.market(s, bySpot[s.id]);
        const min = Store.minimum(s, bySpot[s.id]);
        return `<button class="srow ${st.holder ? "held" : ""}" data-spot="${esc(s.id)}">
          <span class="no">${String(+s.n).padStart(2, "0")}</span>
          <span class="nm">${esc(s.name)}
            ${s.badge ? `<span class="pill gold">${esc(s.badge)}</span>` : ""}
            ${st.holder ? `<span class="pill live">Held</span>` : `<span class="pill">Open</span>`}</span>
          <span class="price">
            <span class="v">${money(st.holder ? min : st.price)}</span>
            <span class="s">${st.holder ? "to take it" : "floor"}</span>
          </span>
          <span class="blurb">${esc(s.blurb || "")}</span>
          ${st.holder ? `<span class="who">Held by ${esc(st.holderName || `a ${SIDE.brand}`)} at ${money(st.price)}</span>` : ""}
        </button>`;
      }).join("");
  }).join("");

  $("#spotlist").innerHTML = html ||
    `<div class="empty-state"><h3>Nothing claimed yet</h3>
     <p>Every inch of this one is still going. Drag a box out on the garment above and it is yours.</p></div>`;
  $$("#spotlist .srow").forEach(b =>
    b.addEventListener("click", () => openBid(b.dataset.spot)));
}

/* =========================================================================
   the rate card

   The page used to argue for one standout rectangle, because the publisher had
   drawn a menu and one item on it was the expensive one. There is no menu now.
   What a brand needs instead is the arithmetic - the rate, the premium on the
   front, and three worked examples at sizes they can picture.
   ========================================================================= */
function renderFeature() {
  const L = state.listing;
  if (!L) { $("#feature-wrap").hidden = true; return; }
  $("#feature-wrap").hidden = false;

  const examples = [
    { label: "A small mark", side: "back", w: 11, h: 8,
      note: "About the size of a pocket badge." },
    { label: "Across the chest", side: "front", w: 20, h: 9,
      note: "The one that lands in every photograph taken head-on." },
    { label: "The whole back panel", side: "back", w: 26, h: 16,
      note: "The largest clean area on most garments, and the cheapest by the inch." },
  ];

  const rows = examples.map(e => `<tr>
    <td data-k="Size"><b>${esc(e.label)}</b><br><span class="hint">${esc(e.note)}</span></td>
    <td data-k="Where">${esc(e.side)}</td>
    <td data-k="Area" class="num">${areaOf(e).toFixed(1)}%</td>
    <td data-k="Costs" class="num" style="text-align:end"><b>${money(boxPrice(e, L))}</b></td>
  </tr>`).join("");

  $("#feature").innerHTML = `
    <p class="lbl">What it costs</p>
    <h2 style="margin-top:10px">${money(rateOf(L))} for <em>one percent</em> of the ${esc(garmentWord(L))}</h2>
    <p class="lead" style="margin-top:14px">
      You draw the rectangle; its area sets the price. Anything on the front carries a
      ×${frontMultiplierOf(L)} premium, because that is the side the cameras are pointed at.
      ${/* "Nothing else is added" was not survivable: against a real database the
            bid sheet cannot show a single fee figure, so the one place the fee
            was promised to appear was the one place it did not. Say the number
            here instead, read from the config the server sends. */""}
      ${article(feePercent())} ${esc(String(feePercent()))}% platform fee is added at checkout.
    </p>
    <div class="tbl-scroll" style="margin-top:26px">
      <table class="tbl">
        <thead><tr><th>Size</th><th>Where</th><th>Area</th><th style="text-align:end">Costs</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="display:flex;gap:11px;flex-wrap:wrap;margin-top:26px">
      <button class="btn" id="feature-go">Draw your own</button>
      <button class="btn ghost" id="feature-share">Share this</button>
    </div>`;

  $("#feature-go").addEventListener("click", () => {
    setArming(true);
    if (state.arming) $("#garment-wrap").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  $("#feature-share").addEventListener("click", () => openShare(null));
}

/* wall of marks */
function renderWall(bySpot) {
  const held = approvedSpots()
    .map(s => ({ s, st: Store.market(s, bySpot[s.id]) }))
    .filter(x => x.st.holder);

  const slots = held.map(({ st }) => {
    const logo = safeUrl(st.holderLogo);
    return `<div class="slot">${logo
      ? `<img src="${esc(logo)}" alt="${esc(st.holderName || "Sponsor")}" loading="lazy">`
      : `<b>${esc(st.holderName || "Sponsor")}</b>`}</div>`;
  });

  const blanks = Math.max(0, Math.min(6, approvedSpots().length - held.length));
  for (let i = 0; i < blanks; i++) slots.push(`<div class="slot blank">Open</div>`);

  $("#wall").innerHTML = slots.length ? slots.join("")
    : `<div class="slot blank" style="grid-column:1/-1;aspect-ratio:auto;padding:34px">Nobody yet. Be the first mark on it.</div>`;
}

/* The day itself. Four figures rather than the full arithmetic - the workings
   are one tap away in the sheet, which keeps the page from turning into a
   spreadsheet for the nine readers in ten who only want the headline. */
function renderEventCard(c) {
  const L = state.listing;
  const a = audience(L);
  const cpm = a.total > 0 ? (c.raised / a.total) * 1000 : 0;

  const figures = [
    ["In the room", num(L.confirmed || 0), "confirmed guests"],
    ["Impressions", num(a.total), "conservatively"],
    ["Cost per thousand", money(cpm, { cents: true }), "at today's prices"],
    /* Not "N of M spots open". A spot only exists here because a brand drew
       it and bid on it, so `c.open` is structurally zero and the figure read
       "0/3 still unclaimed" on a garment with plenty of bare cloth left. */
    ["Sponsors on board", num(c.total), c.total ? "room for more" : "nothing drawn yet"],
  ];

  $("#event-card").innerHTML = `
    <p class="lbl">The day</p>
    <h2 style="margin-top:10px">${esc(L.venue || "The day itself")}${L.city ? ` · ${esc(L.city)}` : ""}</h2>
    <p class="lead" style="margin-top:14px">
      ${esc(String(L.confirmed || 0))} confirmed of ${esc(String(L.invited || 0))} invited.${L.livestream ? " It is being livestreamed." : ""}
    </p>
    <div class="stats" style="margin-top:26px;margin-bottom:0">
      ${figures.map(([k, v, d]) =>
        `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="d">${esc(d)}</div></div>`).join("")}
    </div>
    <div class="chips" style="margin-top:22px">
      <button class="btn ghost sm" id="event-workings">How that is worked out</button>
    </div>`;

  $("#event-workings").addEventListener("click", () => openSheet({
    kicker: "The audience",
    title: "Where the impressions come from",
    body: `
      <div class="quote">
        <div class="ln"><span class="k">In the room — ${num(L.confirmed || 0)} guests × 12 exposures across the day</span>
          <span class="v">${num(a.inRoom)}</span></div>
        <div class="ln"><span class="k">Social and the gallery — ${num(L.reach || 0)} reach × the 15% that actually surfaces</span>
          <span class="v">${num(a.social)}</span></div>
        ${a.livestream ? `<div class="ln"><span class="k">Livestream</span><span class="v">${num(a.livestream)}</span></div>` : ""}
        <div class="ln tot"><span class="k">Total, deliberately conservative</span><span class="v">${num(a.total)}</span></div>
        <div class="ln tot"><span class="k">Cost per thousand at the current clearing price</span>
          <span class="v">${money(cpm, { cents: true })}</span></div>
      </div>
      <p class="hint" style="margin-top:16px">Every multiplier above is deliberately pessimistic. We would
        rather a sponsor be pleasantly surprised than sold a number we cannot stand behind.</p>`,
  }));
}

function audience(L) {
  const inRoom = (Number(L.confirmed) || 0) * 12;
  const social = Math.round((Number(L.reach) || 0) * 0.15);
  const livestream = L.livestream ? Math.round((Number(L.reach) || 0) * 0.05) : 0;
  return { inRoom, social, livestream, total: inRoom + social + livestream };
}

function renderAbout() {
  const L = state.listing;
  $("#about-card").innerHTML = `
    <div class="avatar lg">${esc((L.names || "?").trim()[0] || "?")}</div>
    <div style="flex:1 1 320px">
      <p class="lbl">About</p>
      <h2 style="margin-top:8px">${esc(L.names || "The wearer")}</h2>
      <p class="lead" style="margin-top:14px">${esc(L.about || "")}</p>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:18px">
        <button class="btn ghost sm" id="about-chat">Ask a question</button>
        <div class="social">${socialLinks(L)}</div>
      </div>
    </div>`;
  $("#about-chat").addEventListener("click", openChat);
}

/* =========================================================================
   chat - one room per listing
   Realtime when there is a database behind it, a poll when there is not.
   ========================================================================= */
let chatStop = null;

function openChat() {
  const L = state.listing;
  const user = Store.auth.current();

  openSheet({
    kicker: "Questions",
    /* not esc()'d: openSheet assigns the title with textContent, so escaping
       here would show a literal &amp; to the reader */
    title: `Ask ${L.names || "the wearer"}`,
    body: `
      <div id="chat-log" style="max-height:44vh;overflow-y:auto;display:grid;gap:10px;
                                padding:4px 2px;overscroll-behavior:contain"></div>
      ${user ? `
        <form id="chat-form" style="display:flex;gap:9px;margin-top:16px">
          <input class="inp" id="chat-text" type="text" maxlength="400" required
                 placeholder="Ask about reach, printing, the day…" autocomplete="off">
          <button class="btn" type="submit" style="flex:none;padding-inline:18px">Send</button>
        </form>`
      : `<button class="btn wide" id="chat-signin" style="margin-top:16px">Sign in to ask</button>`}
      <p class="hint" style="margin-top:10px">Everyone bidding on this garment can see these.</p>`,

    onOpen(root) {
      const log = $("#chat-log", root);

      const paint = rows => {
        log.innerHTML = rows.length ? rows.map(m => {
          const meName = user && (m.author === user.id || m.who === (user.brand || user.name));
          return `<div class="bubble${meName ? " me" : ""}">
            <div class="lbl">${esc(m.display_name || m.who || "someone")}${m.role === "client" ? ` · ${SIDE.client}` : ""}</div>
            <div class="msg">${esc(m.body || m.text || "")}</div>
          </div>`;
        }).join("") : `<p class="hint" style="text-align:center;padding:20px">No questions yet. Ask the first one.</p>`;
        log.scrollTop = log.scrollHeight;
      };

      const pull = async () => {
        try { paint(await Store.chat.list(L.id)); }
        catch (e) { console.warn("chat:", e.message); }
      };
      pull();
      /* The sheet is short-lived, so a 4s poll is cheaper than a subscription. */
      chatStop = setInterval(pull, 4000);

      const form = $("#chat-form", root);
      if (form) form.addEventListener("submit", async e => {
        e.preventDefault();
        const input = $("#chat-text", root);
        const text = input.value.trim();
        if (!text) return;
        input.value = "";
        try { await Store.chat.send(L.id, text); await pull(); }
        catch (e2) { toast(e2.message, "bad"); input.value = text; }
      });

      const si = $("#chat-signin", root);
      if (si) si.addEventListener("click", () => { closeSheet(); go("auth", { role: "brand" }); });
    },
  });
}

/* ------------------------------------------------------------ social bits */
const ICON = {
  x: `<svg viewBox="0 0 24 24"><path d="M18.9 2H22l-7 8 8.2 12h-6.4l-5-7.3L5.9 22H2.8l7.5-8.6L2.4 2h6.6l4.5 6.7L18.9 2Zm-1.1 18h1.7L7.3 3.8H5.5L17.8 20Z"/></svg>`,
  ig: `<svg viewBox="0 0 24 24"><path d="M12 2.2c3.2 0 3.6 0 4.9.1 1.2.1 1.8.3 2.2.4.6.2 1 .5 1.4.9.4.4.7.8.9 1.4.2.4.4 1 .4 2.2.1 1.3.1 1.7.1 4.9s0 3.6-.1 4.9c-.1 1.2-.3 1.8-.4 2.2-.2.6-.5 1-.9 1.4-.4.4-.8.7-1.4.9-.4.2-1 .4-2.2.4-1.3.1-1.7.1-4.9.1s-3.6 0-4.9-.1c-1.2-.1-1.8-.3-2.2-.4-.6-.2-1-.5-1.4-.9-.4-.4-.7-.8-.9-1.4-.2-.4-.4-1-.4-2.2C2.2 15.6 2.2 15.2 2.2 12s0-3.6.1-4.9c.1-1.2.3-1.8.4-2.2.2-.6.5-1 .9-1.4.4-.4.8-.7 1.4-.9.4-.2 1-.4 2.2-.4C8.4 2.2 8.8 2.2 12 2.2Zm0 1.9c-3.1 0-3.5 0-4.7.1-1.1.1-1.7.2-2.1.4-.5.2-.9.4-1.2.8-.4.3-.6.7-.8 1.2-.2.4-.3 1-.4 2.1-.1 1.2-.1 1.6-.1 4.7s0 3.5.1 4.7c.1 1.1.2 1.7.4 2.1.2.5.4.9.8 1.2.3.4.7.6 1.2.8.4.2 1 .3 2.1.4 1.2.1 1.6.1 4.7.1s3.5 0 4.7-.1c1.1-.1 1.7-.2 2.1-.4.5-.2.9-.4 1.2-.8.4-.3.6-.7.8-1.2.2-.4.3-1 .4-2.1.1-1.2.1-1.6.1-4.7s0-3.5-.1-4.7c-.1-1.1-.2-1.7-.4-2.1-.2-.5-.4-.9-.8-1.2-.3-.4-.7-.6-1.2-.8-.4-.2-1-.3-2.1-.4-1.2-.1-1.6-.1-4.7-.1Zm0 3.3a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2Zm0 7.6a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm5.8-7.8a1.1 1.1 0 1 1-2.2 0 1.1 1.1 0 0 1 2.2 0Z"/></svg>`,
  link: `<svg viewBox="0 0 24 24"><path d="M10.6 13.4a1 1 0 0 0 1.4 0l3.5-3.5a3 3 0 1 0-4.2-4.2l-1.2 1.2a1 1 0 1 0 1.4 1.4l1.2-1.2a1 1 0 1 1 1.4 1.4L10.6 12a1 1 0 0 0 0 1.4Zm2.8-2.8a1 1 0 0 0-1.4 0l-3.5 3.5a3 3 0 1 0 4.2 4.2l1.2-1.2a1 1 0 1 0-1.4-1.4l-1.2 1.2a1 1 0 1 1-1.4-1.4l3.5-3.5a1 1 0 0 0 0-1.4Z"/></svg>`,
};

function socialLinks(L) {
  const bits = [];
  if (L.instagram) bits.push(`<a href="https://instagram.com/${encodeURIComponent(L.instagram)}" target="_blank" rel="noopener noreferrer" aria-label="Instagram">${ICON.ig}</a>`);
  if (L.twitter)   bits.push(`<a href="https://x.com/${encodeURIComponent(L.twitter)}" target="_blank" rel="noopener noreferrer" aria-label="X">${ICON.x}</a>`);
  bits.push(`<button data-share="page" aria-label="Share this page">${ICON.link}</button>`);
  return bits.join("");
}

function renderSocial() {
  $("#foot-social").innerHTML = socialLinks(state.listing || {});
  $$("[data-share]").forEach(b => b.addEventListener("click", () => openShare(null)));
}

/* =========================================================================
   sharing
   ========================================================================= */
function shareUrl(spot) {
  const u = new URL(location.href);
  u.hash = "";
  u.search = "";
  /* The footer carries a share button on every screen, and the front door has
     no listing to point at - so from there this shares the marketplace. */
  if (state.listing) u.searchParams.set("l", state.listing.id);
  if (spot) u.searchParams.set("spot", spot.id);
  return u.toString();
}

function openShare(spot) {
  const L = state.listing;
  const url = shareUrl(spot);
  const text = !L
    ? "Square Inch — somebody spends the day being photographed, and you buy a patch of what they are wearing."
    : spot
      ? `Spot ${String(+spot.n).padStart(2, "0")} — ${spot.name} — on ${L.names}'s ${garmentWord(L)}. Bidding is open.`
      : `${L.names} are selling advertising space on the ${garmentWord(L)} — draw the patch you want and bid on it.`;

  const x = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;

  openSheet({
    kicker: "Share",
    title: spot ? `Spot ${String(+spot.n).padStart(2, "0")} · ${spot.name}` : "Send this to someone",
    body: `
      <p class="lead" style="font-size:.93rem">${esc(text)}</p>
      <div style="display:grid;gap:10px;margin-top:20px">
        ${navigator.share ? `<button class="btn wide" id="sh-native">Share…</button>` : ""}
        <a class="btn ghost wide" href="${esc(x)}" target="_blank" rel="noopener noreferrer">Post on X</a>
        <button class="btn ghost wide" id="sh-ig">Instagram</button>
        <button class="btn quiet wide" id="sh-copy">Copy the link</button>
      </div>
      <p class="hint" style="margin-top:14px">Instagram has no web share target, so this copies the link for your story or bio.</p>`,
    onOpen(root) {
      const copy = async () => {
        try { await navigator.clipboard.writeText(url); toast("Link copied.", "ok"); }
        catch { toast("Could not reach the clipboard — the link is in the address bar.", "bad"); }
      };
      const nat = $("#sh-native", root);
      if (nat) nat.addEventListener("click", async () => {
        try { await navigator.share({ title: "Square Inch", text, url }); closeSheet(); }
        catch { /* the sheet was dismissed - nothing to report */ }
      });
      $("#sh-copy", root).addEventListener("click", copy);
      $("#sh-ig", root).addEventListener("click", async () => {
        await copy();
        window.open(L && L.instagram ? `https://instagram.com/${encodeURIComponent(L.instagram)}` : "https://instagram.com", "_blank", "noopener");
      });
    },
  });
}

/* =========================================================================
   bidding
   ========================================================================= */
function selectSpot(id, scroll) {
  state.selected = id;
  renderGarment(true);
  const spot = state.spots.find(s => s.id === id);
  if (!spot) return;
  const bySpot = Store.bids.bySpot(state.bids);
  const min = Store.minimum(spot, bySpot[spot.id]);
  $("#ab-k").textContent = `Spot ${String(+spot.n).padStart(2, "0")} · ${spot.side}`;
  $("#ab-v").textContent = `${spot.name} — from ${money(min)}`;
  $("#actionbar").classList.add("show");
  document.body.classList.add("has-actionbar");
  if (scroll) openBid(id);
}

$("#ab-go").addEventListener("click", () => state.selected && openBid(state.selected));

/* A drawn box has no row in the database yet: the server creates it as part
   of taking the bid, so until then it is a spot-shaped object carrying a
   price and no id. Everything downstream treats it like any other spot. */
function draftSpot(box, L) {
  return {
    /* Not null: market.js refuses a spot whose id is nullish, which is the
       right guard for a spot that was never created and exactly the wrong
       answer for one that is about to be. The id is a sentinel - the engine
       only ever tests it for existence, and the row the server writes gets a
       real one. */
    id: "drawn", listing_id: L.id, side: box.side,
    n: state.spots.filter(s => s.side === box.side).length + 1,
    name: "The area you drew", badge: null,
    blurb: `${areaOf(box).toFixed(1)}% of the ${garmentWord(L)}, on the ${box.side}. ` +
           `Priced at ${money(rateOf(L))} per 1%${box.side === "front"
             ? `, and the front carries a ×${frontMultiplierOf(L)} premium` : ""}.`,
    x: box.x, y: box.y, w: box.w, h: box.h,
    floor: boxPrice(box, L),
    approved: false,
  };
}

function openBid(spotId, box) {
  const L = state.listing;
  if (!L) return;
  const spot = box ? draftSpot(box, L) : state.spots.find(s => s.id === spotId);
  if (!spot) return;
  const user = Store.auth.current();
  const bySpot = Store.bids.bySpot(state.bids);
  const mine = bySpot[spot.id] || [];
  const st = Store.market(spot, mine);
  const min = Store.minimum(spot, mine);
  /* The fee is the platform's, not the publisher's - `listings` is
     owner-writable, so a fee read off the row could be set to zero. */
  const fee = Number(Store.config.feePercent) || 0;

  if (!L.is_open) { toast("Bidding has not opened on this listing yet."); return; }
  if (!user) {
    toast("Open an account to bid.");
    go("auth", { role: "brand", next: () => openBid(spotId, box) });
    return;
  }
  if (user.role !== "brand") { toast(`You are signed in as a ${SIDE.client}. Bidding is for ${SIDE.brand}s.`); return; }

  openSheet({
    kicker: box ? `${spot.side} · a new area` : `${spot.side} · position ${String(+spot.n).padStart(2, "0")}`,
    title: spot.name,
    body: `
      <p class="lead" style="font-size:.92rem">${esc(spot.blurb || "")}</p>

      <div class="quote" style="margin-top:18px">
        ${box ? `<div class="ln"><span class="k">Area you drew</span>
          <span class="v">${areaOf(box).toFixed(1)}%</span></div>` : ""}
        <div class="ln"><span class="k">${box ? "What that area costs" : st.holder ? "Standing price" : "Floor"}</span>
          <span class="v">${money(st.price)}</span></div>
        ${st.holder ? `<div class="ln"><span class="k">Held by</span><span class="v">${esc(st.holderName || `a ${SIDE.brand}`)}</span></div>` : ""}
        <div class="ln"><span class="k">Least you can bid</span><span class="v">${money(min)}</span></div>
        <div class="ln"><span class="k">Closes</span><span class="v">${esc(Market.countdown(L.closes_at))}</span></div>
      </div>

      <form id="bid-form" style="margin-top:20px" novalidate>
        <div class="fld">
          <label for="bid-max">Your maximum, in ${esc(CUR())}</label>
          <input class="inp num" id="bid-max" type="number" inputmode="decimal"
                 min="${min}" step="1" value="${min}" required>
          <p class="hint">We bid the least needed to hold the spot. You are never charged more than this number.</p>
        </div>
        <div class="fld">
          <label for="bid-brand">Brand name</label>
          <input class="inp" id="bid-brand" type="text" maxlength="60"
                 value="${esc(user.brand || user.name || "")}" required>
        </div>
        <div class="fld">
          <label for="bid-logo">Your mark (optional)</label>
          <div class="drop" style="padding:18px 14px">
            <input type="file" id="bid-logo" accept="image/png,image/jpeg,image/svg+xml,image/webp">
            <p class="big" id="logo-name">Drop a logo</p>
            <p class="small">SVG or transparent PNG prints best</p>
          </div>
        </div>

        <div class="quote" id="bid-quote"></div>
        <p class="err" id="bid-err" role="alert" hidden></p>
        <button class="btn wide" type="submit" id="bid-go" style="margin-top:16px">
          <span>${st.holder ? "Take the spot" : "Claim the spot"}</span></button>
        ${/* A drawn box is a proposal to print on a stranger's body, and they
              can say no. Until now the only place that was said was the toast
              AFTER the card had been authorised. An existing spot is already
              accepted, so it keeps the Stripe line. */""}
        <p class="hint" style="text-align:center;margin-top:12px">
          ${box
            ? `${esc(L.names || "The wearer")} has to accept this patch before it is printed.
               If they decline, your card is released in full and you are told why.`
            : "Card handled by Stripe on its own page. Outbid before close and the hold is released in full."}</p>
      </form>`,

    onOpen(root) {
      const maxEl = $("#bid-max", root);
      const quoteEl = $("#bid-quote", root);
      const errEl = $("#bid-err", root);
      const goEl = $("#bid-go", root);
      let logoData = null;

      const draw = () => {
        const v = Store.quote(spot, mine, { bidder: user.id, brand: $("#bid-brand", root).value, max: Number(maxEl.value) });
        if (!v.ok) {
          quoteEl.innerHTML = `<div class="ln"><span class="k">${esc(v.reason)}</span></div>`;
          goEl.setAttribute("aria-disabled", "true");
          return;
        }
        goEl.removeAttribute("aria-disabled");
        /* Two different numbers, and conflating them would be a lie:
           what the spot settles at, and the maximum Stripe actually
           authorises. The gap is a hold, released at close unless a rival
           pushes the price up into it. */
        const owed = Market.quote(v.price, fee);
        const held = Market.quote(v.max, fee);
        const gap = held.total - owed.total;

        /* Against a real database the leader's ceiling is sealed, so the
           truthful answer is a range rather than a figure. Pretending to know
           exactly would be the same lie in a different place. */
        /* When this bid does NOT take the spot, `v.price` is what the CURRENT
           HOLDER will pay - it is their price being pushed up, not yours.
           Labelling it "owed if it closed now" printed a number the bidder does
           not owe, and on a held spot at the minimum it printed one LARGER than
           the hold directly beneath it. A losing bid owes nothing. */
        /* One fee row, built before the branch and rendered in every one of
           them. It used to be written only inside the non-blind branch - and
           `blind` is true whenever there is a real database behind the page,
           so the platform fee was invisible in precisely the mode where a
           card is actually charged. Where the settlement is sealed the honest
           figure is a range: the fee on the least it can settle at, through
           the fee on the most this bidder has authorised. A bid that does not
           take the spot owes nothing, so its fee is nothing. */
        const feeLine = `<div class="ln"><span class="k">Platform fee, ${fee}%</span><span class="v">${
          v.blind ? `${money(owed.fee, { cents: true })} – ${money(held.fee, { cents: true })}`
            : v.won ? money(owed.fee, { cents: true })
              : money(0, { cents: true })}</span></div>`;

        const settlesLine = !v.won && !v.blind
          ? `<div class="ln"><span class="k">Owed if it closed now</span><span class="v">${money(0, { cents: true })}</span></div>`
            + feeLine +
            `<div class="ln"><span class="k">This does not take the spot, so nothing is owed. The authorisation below is released at the close.</span></div>`
          : v.blind
          ? `<div class="ln"><span class="k">Settles between</span><span class="v">${money(owed.placement, { cents: true })} – ${money(v.max, { cents: true })}</span></div>`
            + feeLine +
            `<div class="ln"><span class="k">Where it lands depends on the current holder's maximum, which is sealed. You are told the moment your bid is in.</span></div>`
          : `<div class="ln"><span class="k">Settles at today</span><span class="v">${money(owed.placement, { cents: true })}</span></div>`
            + feeLine +
            `<div class="ln"><span class="k">Owed if it closed now</span><span class="v">${money(owed.total, { cents: true })}</span></div>`;

        quoteEl.innerHTML = settlesLine + `
          <div class="ln tot"><span class="k">Held on your card</span><span class="v">${money(held.total, { cents: true })}</span></div>
          ${/* The explainer was suppressed in blind mode too, which left the
                largest figure on the sheet - the whole authorisation - with
                nothing saying most of it is a hold rather than a charge. */""}
          ${gap > 0.005
            ? `<div class="ln"><span class="k">${money(gap, { cents: true })} of that is only a hold — released at close unless a rival pushes you up to it.</span></div>`
            : ""}
          ${v.blind ? "" : (v.won
            ? (v.outbid ? `<div class="ln"><span class="k">${esc(v.outbid.brand || "The current holder")} is released</span><span class="v">${money(v.outbid.refund)}</span></div>` : "")
            : `<div class="ln"><span class="k">This does not take the spot — their standing maximum is higher. It pushes them to ${money(v.pushedTo)}.</span></div>`)}`;
      };

      maxEl.addEventListener("input", draw);
      $("#bid-brand", root).addEventListener("input", draw);
      draw();

      $("#bid-logo", root).addEventListener("change", async e => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        if (f.size > 2 * 1024 * 1024) { toast("Keep the logo under 2MB.", "bad"); e.target.value = ""; return; }
        $("#logo-name", root).textContent = f.name;
        try { logoData = await Store.photos.uploadLogo(f); }
        catch (err) { toast(err.message, "bad"); }
      });

      $("#bid-form", root).addEventListener("submit", async ev => {
        ev.preventDefault();
        errEl.hidden = true;
        const brandEl = $("#bid-brand", root);
        const brand = brandEl.value.trim();
        const max = Number(maxEl.value);
        const v = Store.quote(spot, mine, { bidder: user.id, brand, max });
        /* Both refusals are about one field each, so both name it, mark it and
           move to it. The amount is the only one the engine can refuse. */
        if (!v.ok) return fail(maxEl, v.reason, errEl);
        if (!brand) return fail(brandEl, "A brand name is required.", errEl);

        goEl.setAttribute("aria-disabled", "true");
        goEl.innerHTML = `<span class="spin"></span><span>Talking to Stripe…</span>`;
        try {
          const res = await Store.bids.place({
            listingId: L.id,
            /* A drawn box has no spot to name yet; the server makes one. */
            spotId: box ? null : spot.id,
            draw: box || null, max, brand, logo: logoData,
          });
          if (res.url) { location.href = res.url; return; }          // Stripe's hosted page
          closeSheet();
          await refresh();
          toast(box
            ? "Sent. The wearer sees where you want to be and decides — your card is only authorised until they do."
            : res.demo
              ? `Bid placed in demo mode — no card was charged. ${res.reason || ""}`.trim()
              : "Bid placed. Your card is authorised, not charged.", "ok");
        } catch (err) {
          errEl.textContent = err.message; errEl.hidden = false;
          goEl.removeAttribute("aria-disabled");
          goEl.innerHTML = `<span>Try again</span>`;
        }
      });
    },
  });
}

/* =========================================================================
   routing
   ========================================================================= */
const SCREENS = ["home", "browse", "campaign", "auth", "studio"];
let authNext = null;

function go(screen, opts = {}) {
  state.screen = screen;
  SCREENS.forEach(s => { $("#screen-" + s).hidden = s !== screen; });
  const bar = screen === "campaign" && !!state.selected;
  $("#actionbar").classList.toggle("show", bar);
  document.body.classList.toggle("has-actionbar", bar);
  closeMobNav();
  if (!opts.keepScroll) window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });

  if (screen === "auth") {
    authNext = opts.next || null;
    if (opts.role) setRole(opts.role);
    /* setAuthMode was never called at boot or from here, so the screen opened
       in whatever state the markup happened to be in: the button still said
       "Continue" instead of "Create the account", and #au-pw still carried
       autocomplete="current-password" on a sign-up form - which is the cue a
       password manager reads to offer a saved password instead of generating
       a new one. It runs after setRole, which decides whether the brand field
       belongs on screen at all. */
    setAuthMode(opts.mode || "up");
  }
  if (screen !== "campaign") state.arming = false;
  if (screen === "home") renderHome();
  if (screen === "browse") renderBrowse();
  if (screen === "studio") renderStudio();
}

/* =========================================================================
   the directory

   Both the front door and the browse screen are a grid of the same card, so
   they are drawn by the same two functions. `directory()` is the only thing
   that touches the network; it is cached for the session because a listing
   does not appear or vanish while somebody is looking at the page.
   ========================================================================= */
async function directory({ fresh = false } = {}) {
  if (state.directory.length && !fresh) return state.directory;
  let all = [];
  try { all = await Store.listings.list({ openOnly: true }); }
  catch (e) { toast(e.message, "bad"); return []; }

  /* One round trip per listing, in parallel, so a card can show what has been
     raised rather than just a photograph. */
  state.directory = await Promise.all(all.map(async l => {
    let spots = [], bids = [];
    try { [spots, bids] = await Promise.all([Store.spots.list(l.id), Store.bids.list(l.id)]); }
    catch { /* a listing whose spots we cannot read still belongs on the page */ }
    return { l, spots, bids, c: Store.campaign(spots, Store.bids.bySpot(bids), l.goal) };
  }));
  return state.directory;
}

function lotCard({ l, c }) {
  const photo = safeUrl(l.photo_front);
  /* The entry price, not the cheapest takeover of somebody else's patch.
     A card used to read "from $1,380" because the only spot on the garment
     was a big one already held - a figure nobody could have paid, on a
     listing where the smallest legal box costs a fraction of it. This is
     what the rules actually charge for the smallest box a brand may draw. */
  const from = Math.max(Market.RULES.MIN_AREA_PCT * Market.rateOf(l), Market.RULES.MIN_BID);
  return `<button class="lot" data-listing="${esc(l.id)}">
    <div class="shot">
      ${photo
        ? `<img src="${esc(photo)}" alt="" loading="lazy">`
        : silhouetteSvg(l.garment, "front", wornBy(l))}
      <div class="tags">
        <span class="pill">${esc(garmentLabel(l))}</span>
        ${/* Never "All taken". A spot row exists only because a sponsor drew
              it and bid on it, so the open count is zero on every listing
              that has ever sold anything, and the card told every brand the
              garment was full the moment the first one bought a patch. */""}
        ${c.total
          ? `<span class="pill live">${plural(c.total, "sponsor")} on board · room for more</span>`
          : `<span class="pill">Open — nothing drawn yet</span>`}
      </div>
    </div>
    <div class="body">
      <h3>${esc(l.names || "A wearer")}</h3>
      <p class="meta">${esc([l.city, l.event_date].filter(Boolean).join(" · ") || "Date to come")}</p>
      <div class="meter"><i style="width:${(c.pct * 100).toFixed(1)}%"></i></div>
      <div class="foot-line">
        <span>${money(c.raised)} / ${money(c.goal)}</span>
        <span class="open">from ${money(from)} · draw any size</span>
      </div>
    </div></button>`;
}

/* Every grid of lots behaves the same: click one, open it. */
function wireLots(root) {
  $$(".lot", root).forEach(b => b.addEventListener("click", async () => {
    await load(b.dataset.listing);
    go("campaign");
  }));
}

const SPINNER = `<div class="empty-state" style="grid-column:1/-1"><span class="spin"></span></div>`;

/* ------------------------------------------------------------- front door */
async function renderHome() {
  /* The showcase is drawn first and from constants, never from the network,
     so the front door has a picture on it the instant the page exists. What
     is actually listed can take its time filling in underneath. */
  buildShowcase();
  setShowPaused(false);

  const grid = $("#home-featured");
  grid.innerHTML = SPINNER;

  const rows = await directory();
  if (!rows.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>Nobody is listed yet</h3>
      <p>Be the first. Open a wearer account and put your garment up.</p></div>`;
    return;
  }

  grid.innerHTML = rows.slice(0, 3).map(lotCard).join("");
  wireLots(grid);
}

/* =========================================================================
   the showcase

   The front door has to answer "what is this?" before anybody reads a word,
   and the only answer that works is a photograph of a person with somebody
   else's logo printed on them. So: the front and the back of one person, side
   by side, sliding left to right through the men or the women.

   Every patch below was placed against the actual photograph, on opaque
   fabric, clear of hands, of bare arms, and of the sheer lace several of these
   gowns carry across the shoulders - see public/assets/garments/manifest.json,
   which records where the fabric really is in each frame. A logo on somebody's
   skin is the one thing this picture must never show.

   Only `w` is given. The height comes from the logo's own proportions, because
   the supplied artwork runs from a 2.3:1 wordmark to a perfect square and any
   fixed box would crop or stretch one of them.
   ========================================================================= */
const SHOWCASE = {
  male: [
    {
      person: "p4", name: "Roi Avital", where: "Jerusalem", garment: "suit",
      /* the jacket hangs open, so the front patch sits on the left panel
         rather than the centre, which is tie and then waistcoat */
      marks: [
        { side: "front", x: 38, y: 28, w: 16, logo: "04_tiptop.png", brand: "TipTop" },
        { side: "back", x: 39, y: 29, w: 24, logo: "02_lever_up.png", brand: "Lever Up" },
      ],
    },
    {
      person: "p5", name: "Amit Barak", where: "Ramat Gan", garment: "suit",
      marks: [
        { side: "front", x: 36, y: 28, w: 16, logo: "06_cryptopolitan.png", brand: "Cryptopolitan" },
        { side: "back", x: 41, y: 27, w: 18, logo: "12_riv.png", brand: "RIV" },
      ],
    },
  ],
  female: [
    {
      person: "p1", name: "Maya & Tal", where: "Tel Aviv", garment: "gown",
      /* the V neckline bottoms out at y31 and the sleeves are sheer, so the
         chest patch starts below the V and stays inside the beaded panel */
      marks: [
        { side: "front", x: 44, y: 33, w: 14, logo: "01_wave_logo.png", brand: "Wave" },
        { side: "back", x: 41, y: 46, w: 18, logo: "10_blue_star.png", brand: "Blue Star" },
      ],
    },
    {
      person: "p2", name: "Dana Halevi", where: "Caesarea", garment: "gown",
      /* the whole back above the waist seam is illusion lace over skin */
      marks: [
        { side: "front", x: 44, y: 42, w: 14, logo: "09_purple_frog.png", brand: "Purple Frog" },
        { side: "back", x: 40, y: 45, w: 18, logo: "07_zvzzt.png", brand: "ZVZZT" },
      ],
    },
    {
      person: "p3", name: "Noa Lev", where: "Haifa", garment: "gown",
      /* plain matte satin between y24 and y36 - the best surface in the set */
      marks: [
        { side: "front", x: 45, y: 27, w: 13, logo: "13_zara.svg", brand: "Zara" },
        { side: "back", x: 39, y: 46, w: 18, logo: "14_redbull.svg", brand: "Red Bull" },
      ],
    },
  ],
};

const SHOW_MS = 3000;
const show = { tab: "male", i: 0, timer: null, paused: false, hovering: false };

function showPanel(entry, side) {
  const marks = entry.marks.filter(m => m.side === side).map(m => `
    <span class="mark" style="top:${m.y}%;left:${m.x}%;width:${m.w}%">
      <img src="/assets/logos/${esc(m.logo)}" alt="${esc(m.brand)}" loading="lazy" decoding="async">
    </span>`).join("");
  return `<figure class="shot">
    <img class="garment-photo" src="/assets/garments/${entry.person}-${side}.jpg"
         alt="${esc(entry.name)}, ${side}, with sponsors printed on the ${esc(entry.garment)}"
         loading="lazy" decoding="async">
    <span class="side-tag">${side}</span>${marks}
  </figure>`;
}

/* The track holds every slide for this tab at once and is shifted sideways.
   Rebuilding it on each step would make the move a redraw, not a slide - the
   whole point is that the eye follows one picture out and the next one in. */
function buildShowcase() {
  const list = SHOWCASE[show.tab];
  $("#show-track").innerHTML = list.map(entry =>
    `<div class="slide">${showPanel(entry, "front")}${showPanel(entry, "back")}</div>`).join("");
  $("#show-track").style.setProperty("--slides", list.length);

  $("#show-dots").innerHTML = list.map((e, n) =>
    `<button role="tab" aria-selected="false" aria-label="${esc(e.name)}" data-show="${n}"></button>`).join("");
  $$("#show-dots [data-show]").forEach(b =>
    b.addEventListener("click", () => goShow(Number(b.dataset.show))));

  $("#show-male").setAttribute("aria-pressed", String(show.tab === "male"));
  $("#show-female").setAttribute("aria-pressed", String(show.tab === "female"));
  paintShowcase();
}

/* Only the transform and the labels move between slides. */
function paintShowcase() {
  const list = SHOWCASE[show.tab];
  const entry = list[show.i];
  $("#show-track").style.transform = `translateX(-${show.i * (100 / list.length)}%)`;
  $("#show-caption").textContent =
    `${entry.name} · ${entry.where} — two sponsors, drawn and priced by area`;
  $$("#show-dots [data-show]").forEach((b, n) =>
    b.setAttribute("aria-selected", String(n === show.i)));
}

function goShow(i) {
  const list = SHOWCASE[show.tab];
  show.i = (i + list.length) % list.length;
  paintShowcase();
  restartShowcase();          // a deliberate move resets the clock
}
const nextShow = () => goShow(show.i + 1);
const prevShow = () => goShow(show.i - 1);

/* Rotation stops while somebody is looking at one deliberately - a picture
   that moves under the cursor is a picture nobody can study - and stops for
   good if they press pause. */
function restartShowcase() {
  clearInterval(show.timer);
  if (show.paused) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  show.timer = setInterval(() => {
    if (show.hovering || document.hidden) return;
    const list = SHOWCASE[show.tab];
    show.i = (show.i + 1) % list.length;
    paintShowcase();
  }, SHOW_MS);
}

function setShowPaused(on) {
  show.paused = !!on;
  const btn = $("#show-pause");
  btn.setAttribute("aria-pressed", String(show.paused));
  btn.setAttribute("aria-label", show.paused ? "Play" : "Pause");
  btn.innerHTML = show.paused
    ? `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>`
    : `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z"/></svg>`;
  restartShowcase();
}

function setShowTab(tab) {
  show.tab = tab;
  show.i = 0;
  buildShowcase();
  restartShowcase();
}

$("#show-male").addEventListener("click", () => setShowTab("male"));
$("#show-female").addEventListener("click", () => setShowTab("female"));
$("#show-prev").addEventListener("click", prevShow);
$("#show-next").addEventListener("click", nextShow);
$("#show-pause").addEventListener("click", () => setShowPaused(!show.paused));

$("#showcase").addEventListener("pointerenter", () => { show.hovering = true; });
$("#showcase").addEventListener("pointerleave", () => { show.hovering = false; });
$("#showcase").addEventListener("focusin", () => { show.hovering = true; });
$("#showcase").addEventListener("focusout", () => { show.hovering = false; });

/* Arrow keys work once the carousel has focus, which is what a keyboard user
   reaches for before they find the buttons. */
$("#showcase").addEventListener("keydown", e => {
  if (e.key === "ArrowRight") { e.preventDefault(); nextShow(); }
  if (e.key === "ArrowLeft") { e.preventDefault(); prevShow(); }
});

/* --------------------------------------------------------- browse screen */
function matchesFilter(l, filter) {
  if (filter === "all") return true;
  if (filter === "gown" || filter === "suit") return l.garment === filter;
  return wornBy(l) === filter;
}

async function renderBrowse() {
  const grid = $("#browse-grid");
  grid.innerHTML = SPINNER;

  const rows = await directory();
  const q = $("#browse-search").value.trim().toLowerCase();
  const shown = rows.filter(({ l }) =>
    matchesFilter(l, state.filter) &&
    (!q || [l.names, l.city, l.venue, l.headline].filter(Boolean).join(" ").toLowerCase().includes(q)));

  $("#browse-count").textContent = `${shown.length} of ${rows.length}`;

  grid.innerHTML = shown.length
    ? shown.map(lotCard).join("")
    : `<div class="empty-state" style="grid-column:1/-1"><h3>Nothing matches</h3>
       <p>Try another search, or drop the filter.</p></div>`;
  wireLots(grid);
}

$("#browse-search").addEventListener("input", debounce(renderBrowse, 220));
$$("[data-filter]").forEach(b => b.addEventListener("click", () => {
  state.filter = b.dataset.filter;
  $$("[data-filter]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  renderBrowse();
}));

/* =========================================================================
   auth
   ========================================================================= */
let authMode = "up", authRole = "client";

function setRole(role) {
  authRole = role;
  $("#role-client").setAttribute("aria-pressed", String(role === "client"));
  $("#role-brand").setAttribute("aria-pressed", String(role === "brand"));
  $("#au-brand-fld").hidden = role !== "brand";
  $("#auth-lead").textContent = role === "client"
    ? "You photograph what you're wearing, front and back, set one price per 1% of the fabric, and say yes or no to each sponsor."
    : "You drag a rectangle onto somebody's garment, and what it costs follows how big you drew it.";
}
$("#role-client").addEventListener("click", () => setRole("client"));
$("#role-brand").addEventListener("click", () => setRole("brand"));

function setAuthMode(mode) {
  authMode = mode;
  $("#auth-title").textContent = mode === "up" ? "Which side of the table?" : "Welcome back";
  $("#auth-go").textContent = mode === "up" ? "Create the account" : "Sign in";
  $("#auth-swap-text").textContent = mode === "up" ? "Already have an account?" : "Need an account?";
  $("#auth-toggle").textContent = mode === "up" ? "Sign in" : "Create one";
  $("#role-toggle").hidden = mode === "in";
  /* The warning belongs to the toggle; on the sign-in form there is nothing
     left to choose and it would be warning about a decision already made. */
  $("#role-permanent").hidden = mode === "in";
  $("#au-name").closest(".fld").hidden = mode === "in";
  $("#au-brand-fld").hidden = mode === "in" || authRole !== "brand";
  $("#au-pw").autocomplete = mode === "up" ? "new-password" : "current-password";
}
$("#auth-toggle").addEventListener("click", () => setAuthMode(authMode === "up" ? "in" : "up"));

/* Social sign-in only exists when there is a project behind it. */
$("#go-google").addEventListener("click", async () => {
  const btn = $("#go-google");
  btn.setAttribute("aria-disabled", "true");
  try { await Store.auth.signInWithOAuth("google"); }   // navigates away
  catch (e) {
    btn.removeAttribute("aria-disabled");
    const err = $("#auth-err"); err.textContent = e.message; err.hidden = false;
  }
});

$("#auth-form").addEventListener("submit", async e => {
  e.preventDefault();
  const err = $("#auth-err"); err.hidden = true;
  const btn = $("#auth-go");
  const email = $("#au-email").value.trim();
  const password = $("#au-pw").value;
  const name = $("#au-name").value.trim();
  const brand = $("#au-brand").value.trim();

  /* One field per refusal. "Email and password, please." named two fields and
     therefore pointed at neither, which is no use to anything that has to
     move focus to the thing that is wrong. */
  if (!email) return fail($("#au-email"), "An email address, please.", err);
  if (!password) return fail($("#au-pw"), "A password, please.", err);
  if (authMode === "up" && password.length < 8) return fail($("#au-pw"), "Use at least 8 characters.", err);
  if (authMode === "up" && !name) return fail($("#au-name"), "What should we call you?", err);
  /* The Google path asks a brand for its name; the email path never did, so a
     brand account could be created carrying only a person's name - and that
     name is what gets prefilled into the bid sheet and printed on somebody
     else's wedding dress. */
  if (authMode === "up" && authRole === "brand" && !brand)
    return fail($("#au-brand"), "A brand name, please — this is what gets printed on the garment.", err);

  btn.setAttribute("aria-disabled", "true");
  const label = btn.textContent;
  btn.innerHTML = `<span class="spin"></span>`;
  try {
    if (authMode === "up") await Store.auth.signUp({ email, password, name, role: authRole, brand });
    else await Store.auth.signIn({ email, password });

    const u = Store.auth.current();
    if (!u) { toast("Check your email to confirm the account, then sign in.", "ok"); setAuthMode("in"); return; }
    toast(`Signed in as ${u.brand || u.name}.`, "ok");
    const next = authNext; authNext = null;
    /* `next` is whatever the visitor was trying to do when we interrupted
       them to sign in - almost always a bid, which needs its own listing
       back on screen before the sheet can reopen. */
    if (next) { go("campaign"); next(); }
    else if (u.role === "client") await enterStudio();
    else go("browse");
  } catch (e2) {
    err.textContent = e2.message; err.hidden = false;
  } finally {
    btn.removeAttribute("aria-disabled"); btn.textContent = label;
  }
});

/* --------------------------------------------------------- the one question
   Google cannot tell us whether someone is here to sell a garment or to buy
   space on one, so an OAuth arrival lands with the default and `roleLocked`
   false. This asks, once. The database allows exactly one such change. */
let askingRole = false;

async function askRoleIfNeeded() {
  const u = Store.auth.current();
  if (!u || u.roleLocked !== false || askingRole) return;
  askingRole = true;

  openSheet({
    kicker: "One question",
    title: `Welcome, ${u.name}`,
    body: `
      <p class="lead" style="font-size:.95rem">Which side of the table are you on? This decides what your
        account can do, and it cannot be changed afterwards — it is what stops anyone listing a garment
        and then bidding it up themselves.</p>

      <div style="display:grid;gap:11px;margin-top:22px">
        <button class="btn ghost wide" data-role="client" style="justify-content:flex-start;text-align:start;height:auto;padding:16px 20px">
          <span><b style="display:block">I'm the one wearing it</b>
          <span style="color:var(--ink-2);font-size:.86rem">I'm selling space on a gown or a suit</span></span>
        </button>
        <button class="btn ghost wide" data-role="brand" style="justify-content:flex-start;text-align:start;height:auto;padding:16px 20px">
          <span><b style="display:block">I'm a sponsor</b>
          <span style="color:var(--ink-2);font-size:.86rem">I want my mark on somebody's garment</span></span>
        </button>
      </div>

      <div class="fld" id="role-brand-name" style="margin-top:18px" hidden>
        <label for="rc-brand">Brand name</label>
        <input class="inp" id="rc-brand" type="text" maxlength="60" placeholder="What should appear on the garment?">
      </div>
      <p class="err" id="rc-err" role="alert" hidden></p>
      <button class="btn wide" id="rc-go" style="margin-top:16px" aria-disabled="true">Confirm</button>`,

    onOpen(root) {
      let picked = null;
      const brandFld = $("#role-brand-name", root);
      const go = $("#rc-go", root);

      $$("[data-role]", root).forEach(b => b.addEventListener("click", () => {
        picked = b.dataset.role;
        /* A button never fires `input`, so the mark `fail` left on it has to
           come off here - otherwise the choice stays flagged after it is made. */
        $$("[data-role]", root).forEach(x => { x.style.borderColor = ""; x.removeAttribute("aria-invalid"); });
        $("#rc-err", root).hidden = true;
        b.style.borderColor = "var(--magenta)";
        brandFld.hidden = picked !== "brand";
        go.removeAttribute("aria-disabled");
      }));

      go.addEventListener("click", async () => {
        const err = $("#rc-err", root);
        err.hidden = true;
        /* Focus goes to the first of the two choices, not just to the message
           about them - it is the only thing on the sheet that can be acted on. */
        if (!picked) return fail($("[data-role]", root), "Pick one.", err);
        const brandEl = $("#rc-brand", root);
        const brand = picked === "brand" ? brandEl.value.trim() : null;
        if (picked === "brand" && !brand)
          return fail(brandEl, "A brand name is required — it is what gets printed on the garment.", err);
        go.setAttribute("aria-disabled", "true");
        go.innerHTML = `<span class="spin"></span>`;
        try {
          await Store.auth.chooseRole(picked, brand);
          askingRole = false;
          closeSheet();
          toast(picked === "client" ? `You're set up as a ${SIDE.client}.` : `Bidding as ${brand}.`, "ok");
          if (picked === "client") await enterStudio(); else renderAccount();
        } catch (e) {
          err.textContent = e.message; err.hidden = false;
          go.removeAttribute("aria-disabled"); go.textContent = "Try again";
        }
      });
    },
  });
}

/* ------------------------------------------------------------ account menu */
function renderAccount() {
  const u = Store.auth.current();
  const right = $("#navright"), mob = $("#mob-account");

  if (!u) {
    right.innerHTML = `
      <button class="btn quiet sm" id="nav-in">Sign in</button>
      <button class="btn sm" id="nav-get">Get a spot</button>`;
    mob.innerHTML = `
      <button class="btn ghost wide" id="mob-in">Sign in</button>
      <button class="btn wide" id="mob-get">Get a spot</button>`;
    $$("#nav-get, #mob-get").forEach(b => b.addEventListener("click", () => go("browse")));
    /* The mode travels with the navigation rather than being applied after it:
       go() now initialises the form, so a setAuthMode() afterwards was either
       redundant or - once go() started doing it - a second render of the same
       screen. */
    $$("#nav-in, #mob-in").forEach(b => b.addEventListener("click", () => go("auth", { role: "brand", mode: "in" })));
    return;
  }

  const label = esc(u.brand || u.name);
  right.innerHTML = `
    ${u.role === "client" ? `<button class="btn ghost sm" id="nav-studio">My listing</button>` : ""}
    <button class="btn quiet sm" id="nav-out">${label} · Sign out</button>`;
  mob.innerHTML = `
    ${u.role === "client" ? `<button class="btn ghost wide" id="mob-studio">My listing</button>` : ""}
    <button class="btn quiet wide" id="mob-out">${label} · Sign out</button>`;

  const out = async () => { await Store.auth.signOut(); toast("Signed out."); go("home"); };
  $$("#nav-out, #mob-out").forEach(b => b.addEventListener("click", out));
  $$("#nav-studio, #mob-studio").forEach(b => b.addEventListener("click", enterStudio));
}

/* =========================================================================
   studio
   ========================================================================= */
async function enterStudio() {
  const u = Store.auth.current();
  if (!u || u.role !== "client") { toast(`Only a ${SIDE.client} has a listing.`); return; }
  let mine = await Store.listings.mine();
  if (!mine.length) {
    const created = await Store.listings.create({
      names: u.name, garment: "gown",
      closes_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      headline: "Walking billboard for your mark",
      tagline: "Your logo on the dress, worn all day.",
    });
    mine = [created];
    toast("Listing created. Upload a front and a back photograph, then set your rate.", "ok");
  }
  await load(mine[0].id);
  go("studio");
}

async function renderStudio() {
  const L = state.listing;
  if (!L) return;
  const bySpot = Store.bids.bySpot(state.bids);
  const c = Store.campaign(state.spots, bySpot, L.goal);

  $("#studio-names").textContent = L.names || "Your listing";
  $("#studio-meta").textContent = [L.city, L.event_date, plural(state.spots.length, "spot"),
    L.is_open ? "Bidding open" : "Not open yet"].filter(Boolean).join(" · ");

  const onBoard = state.spots.filter(s => s.approved !== false).length;
  const waiting = state.spots.length - onBoard;

  $("#studio-stats").innerHTML = `
    <div class="stat"><div class="k">Committed</div><div class="v w">${money(c.raised)}</div><div class="d">of ${money(c.goal)}</div></div>
    <div class="stat"><div class="k">Bids</div><div class="v">${state.bids.length}</div><div class="d">from ${plural(new Set(state.bids.map(b => b.bidder)).size, SIDE.brand)}</div></div>
    ${/* Not "Spots held N/M". Every spot on this listing exists because a brand
          drew it and bid on it, so `held` and `total` were the same number and
          `open` was always zero - a stat that could only ever read "3/3, 0
          still open". What the publisher actually needs to know is how many
          are on the garment and how many are still waiting on a yes. */""}
    <div class="stat"><div class="k">Sponsors on board</div><div class="v g">${onBoard}</div>
      <div class="d">${waiting ? `${plural(waiting, SIDE.brand)} waiting on you` : "room for more"}</div></div>
    <div class="stat"><div class="k">Closes in</div><div class="v a">${esc(Market.countdown(L.closes_at))}</div><div class="d">your deadline</div></div>`;

  $("#studio-spotcount").textContent = plural(state.spots.length, "spot");
  $("#studio-bidcount").textContent = plural(state.bids.length, "bid");

  /* the editable garment */
  const side = state.studioSide;
  $("#studio-garment").innerHTML = garmentPanel(side, { interactive: false, showPending: true });

  /* bids table */
  const rows = state.bids.slice().sort((a, b) => b.at - a.at).map(b => {
    const spot = state.spots.find(s => s.id === b.spotId);
    const st = spot ? Store.market(spot, bySpot[spot.id]) : null;
    const holding = st && st.holder === b.bidder;
    return `<tr>
      <td data-k="${Side("brand")}">${esc(b.brand)}</td>
      <td data-k="Spot">${spot ? `${esc(spot.side)} ${String(+spot.n).padStart(2, "0")} · ${esc(spot.name)}` : "—"}</td>
      <td data-k="Maximum" class="num">${money(b.max)}</td>
      <td data-k="Standing" class="num">${st && holding ? money(st.price) : "—"}</td>
      <td data-k="State">${holding
        ? `<span class="pill live">Holding</span>`
        : `<span class="pill dead">Outbid</span>`}</td>
    </tr>`;
  }).join("");
  $("#studio-bids").innerHTML = rows ||
    `<tr><td colspan="5" style="text-align:center;color:var(--dim);padding:26px">No bids yet.</td></tr>`;

  /* forms */
  $("#t-garment").value = L.garment || "gown";
  $("#t-wears").value = wornBy(L);
  $("#t-names").value = L.names || "";
  $("#t-city").value = L.city || "";
  $("#t-goal").value = L.goal || 0;
  $("#t-closes").value = localInputValue(L.closes_at);
  /* The field cannot be set to a close that has already been and gone, or to
     one so close that nobody can answer the last bid. The browser enforces
     the same bound the submit handler does. */
  $("#t-closes").min = localInputValue(Date.now() + MIN_LEAD_MS);
  $("#t-closes-tz").textContent = "(" + localZoneName() + ")";
  $("#t-headline").value = L.headline || "";
  $("#t-tagline").value = L.tagline || "";
  $("#t-about").value = L.about || "";
  $("#t-ig").value = L.instagram || "";
  $("#t-tw").value = L.twitter || "";
  $("#t-rate").value = rateOf(L);
  $("#t-frontmul").value = frontMultiplierOf(L);
  drawRateExample();
  $("#terms-open").textContent = L.is_open ? "Close the bidding" : "Open the bidding";

  $("#e-invited").value = L.invited || 0;
  $("#e-confirmed").value = L.confirmed || 0;
  /* Not the same bug as #t-closes: `event_date` is a plain date on both sides
     and never passes through a Date, so nothing shifts it. The slice is
     insurance against a row that arrives as a full timestamp - an <input
     type="date"> rejects "2026-09-16T00:00:00Z" outright and silently clears
     itself, which would look exactly like the publisher's date being lost. */
  $("#e-date").value = String(L.event_date || "").slice(0, 10);
  $("#e-venue").value = L.venue || "";
  $("#e-reach").value = L.reach || 0;
  $("#e-live").checked = !!L.livestream;

  const a = audience(L);
  $("#audience-out").innerHTML = `
    <div class="quote">
      <div class="ln"><span class="k">In the room</span><span class="v">${num(a.inRoom)}</span></div>
      <div class="ln"><span class="k">Social and gallery</span><span class="v">${num(a.social)}</span></div>
      ${a.livestream ? `<div class="ln"><span class="k">Livestream</span><span class="v">${num(a.livestream)}</span></div>` : ""}
      <div class="ln tot"><span class="k">Estimated impressions</span><span class="v">${num(a.total)}</span></div>
    </div>`;

  renderPending(bySpot);
  syncDrops();
}

/* =========================================================================
   the rate card

   A publisher does not price thirteen rectangles any more. They price one
   percent of the fabric, and the arithmetic does the rest - which is the only
   way a brand can draw a box nobody anticipated and still be quoted a number
   the publisher would have chosen.
   ========================================================================= */
/* The rate and the multiplier are read by the engine, not by a second copy of
   the defaults living here - a page that disagreed with the server about what
   an unset rate means would quote a price the server then refused. */
const rateOf = L => Market.rateOf(L);
const frontMultiplierOf = L => Market.frontMultiplierOf(L);
const boxPrice = (box, L) => Market.priceForBox(box, L);
const areaOf = box => (Number(box.w) * Number(box.h)) / 100;

function drawRateExample() {
  const L = {
    rate_per_percent: Number($("#t-rate").value) || 0,
    front_multiplier: Number($("#t-frontmul").value) || 1,
  };
  const chest = { side: "front", w: 27, h: 10 };
  const small = { side: "back", w: 14, h: 8 };
  $("#rate-example").textContent =
    `A chest-sized box on the front is ${money(boxPrice(chest, L))}. ` +
    `A small one on the back is ${money(boxPrice(small, L))}.`;
}
$$("#t-rate, #t-frontmul").forEach(el => el.addEventListener("input", drawRateExample));

/* ------------------------------------------------------ brands waiting on a yes
   A drawn spot is somebody's proposal to print on your body. It holds their
   money and none of our opinions: until the publisher says yes it is not on
   the garment and not on the public page. */
function renderPending(bySpot) {
  const pending = state.spots.filter(s => s.approved === false && !s.declined);
  $("#pending-card").hidden = !pending.length;
  $("#pending-count").textContent = String(pending.length);
  if (!pending.length) return;

  const L = state.listing;
  $("#pending-list").innerHTML = pending.map(s => {
    const st = Store.market(s, bySpot[s.id]);
    const photo = safeUrl(L["photo_" + s.side]);
    return `<div class="pend">
      <div class="pend-thumb">
        ${photo ? `<img src="${esc(photo)}" alt="">` : ""}
        <i style="top:${+s.y}%;left:${+s.x}%;width:${+s.w}%;height:${+s.h}%"></i>
      </div>
      <div style="min-width:0">
        <h4>${esc(st.holderName || `A ${SIDE.brand}`)}</h4>
        <p class="hint">${esc(s.side)} · ${areaOf(s).toFixed(1)}% of the garment · ${money(st.price)}</p>
      </div>
      <div class="chips">
        <button class="btn sm" data-approve="${esc(s.id)}">Accept</button>
        <button class="btn danger sm" data-decline="${esc(s.id)}">Decline</button>
      </div>
    </div>`;
  }).join("");

  $$("#pending-list [data-approve]").forEach(b => b.addEventListener("click", async () => {
    try {
      await Store.spots.update(b.dataset.approve, { approved: true });
      toast("Accepted — it goes on the garment.", "ok");
      await refresh();
    } catch (e) { toast(e.message, "bad"); }
  }));
  $$("#pending-list [data-decline]").forEach(b => b.addEventListener("click", () => {
    const spot = state.spots.find(x => x.id === b.dataset.decline);
    if (!spot) return;
    const st = Store.market(spot, Store.bids.bySpot(state.bids)[spot.id]);
    const who = st.holderName || "this sponsor";

    /* A sheet rather than confirm(): this releases somebody's money and the
       native dialog cannot say whose, or how much, or that it is final. */
    openSheet({
      kicker: "Decline",
      title: `Say no to ${who}?`,
      body: `
        <p class="lead" style="font-size:.95rem">Their authorisation of
          <b>${money(st.price)}</b> is released in full and the rectangle comes off your
          garment. They are told you declined. This cannot be undone — they would have to
          draw it again.</p>
        <p class="err" id="dec-err" role="alert" style="margin-top:18px" hidden></p>
        <div style="display:grid;gap:10px;margin-top:20px">
          <button class="btn danger wide" id="dec-go">Decline and release their card</button>
          <button class="btn ghost wide" id="dec-no">Keep it for now</button>
        </div>`,
      onOpen(root) {
        $("#dec-no", root).addEventListener("click", closeSheet);
        $("#dec-go", root).addEventListener("click", async () => {
          const go = $("#dec-go", root), err = $("#dec-err", root);
          err.hidden = true;
          go.setAttribute("aria-disabled", "true");
          go.innerHTML = `<span class="spin"></span><span>Releasing their card…</span>`;
          try {
            /* Never a delete. `bids.spot_id` cascades, so removing the spot
               removes the bid that carries the Stripe payment intent, after
               which the hold cannot be cancelled by anyone - while this very
               toast says it was. The server releases first, then marks. */
            await Store.spots.decline(spot.id);
            closeSheet();
            toast(`Declined. ${who}'s card is released.`, "ok");
            await refresh();
          } catch (e) {
            err.textContent = e.message;
            err.hidden = false;
            go.removeAttribute("aria-disabled");
            go.textContent = "Try again";
          }
        });
      },
    });
  }));
}

/* =========================================================================
   drawing

   The brand draws, not the publisher. A brand drags a rectangle anywhere on
   the photograph and is quoted on the spot: the price is the area it covers
   times the publisher's rate, so there is no menu of positions to maintain
   and nothing stops a brand asking for a shape nobody anticipated.

   The same drag is wired to whichever garment panel is on screen, so it works
   on the front, on the back, and on a phone.
   ========================================================================= */
/* The engine writes its refusals for a dialog box. Inside a rectangle that is
   still being dragged there is room for about four words, so the three rules
   that actually bite while the hand is moving get a shorter telling. The
   verdict itself is always `Market.validateBox`; this only chooses the
   wording, and falls back to the engine's own sentence for anything else. */
function shortRefusal(reason, box, onSide, bySpot) {
  const area = Market.areaPercent(box);
  if (area < Market.RULES.MIN_AREA_PCT) return "Too small — keep going";
  if (area > Market.RULES.MAX_AREA_PCT) return `Too big, over ${Market.RULES.MAX_AREA_PCT}%`;
  const hit = (onSide || []).find(s => Market.boxesOverlap(box, {
    x: +s.x, y: +s.y, w: +s.w, h: +s.h,
  }));
  if (hit) {
    const who = Store.market(hit, bySpot && bySpot[hit.id]).holderName;
    return `${who || "Somebody"} is already here`;
  }
  return reason;
}

function wireDrawing(pane, onBox) {
  let start = null, draft = null, label = null;
  /* The last rectangle that was refused, left painted on the cloth with the
     reason on it. It is cleared by the next pointerdown and by nothing else,
     so the brand can look at what it drew while it reads why it cannot have
     it - which is the one thing a toast in the corner cannot offer. */
  let refused = null;
  let onSide = [], bySpot = {};

  const pct = e => {
    const r = pane.getBoundingClientRect();
    return {
      x: Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)),
      y: Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100)),
    };
  };
  const boxFrom = now => ({
    x: +Math.min(start.x, now.x).toFixed(2), y: +Math.min(start.y, now.y).toFixed(2),
    w: +Math.abs(now.x - start.x).toFixed(2), h: +Math.abs(now.y - start.y).toFixed(2),
  });

  const clear = () => { if (draft) draft.remove(); draft = null; label = null; start = null; };

  /* Hand the rectangle over to `refused` instead of deleting it. */
  const refuse = reason => {
    if (!draft) return;
    draft.classList.add("bad");
    if (label) label.textContent = reason;
    if (refused) refused.remove();
    refused = draft;
    draft = null; label = null; start = null;
  };

  pane.addEventListener("pointerdown", e => {
    /* No dead zones while armed. This used to bail when the press landed on an
       existing spot, on the theory that the press was aimed at the spot - but
       drawing is only wired up once the brand has said it wants to draw, and a
       crowded garment then has invisible patches where nothing happens at all
       and nothing explains why. The spots stop taking clicks instead. */
    e.preventDefault();
    /* Capture keeps the drag alive when the finger leaves the photograph, but
       it throws outright if the id is not an active pointer - a synthesised
       event, a pointer another element already captured, one the browser has
       cancelled. Uncaught, that abandons the whole handler and the drag never
       starts, so the failure is the one thing it must not be: silent. */
    try { pane.setPointerCapture(e.pointerId); } catch { /* drag still works */ }
    if (refused) { refused.remove(); refused = null; }
    /* A press that arrives while a draft is still in flight - a cancelled
       drag whose pointerup never came, a second finger - would otherwise
       abandon the old rectangle on the photograph for good. */
    clear();
    start = pct(e);
    /* Gathered once per drag, not once per frame: the neighbours cannot
       change while a finger is down, and rebuilding the bid index sixty times
       a second to draw one label would be work for nothing. */
    onSide = state.spots.filter(s => s.side === pane.dataset.side);
    bySpot = Store.bids.bySpot(state.bids);
    draft = document.createElement("div");
    draft.className = "spot-draft";
    /* Placed at the press, not left to find a static position. A drag moves
       it on the first frame anyway; a tap never gets one, and the refusal
       has to appear under the finger rather than wherever the box happened
       to flow to. */
    Object.assign(draft.style, { left: start.x + "%", top: start.y + "%", width: "0%", height: "0%" });
    label = document.createElement("span");
    draft.append(label);
    pane.append(draft);
  });

  pane.addEventListener("pointermove", e => {
    if (!start || !draft) return;
    e.preventDefault();
    const box = { ...boxFrom(pct(e)), side: pane.dataset.side };
    Object.assign(draft.style, {
      left: box.x + "%", top: box.y + "%", width: box.w + "%", height: box.h + "%",
    });
    /* The number moves with the hand. Quoting only after the drag ends makes
       the price feel like a verdict; quoting during it makes it a dial.

       And the same is true of the refusal. A box that is too small, too big
       or on top of somebody else says so while it is still being dragged,
       against the same rules the release will be judged by - so the brand
       corrects the shape it is holding rather than being told afterwards
       about one it no longer has. The price comes straight back the instant
       the box is legal again. */
    const check = Market.validateBox(box, state.listing, onSide);
    draft.classList.toggle("bad", !check.ok);
    label.textContent = check.ok
      ? money(boxPrice(box, state.listing))
      : shortRefusal(check.reason, box, onSide, bySpot);
  });

  const finish = e => {
    if (!start || !draft) return;
    const box = { ...boxFrom(pct(e)), side: pane.dataset.side };
    /* A tap used to be swallowed here without a word, on a panel the brand
       had just deliberately armed - so the one gesture a first-timer tries
       did nothing at all and nothing said why. */
    if (box.w < 1 || box.h < 1) { refuse("That was a tap. Drag a rectangle out."); return; }

    /* clear() after the verdict, not before. Removing the draft first meant
       every refusal deleted the rectangle it was about, leaving a toast in
       the corner of the screen and bare cloth where the box had been. */
    const reason = onBox(box);
    if (reason) { refuse(reason); return; }
    clear();
  };
  pane.addEventListener("pointerup", finish);
  pane.addEventListener("pointercancel", clear);
}

/* -------------------------------------------------------------- arming
   The toggle is the whole affordance: "drag the photograph" is not a thing
   anybody guesses, and on a phone an always-live drag surface eats the scroll.
   Arming also gives us somewhere honest to say no - a visitor who cannot draw
   yet is told why on the tap, rather than dragging and getting nothing. */
function setArming(on) {
  const refusal = on ? drawingRefusal() : null;
  if (refusal) { toast(refusal); return; }
  state.arming = !!on;
  renderGarment(true);
  if (state.arming) toast("Drag a rectangle over the patch you want.");
}

function syncDrawToggle() {
  const btn = $("#draw-toggle");
  if (!btn) return;
  const blocked = drawingRefusal();
  btn.hidden = !!blocked;
  btn.setAttribute("aria-pressed", String(state.arming));
  btn.textContent = state.arming ? "Cancel" : "Draw an area";
  btn.classList.toggle("ghost", state.arming);
  $("#draw-hint").textContent = state.arming
    ? "Drag across the fabric. The price follows the size of the box."
    : blocked || "Pick the patch of fabric you want — the price follows its size.";
}

$("#draw-toggle").addEventListener("click", () => setArming(!state.arming));

/* Everything a brand needs to be true before it can draw at all. */
function drawingRefusal() {
  const L = state.listing;
  if (!L || !L.is_open) return "Bidding is not open on this listing yet.";
  if (!L.photo_front || !L.photo_back) return "This listing does not have both photographs up yet.";
  return null;
}

/* A drawn box, from the drag to the bid sheet.

   Returns null when the box is on its way somewhere - the sheet, or the
   sign-up screen - and the reason when it is not. The caller is the drag
   itself, which keeps the rectangle on the cloth and writes the reason onto
   it, so a refusal is answered where it happened. */
function claimBox(box) {
  const L = state.listing;
  const refusal = drawingRefusal();
  if (refusal) return refusal;

  /* The shape is judged before the account is, and that order matters: a box
     that breaks the rules is refused where it was drawn, instead of sending
     somebody off to open an account and refusing them once they are back. */
  const onSide = state.spots.filter(s => s.side === box.side);
  const check = Market.validateBox(box, L, onSide);
  /* The engine's own sentence, not the four-word version. That one exists
     because a label inside a moving rectangle has no room; a refusal that has
     stopped moving has all the room it needs, and can say which spot was
     overlapped and why that matters. */
  if (!check.ok) return check.reason;

  const user = Store.auth.current();
  if (!user) {
    /* This one leaves the screen, so there is no rectangle left to mark - and
       the retry after sign-up has none either, which is why it has to say out
       loud whatever it is refused for the second time. */
    toast("Open an account to claim that area.");
    go("auth", { role: "brand", next: () => { const why = claimBox(box); if (why) toast(why, "bad"); } });
    return null;
  }
  if (user.role !== "brand") return `You are signed in as a ${SIDE.client}. Buying space is for ${SIDE.brand}s.`;

  /* Drawing stops here and nowhere earlier: this is the first moment the box
     is known to be one the brand can actually have. */
  setArming(false);
  openBid(null, box);
  return null;
}

/* ------------------------------------------------------- the photographs
   Both are required before the bidding can open, so this is the first thing a
   publisher does and the one thing that must not be fiddly. Drag a file onto
   the box or tap it; either way the same handler runs.

   This wiring was lost once already, when the publisher's spot editor was
   removed and took the neighbouring listener out with it. The symptom was
   silent: the file dialog opened, a file was chosen, and nothing happened at
   all - which, because a listing cannot open without both photographs, meant
   nobody who signed up could sell anything. */
$$(".drop[data-side]").forEach(drop => {
  const side = drop.dataset.side;
  const input = $("input[type=file]", drop);

  input.addEventListener("change", e => {
    const f = e.target.files && e.target.files[0];
    if (f) upload(side, f, drop);
  });

  /* Dropping a file on the page navigates to it unless both of these are
     cancelled, which looks exactly like the app crashing. */
  drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", e => {
    e.preventDefault();
    drop.classList.remove("over");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) upload(side, f, drop);
  });
});

async function upload(side, file, drop) {
  if (!state.listing) return;
  const big = $(".big", drop);
  const was = big.textContent;
  big.textContent = "Uploading…";
  drop.classList.remove("has");
  try {
    await Store.photos.upload(state.listing.id, side, file);
    big.textContent = "Uploaded ✓";
    /* The accepted state was written months ago and never fired, because
       nothing ever added the class. An upload that looks identical to no
       upload is how somebody ends up convinced the button is broken. */
    drop.classList.add("has");
    toast(`${side[0].toUpperCase() + side.slice(1)} photograph saved.`, "ok");
    await refresh();
  } catch (e) {
    big.textContent = was;
    toast(e.message, "bad");
  }
}

/* On every studio render, say which photographs are already up. Without this a
   publisher who comes back tomorrow sees two empty boxes and re-uploads what
   is already there. */
function syncDrops() {
  const L = state.listing;
  $$("#screen-studio .drop[data-side]").forEach(drop => {
    const has = !!(L && L["photo_" + drop.dataset.side]);
    drop.classList.toggle("has", has);
    const big = $(".big", drop);
    if (big) big.textContent = has ? "Uploaded ✓" : "Drop a photo";
    const small = $(".small", drop);
    if (small) small.textContent = has
      ? "Tap to replace it"
      : "or tap to choose · JPG or PNG · up to 8MB";
  });
}

/* ------------------------------------------------------------ studio bits */
$("#studio-front").addEventListener("click", () => { state.studioSide = "front"; syncStudioSide(); });
$("#studio-back-tab").addEventListener("click", () => { state.studioSide = "back"; syncStudioSide(); });
function syncStudioSide() {
  $("#studio-front").setAttribute("aria-pressed", String(state.studioSide === "front"));
  $("#studio-back-tab").setAttribute("aria-pressed", String(state.studioSide === "back"));
  renderStudio();
}

$("#terms-form").addEventListener("submit", async e => {
  e.preventDefault();
  const err = $("#terms-err"); err.hidden = true;

  /* Everything below refuses rather than repairs. The form used to accept a
     blank or an out-of-range answer and write a different number than the one
     on screen, which is the worst of both: the publisher's terms were wrong
     and the page agreed with them. */

  /* A blank rate saved as 0, and `priceForBox` then floored every patch of
     every size at the $1 minimum bid. The garment was being given away. */
  const rate = Number($("#t-rate").value);
  if (!Number.isFinite(rate) || rate < 1)
    return fail($("#t-rate"), "Put a price on 1% of the garment. Left empty it saves as 0, "
      + "and every patch a brand draws is then priced at the $1 minimum.", err);

  /* Math.min(5, Math.max(1, …)) quietly rewrote what she typed while the box
     still showed the original, so a publisher who meant ×8 got ×5 and was
     never told. */
  const mul = Number($("#t-frontmul").value);
  if (!Number.isFinite(mul) || mul < 1 || mul > 5)
    return fail($("#t-frontmul"), "The front premium has to be between 1 and 5.", err);

  /* A blank close does not mean "never closes". It writes closes_at: null,
     and the settlement job's `if (!force && closes && now < closes)` guard is
     then skipped entirely - so the next run captures every card on the
     listing at once, whenever it happens to fire. */
  const closesRaw = $("#t-closes").value;
  if (!closesRaw)
    return fail($("#t-closes"), "Say when the bidding closes. A blank one is not \"never\" — "
      + "it lets the settlement job capture every card on its next run.", err);
  const closes = new Date(closesRaw);
  if (Number.isNaN(closes.getTime()))
    return fail($("#t-closes"), "That is not a date and time we can read.", err);
  if (closes.getTime() < Date.now() + MIN_LEAD_MS)
    return fail($("#t-closes"), "Leave at least an hour. A close any sooner gives nobody "
      + "time to answer the last bid.", err);

  /* Bidding that runs past the day itself settles after the garment has been
     worn, so whoever won it is charged for a patch that was never printed. */
  const eventDay = $("#e-date").value;
  if (eventDay) {
    const endOfDay = new Date(eventDay + "T23:59:59");
    if (!Number.isNaN(endOfDay.getTime()) && closes.getTime() > endOfDay.getTime())
      return fail($("#t-closes"), `Bidding has to close on or before the day itself, ${eventDay}. `
        + "There is nothing to print after it.", err);
  }

  try {
    await Store.listings.update(state.listing.id, {
      garment: $("#t-garment").value,
      wears: $("#t-wears").value,
      names: $("#t-names").value.trim(),
      city: $("#t-city").value.trim(),
      goal: Number($("#t-goal").value) || 0,
      rate_per_percent: rate,
      front_multiplier: mul,
      /* `closes` came out of a datetime-local, so it is already local time
         read as local time. This is the correct half of the round trip - the
         fill in renderStudio is the half that had to change. */
      closes_at: closes.toISOString(),
      headline: $("#t-headline").value.trim(),
      tagline: $("#t-tagline").value.trim(),
      about: $("#t-about").value.trim(),
      instagram: $("#t-ig").value.trim().replace(/^@/, ""),
      twitter: $("#t-tw").value.trim().replace(/^@/, ""),
    });
    toast("Saved.", "ok");
    await refresh();
  } catch (e2) { err.textContent = e2.message; err.hidden = false; }
});

$("#terms-open").addEventListener("click", async () => {
  const L = state.listing;
  /* Brands draw their own spot straight onto the photograph, so a listing with
     only one side uploaded is a listing half of which cannot be sold.

     The refusal used to be a toast in the corner naming neither side, while
     the two drop boxes sit in the other column and may well be scrolled off.
     Now it names the missing side and puts the cursor in the box that wants
     the file. */
  if (!L.is_open && !(L.photo_front && L.photo_back)) {
    const missing = !L.photo_front ? "front" : "back";
    const why = L.photo_front || L.photo_back
      ? `Upload the ${missing} photograph first — sponsors buy the front and the back.`
      : "Upload a front and a back photograph first.";
    /* Both surfaces, and they are not the same job. The toast announces that
       the button did something; the mark on the drop box is what the
       publisher then acts on, and is the only one of the two that says WHICH
       box wants a file. */
    toast(why, "bad");
    return fail($(`input[type=file]`, $(`.drop[data-side="${missing}"]`)), why);
  }
  await Store.listings.update(L.id, { is_open: !L.is_open });
  toast(L.is_open ? "Bidding closed." : "Bidding is open.", "ok");
  await refresh();
});

$("#event-form").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    await Store.listings.update(state.listing.id, {
      invited: Number($("#e-invited").value) || 0,
      confirmed: Number($("#e-confirmed").value) || 0,
      event_date: $("#e-date").value || null,
      venue: $("#e-venue").value.trim(),
      reach: Number($("#e-reach").value) || 0,
      livestream: $("#e-live").checked,
    });
    toast("Saved.", "ok");
    await refresh();
  } catch (e2) { toast(e2.message, "bad"); }
});

$("#studio-view").addEventListener("click", () => go("campaign"));
$("#studio-share").addEventListener("click", () => openShare(null));
$("#studio-back").addEventListener("click", () => go("home"));
$("#hero-share").addEventListener("click", () => openShare(null));

/* =========================================================================
   navigation chrome
   ========================================================================= */
$("#burger").addEventListener("click", () => {
  const open = $("#mobnav").classList.toggle("open");
  $("#burger").setAttribute("aria-expanded", String(open));
});
function closeMobNav() {
  $("#mobnav").classList.remove("open");
  $("#burger").setAttribute("aria-expanded", "false");
}
$$("#mobnav a").forEach(a => a.addEventListener("click", closeMobNav));
$("#home-link").addEventListener("click", () => go("home"));

/* The publisher door. Where it lands depends on who is already signed in:
   a publisher goes straight to their own listing, everyone else is asked to
   open the right kind of account first. */
async function startPublishing() {
  const u = Store.auth.current();
  if (u && u.role === "client") { await enterStudio(); return; }
  if (u && u.role === "brand") {
    toast(`This account buys space. Listing a garment needs a ${SIDE.client} account.`);
    return;
  }
  go("auth", { role: "client" });
}

function scrollHomeTo(id) {
  const jump = () => { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: "smooth" }); };
  /* go() closes the burger on its own; jumping within a screen it has already
     drawn does not, and the menu would stay open over what we scrolled to. */
  if (state.screen === "home") { closeMobNav(); jump(); }
  else { go("home"); setTimeout(jump, 60); }
}

const NAV = {
  browse: () => go("browse"),
  how: () => scrollHomeTo("home-how"),
  publish: startPublishing,
};
$$("#nav-browse, #mob-browse, #door-brand, #home-seeall").forEach(b =>
  b.addEventListener("click", NAV.browse));
$$("#nav-how, #mob-how").forEach(b => b.addEventListener("click", NAV.how));
$$("#nav-publish, #mob-publish, #door-publisher").forEach(b =>
  b.addEventListener("click", NAV.publish));
$("#campaign-back").addEventListener("click", () => go("browse"));

$$("[data-nav]").forEach(a => a.addEventListener("click", e => {
  e.preventDefault();
  (NAV[a.dataset.nav] || NAV.browse)();
}));

$("#side-front").addEventListener("click", () => { state.side = "front"; syncSide(); });
$("#side-back").addEventListener("click", () => { state.side = "back"; syncSide(); });
function syncSide() {
  $("#side-front").setAttribute("aria-pressed", String(state.side === "front"));
  $("#side-back").setAttribute("aria-pressed", String(state.side === "back"));
  renderGarment(true);
}

$$("[data-legal]").forEach(a => a.addEventListener("click", e => {
  e.preventDefault();
  const which = a.dataset.legal;
  const copy = {
    terms: "Square Inch is a marketplace. The wearer owns the garment and decides what goes on it; the sponsor owns its mark and warrants it has the right to place it. Placement is a licence for the day of the event, not an assignment. Our platform fee is charged to the sponsor on top of the settled price, so the settled price is the wearer's in full; the fee is shown before you bid.",
    privacy: "We store your email, your display name, your brand name, your logo and your bidding history. Session cookies are httpOnly and same-site. We do not sell anything to anyone and we do not run third-party analytics. Card details never reach our servers — Stripe holds them.",
    refunds: "Being outbid releases your authorisation in full, automatically, within minutes. If the campaign goal is not reached by the close, every authorisation is released and nobody is charged. Once a spot has settled and been captured, it is refundable only if the event does not take place.",
    content: "No marks you do not own. Nothing unlawful, hateful, or sexual. No political campaigning. The wearer has the final say on what goes on their own garment and may decline any sponsor without giving a reason; a declined bid is released in full.",
  }[which];
  openSheet({ kicker: "Legal", title: a.textContent, body: `<p class="lead" style="font-size:.93rem">${esc(copy)}</p>` });
}));

/* the sticky bar only earns its space once something is selected */
$("#actionbar").classList.remove("show");

/* =========================================================================
   loading and refreshing
   ========================================================================= */
async function load(listingId) {
  if (state.unsubscribe) { state.unsubscribe(); state.unsubscribe = null; }
  const L = await Store.listings.get(listingId);
  if (!L) { toast("That listing is gone.", "bad"); return; }
  state.listing = L;
  [state.spots, state.bids] = await Promise.all([
    Store.spots.list(listingId),
    Store.bids.list(listingId),
  ]);
  state.unsubscribe = Store.subscribe(listingId, debounce(refresh, 400));
  renderAll();
}

async function refresh() {
  /* Anything that moves a bid or a listing also moves the directory, so the
     cached copy of it goes stale here rather than staying wrong until reload. */
  state.directory = [];
  if (!state.listing) return;
  const id = state.listing.id;
  try {
    const [L, spots, bids] = await Promise.all([
      Store.listings.get(id), Store.spots.list(id), Store.bids.list(id),
    ]);
    if (L) state.listing = L;
    state.spots = spots; state.bids = bids;
  } catch (e) { console.warn("refresh failed:", e.message); }
  renderAll();
}

function renderAll() {
  renderCampaign();
  if (state.screen === "studio") renderStudio();
  if (state.screen === "home") renderHome();
  if (state.screen === "browse") renderBrowse();
  renderAccount();
}

/* the countdown runs on its own clock so the whole page is not re-rendered */
function tickClock() {
  const L = state.listing;
  if (!L) return;
  $("#goal-clock").textContent = Market.countdown(L.closes_at);
}
setInterval(tickClock, 1000);

/* reveal on scroll */
const io = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add("shown"); io.unobserve(e.target); } });
}, { rootMargin: "0px 0px -8% 0px" });
setTimeout(() => $$(".rv").forEach(el => io.observe(el)), 60);

/* redraw the garment when the layout crosses the one-panel / two-panel line */
window.addEventListener("resize", debounce(() => {
  if (state.screen === "campaign") renderGarment(true);
}, 200));

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* =========================================================================
   boot
   ========================================================================= */
(async function boot() {
  /* Anything that throws in here used to leave the page exactly as the server
     sent it. That is survivable now the front door ships visible, but the
     reader still deserves to be told, rather than sitting in front of a
     marketplace that is silently empty. */
  try {
    await bootReally();
  } catch (e) {
    console.error("boot failed:", e);
    const grid = $("#home-featured");
    if (grid) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
        <h3>We could not reach the market</h3>
        <p>The page loaded but the listings did not. Reload, and if it keeps happening
           it is us, not you.</p></div>`;
    }
    toast("Could not load the marketplace. Try reloading.", "bad");
  }
})();

async function bootReally() {
  const { mode } = await Store.init();
  $("#foot-mode").textContent = mode === "supabase"
    ? `Live · ${Store.config.publishableKey ? "payments on" : "payments not configured"}`
    : "Demo mode · nothing here is stored on a server";

  /* Social sign-in only exists when there is a project behind it. */
  $("#oauth-block").hidden = mode !== "supabase";

  Store.auth.onChange(() => { renderAccount(); askRoleIfNeeded(); });
  renderAccount();
  askRoleIfNeeded();

  const params = new URLSearchParams(location.search);

  /* back from Stripe */
  if (params.get("paid") === "1") toast("Payment authorised. The spot is yours until someone beats it.", "ok");
  if (params.get("paid") === "0") toast("Checkout cancelled — no bid was placed.");

  /* A link to one publisher opens that publisher. Everyone else lands on the
     front door and says which side of the table they are on. */
  const id = params.get("l");
  if (!id) { go("home"); return; }

  await load(id);
  go("campaign");

  const spotParam = params.get("spot");
  if (spotParam && state.spots.some(s => s.id === spotParam)) {
    selectSpot(spotParam, false);
    document.getElementById("spots").scrollIntoView({ behavior: "smooth" });
  }
}
