/* =========================================================================
   Square Inch - the application.

   Four screens behind one page: the campaign (the thing a brand lands on),
   the book (every open garment), auth, and the studio (the publisher's side).
   Everything below assumes a phone first; the desktop layout is what the CSS
   adds on top, not the other way round.
   ========================================================================= */
"use strict";

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ------------------------------------------------------------------ state */
const state = {
  screen: "campaign",
  listing: null,
  spots: [],
  bids: [],
  side: "front",
  studioSide: "front",
  selected: null,
  drawing: false,
  unsubscribe: null,
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

/* Everything that reaches innerHTML goes through this. User-supplied brand
   names and blurbs are rendered all over the page; none of them are trusted. */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
/* A URL that is safe to put in src=. Blocks javascript: and data: text. */
function safeUrl(u) {
  const s = String(u || "").trim();
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

/* ------------------------------------------------------------------ sheet */
/* Remembered as a SELECTOR, not a node: the spot list re-renders while the
   sheet is open, so the element that opened it is usually detached by the
   time we try to hand focus back, and .focus() on a detached node silently
   does nothing. */
let lastFocusSel = null;

const OUTSIDE = "header.topbar, main, footer.foot, .actionbar, .tick";

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
  gown: {
    front: `<path d="M112 58 L188 58 L178 168 C178 168 250 244 254 384 L46 384 C50 244 122 168 122 168 Z"/>
            <path d="M138 58 Q150 84 162 58" fill="none" stroke-width="2" opacity=".45"/>
            <path d="M150 168 L150 384" fill="none" stroke-width="1.5" opacity=".2"/>`,
    back:  `<path d="M112 58 L188 58 L178 168 C178 168 250 244 254 384 L46 384 C50 244 122 168 122 168 Z"/>
            <path d="M150 58 L150 168" fill="none" stroke-width="2" opacity=".45"/>
            <path d="M126 92 Q150 104 174 92" fill="none" stroke-width="1.5" opacity=".3"/>`,
  },
  suit: {
    front: `<path d="M96 62 L204 62 L214 196 L198 384 L156 384 L150 236 L144 384 L102 384 L86 196 Z"/>
            <path d="M150 62 L132 130 L150 236 L168 130 Z" fill="none" stroke-width="2" opacity=".45"/>`,
    back:  `<path d="M96 62 L204 62 L214 196 L198 384 L156 384 L150 236 L144 384 L102 384 L86 196 Z"/>
            <path d="M150 62 L150 384" fill="none" stroke-width="2" opacity=".3"/>
            <path d="M104 118 L196 118" fill="none" stroke-width="1.5" opacity=".25"/>`,
  },
};

function silhouetteSvg(garment, side) {
  const g = SILHOUETTE[garment] || SILHOUETTE.gown;
  return `<svg viewBox="0 0 300 420" role="img" aria-label="${esc(garment)}, ${esc(side)}">
    <g fill="rgba(251,243,255,.1)" stroke="rgba(251,243,255,.45)" stroke-width="1.5"
       stroke-linejoin="round">${g[side] || g.front}</g></svg>`;
}

/* One panel: the picture plus every spot on that side. */
function garmentPanel(side, { interactive = true, editing = false } = {}) {
  const L = state.listing;
  if (!L) return "";
  const photo = safeUrl(L["photo_" + side]);
  const bySpot = Store.bids.bySpot(state.bids);
  const spots = state.spots.filter(s => s.side === side);

  const art = photo
    ? `<img src="${esc(photo)}" alt="The ${esc(L.garment)}, ${esc(side)}" loading="lazy" decoding="async">`
    : silhouetteSvg(L.garment, side) +
      `<div class="empty"><p class="lbl">No photograph yet</p>
         <p style="font-size:.85rem">Spots are marked out on the drawing until one is uploaded.</p></div>`;

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
    <div class="garment${editing ? " editing" : ""}" data-side="${side}">${art}${marks}</div>
  </div>`;
}

function renderGarment() {
  const wrap = $("#garment-wrap");
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
}

/* =========================================================================
   campaign screen
   ========================================================================= */
function renderCampaign() {
  const L = state.listing;
  if (!L) return;
  const bySpot = Store.bids.bySpot(state.bids);
  const c = Store.campaign(state.spots, bySpot, L.goal);

  /* hero ------------------------------------------------------------- */
  $("#hero-kicker").textContent = L.is_open
    ? `Live auction · ${L.garment === "suit" ? "the suit" : "the dress"} · ${L.city || ""}`.trim()
    : "Bidding has not opened yet";
  $("#hero-h1").innerHTML = L.headline
    ? esc(L.headline)
    : `Walking billboard <span class="grad">for your brand</span>`;
  $("#hero-lead").textContent = L.tagline ||
    `Your logo on ${esc(L.names || "the garment")}, worn all day, in every photograph taken.`;

  /* goal ------------------------------------------------------------- */
  $("#goal-raised").textContent = money(c.raised);
  $("#goal-target").textContent = money(c.goal);
  $("#goal-open").textContent = c.open;
  $("#goal-total").textContent = c.total;
  requestAnimationFrame(() => { $("#goal-bar").style.width = (c.pct * 100).toFixed(1) + "%"; });
  $("#goal-refund").textContent = c.met
    ? "Goal reached — this is going ahead"
    : "Refunded in full if the goal is not reached";
  $("#garment-pill").innerHTML = L.is_open
    ? `<span class="beat"></span> Live`
    : `Not open`;

  renderGarment();
  renderSpotList(bySpot);
  renderFeature(bySpot);
  renderWall(bySpot);
  renderEventCard(c);
  renderAbout();
  renderSocial();
  tickClock();
  renderTicker(c);
}

/* the numbers strip under the header */
function renderTicker(c) {
  const L = state.listing;
  const cells = [
    ["Raised", money(c.raised), "m"],
    ["Spots open", `${c.open}/${c.total}`, "a"],
    ["Bids", String(state.bids.length), ""],
    ["Highest", money(Math.max(0, ...state.spots.map(s =>
      Store.market(s, Store.bids.bySpot(state.bids)[s.id]).price))), "g"],
    ["Closes", Market.countdown(L.closes_at), "m"],
  ];
  $("#tick").innerHTML = cells.map(([k, v, cls]) =>
    `<div class="c"><span class="k">${esc(k)}</span><span class="v ${cls}">${esc(v)}</span></div>`).join("");
}

/* the list of spots, grouped front then back */
function renderSpotList(bySpot) {
  const sides = ["front", "back"];
  const html = sides.map(side => {
    const rows = state.spots.filter(s => s.side === side);
    if (!rows.length) return "";
    return `<div class="side-hd"><p class="lbl">${side} of the ${esc(state.listing.garment)}</p>
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
          ${st.holder ? `<span class="who">Held by ${esc(st.holderName || "a brand")} at ${money(st.price)}</span>` : ""}
        </button>`;
      }).join("");
  }).join("");

  $("#spotlist").innerHTML = html ||
    `<div class="empty-state"><h3>No spots marked out yet</h3>
     <p>The publisher has not laid any out on the garment.</p></div>`;
  $$("#spotlist .srow").forEach(b =>
    b.addEventListener("click", () => openBid(b.dataset.spot)));
}

/* the one spot the page argues for */
function renderFeature(bySpot) {
  const s = state.spots.find(x => x.badge === "MEGA")
        || state.spots.slice().sort((a, b) => b.floor - a.floor)[0];
  if (!s) { $("#feature-wrap").hidden = true; return; }
  $("#feature-wrap").hidden = false;
  const st = Store.market(s, bySpot[s.id]);
  const min = Store.minimum(s, bySpot[s.id]);

  $("#feature").innerHTML = `
    <p class="lbl">Only one exists</p>
    <h2 style="margin-top:10px">${esc(s.name)} — <span class="grad">${money(st.holder ? min : st.price)}</span></h2>
    <p class="lead" style="margin-top:14px">${esc(s.blurb || "")}</p>
    <ul>
      <li>A dedicated piece of content for your brand alone</li>
      <li>The largest single area on the ${esc(s.side)} of the ${esc(state.listing.garment)}</li>
      <li>Guaranteed thumbnail placement in the recap video</li>
      <li>${st.holder ? `Currently held by ${esc(st.holderName || "a brand")} at ${money(st.price)} — it is still takeable`
                      : `Position ${+s.n} on the ${esc(s.side)}. Nobody has it yet.`}</li>
    </ul>
    <div style="display:flex;gap:11px;flex-wrap:wrap;margin-top:24px">
      <button class="btn" data-spot="${esc(s.id)}" id="feature-go">${st.holder ? "Take this spot" : "Claim this spot"}</button>
      <button class="btn ghost" id="feature-share">Share it</button>
    </div>`;
  $("#feature-go").addEventListener("click", () => openBid(s.id));
  $("#feature-share").addEventListener("click", () => openShare(s));
}

/* wall of marks */
function renderWall(bySpot) {
  const held = state.spots
    .map(s => ({ s, st: Store.market(s, bySpot[s.id]) }))
    .filter(x => x.st.holder);

  const slots = held.map(({ st }) => {
    const logo = safeUrl(st.holderLogo);
    return `<div class="slot">${logo
      ? `<img src="${esc(logo)}" alt="${esc(st.holderName || "Sponsor")}" loading="lazy">`
      : `<b>${esc(st.holderName || "Sponsor")}</b>`}</div>`;
  });

  const blanks = Math.max(0, Math.min(6, state.spots.length - held.length));
  for (let i = 0; i < blanks; i++) slots.push(`<div class="slot blank">Open</div>`);

  $("#wall").innerHTML = slots.length ? slots.join("")
    : `<div class="slot blank" style="grid-column:1/-1;aspect-ratio:auto;padding:34px">Nobody yet. Be the first mark on it.</div>`;
}

/* the day itself, with the audience workings shown rather than one number */
function renderEventCard(c) {
  const L = state.listing;
  const a = audience(L);
  const cpm = a.total > 0 ? (c.raised / a.total) * 1000 : 0;

  $("#event-card").innerHTML = `
    <p class="lbl">The day</p>
    <h2 style="margin-top:10px">${esc(L.venue || "The wedding")}${L.city ? ` · ${esc(L.city)}` : ""}</h2>
    <p class="lead" style="margin-top:14px">
      ${esc(L.confirmed || 0)} confirmed of ${esc(L.invited || 0)} invited${L.venue_type ? `, ${esc(L.venue_type)}` : ""}.
      ${L.shooters ? `Shot by ${esc(L.shooters)}. ` : ""}${L.livestream ? "The ceremony is being livestreamed. " : ""}
      ${L.press ? esc(L.press) + "." : ""}
    </p>
    <div class="tbl-scroll" style="margin-top:22px">
      <table class="tbl">
        <thead><tr><th>Where the impressions come from</th><th style="text-align:end">Estimate</th></tr></thead>
        <tbody>
          <tr><td data-k="In the room">In the room — ${num(L.confirmed || 0)} guests × 12 exposures across the day</td>
              <td data-k="Estimate" class="num" style="text-align:end">${num(a.inRoom)}</td></tr>
          <tr><td data-k="Social + gallery">Social and the gallery — ${num(L.reach || 0)} reach × the 15% that actually surfaces</td>
              <td data-k="Estimate" class="num" style="text-align:end">${num(a.social)}</td></tr>
          ${a.livestream ? `<tr><td data-k="Livestream">Livestream</td>
              <td data-k="Estimate" class="num" style="text-align:end">${num(a.livestream)}</td></tr>` : ""}
          <tr><td data-k="Total"><b>Total, deliberately conservative</b></td>
              <td data-k="Total" class="num" style="text-align:end"><b>${num(a.total)}</b></td></tr>
          <tr><td data-k="Cost per thousand"><b>Cost per thousand at the current clearing price</b></td>
              <td data-k="CPM" class="num" style="text-align:end"><b>${money(cpm, { cents: true })}</b></td></tr>
        </tbody>
      </table>
    </div>
    ${L.hashtag ? `<p class="hint" style="margin-top:14px">Everything goes out under <b>${esc(L.hashtag)}</b>.</p>` : ""}`;
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
    <div style="width:96px;height:96px;border-radius:50%;flex:none;border:2px solid var(--edge);
                background:linear-gradient(135deg,var(--magenta),var(--amber));
                display:flex;align-items:center;justify-content:center;
                font-family:'Bodoni Moda',serif;font-size:2rem;color:#20081A">
      ${esc((L.names || "?").trim()[0] || "?")}</div>
    <div>
      <p class="lbl">About</p>
      <h2 style="margin-top:8px">${esc(L.names || "The publisher")}</h2>
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
    title: `Ask ${L.names || "the publisher"}`,
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
          return `<div style="justify-self:${meName ? "end" : "start"};max-width:85%;
                        border:1px solid var(--edge-soft);border-radius:var(--r);
                        padding:9px 12px;background:rgba(0,0,0,${meName ? ".18" : ".3"})">
            <div class="lbl" style="font-size:.58rem;margin-bottom:4px">
              ${esc(m.display_name || m.who || "someone")}${m.role === "client" ? " · publisher" : ""}</div>
            <div style="font-size:.9rem;line-height:1.45">${esc(m.body || m.text || "")}</div>
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
  u.searchParams.set("l", state.listing.id);
  if (spot) u.searchParams.set("spot", spot.id);
  return u.toString();
}

function openShare(spot) {
  const L = state.listing;
  const url = shareUrl(spot);
  const text = spot
    ? `Spot ${String(+spot.n).padStart(2, "0")} — ${spot.name} — on ${L.names}'s ${L.garment}. Bidding is open.`
    : `${L.names} are selling advertising space on ${L.garment === "suit" ? "the suit" : "the dress"}. Numbered spots, open bidding.`;

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
        window.open(L.instagram ? `https://instagram.com/${encodeURIComponent(L.instagram)}` : "https://instagram.com", "_blank", "noopener");
      });
    },
  });
}

/* =========================================================================
   bidding
   ========================================================================= */
function selectSpot(id, scroll) {
  state.selected = id;
  renderGarment();
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

function openBid(spotId) {
  const spot = state.spots.find(s => s.id === spotId);
  if (!spot) return;
  const L = state.listing;
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
    go("auth", { role: "brand", next: () => openBid(spotId) });
    return;
  }
  if (user.role !== "brand") { toast("You are signed in as a publisher. Bidding is for brands."); return; }

  openSheet({
    kicker: `${spot.side} · position ${String(+spot.n).padStart(2, "0")}`,
    title: spot.name,
    body: `
      <p class="lead" style="font-size:.92rem">${esc(spot.blurb || "")}</p>

      <div class="quote" style="margin-top:18px">
        <div class="ln"><span class="k">${st.holder ? "Standing price" : "Floor"}</span>
          <span class="v">${money(st.price)}</span></div>
        ${st.holder ? `<div class="ln"><span class="k">Held by</span><span class="v">${esc(st.holderName || "a brand")}</span></div>` : ""}
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
        <p class="err" id="bid-err" hidden></p>
        <button class="btn wide" type="submit" id="bid-go" style="margin-top:16px">
          <span>${st.holder ? "Take the spot" : "Claim the spot"}</span></button>
        <p class="hint" style="text-align:center;margin-top:12px">
          Card handled by Stripe on its own page. Outbid before close and the hold is released in full.</p>
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
        const settlesLine = v.blind
          ? `<div class="ln"><span class="k">Settles between</span><span class="v">${money(owed.placement, { cents: true })} – ${money(v.max, { cents: true })}</span></div>
             <div class="ln"><span class="k">Where it lands depends on the current holder's maximum, which is sealed. You are told the moment your bid is in.</span></div>`
          : `<div class="ln"><span class="k">Settles at today</span><span class="v">${money(owed.placement, { cents: true })}</span></div>
             <div class="ln"><span class="k">Platform fee, ${fee}%</span><span class="v">${money(owed.fee, { cents: true })}</span></div>
             <div class="ln"><span class="k">Owed if it closed now</span><span class="v">${money(owed.total, { cents: true })}</span></div>`;

        quoteEl.innerHTML = settlesLine + `
          <div class="ln tot"><span class="k">Held on your card</span><span class="v">${money(held.total, { cents: true })}</span></div>
          ${gap > 0.005 && !v.blind
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
        const brand = $("#bid-brand", root).value.trim();
        const max = Number(maxEl.value);
        const v = Store.quote(spot, mine, { bidder: user.id, brand, max });
        if (!v.ok) { errEl.textContent = v.reason; errEl.hidden = false; return; }
        if (!brand) { errEl.textContent = "A brand name is required."; errEl.hidden = false; return; }

        goEl.setAttribute("aria-disabled", "true");
        goEl.innerHTML = `<span class="spin"></span><span>Talking to Stripe…</span>`;
        try {
          const res = await Store.bids.place({ listingId: L.id, spotId: spot.id, max, brand, logo: logoData });
          if (res.url) { location.href = res.url; return; }          // Stripe's hosted page
          closeSheet();
          await refresh();
          toast(res.demo
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
const SCREENS = ["campaign", "book", "auth", "studio"];
let authNext = null;

function go(screen, opts = {}) {
  state.screen = screen;
  SCREENS.forEach(s => { $("#screen-" + s).hidden = s !== screen; });
  $("#actionbar").classList.toggle("show", screen === "campaign" && !!state.selected);
  document.body.classList.toggle("has-actionbar", screen === "campaign" && !!state.selected);
  $("#navlinks").style.visibility = screen === "campaign" ? "" : "hidden";
  closeMobNav();
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });

  if (screen === "auth") {
    authNext = opts.next || null;
    if (opts.role) setRole(opts.role);
  }
  if (screen === "book") renderBook();
  if (screen === "studio") renderStudio();
}

/* =========================================================================
   the book
   ========================================================================= */
async function renderBook() {
  const grid = $("#book-grid");
  grid.innerHTML = `<div class="empty-state"><span class="spin" style="margin:0 auto"></span></div>`;
  let all = [];
  try { all = await Store.listings.list({ openOnly: true }); }
  catch (e) { toast(e.message, "bad"); }

  const q = $("#book-search").value.trim().toLowerCase();
  const rows = all.filter(l => !q ||
    [l.names, l.city, l.venue].filter(Boolean).join(" ").toLowerCase().includes(q));

  if (!rows.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>Nothing open</h3>
      <p>No garment is taking bids right now.</p></div>`;
    return;
  }

  const cards = await Promise.all(rows.map(async l => {
    let spots = [], bids = [];
    try { [spots, bids] = await Promise.all([Store.spots.list(l.id), Store.bids.list(l.id)]); } catch { /* keep the card */ }
    const c = Store.campaign(spots, Store.bids.bySpot(bids), l.goal);
    const photo = safeUrl(l.photo_front);
    return `<button class="lot" data-listing="${esc(l.id)}">
      <div class="shot">${photo
        ? `<img src="${esc(photo)}" alt="" loading="lazy">`
        : `<div style="display:grid;place-items:center;height:100%">${silhouetteSvg(l.garment, "front")}</div>`}</div>
      <div class="body">
        <h3>${esc(l.names)}</h3>
        <p class="meta">${esc(l.city || "")}${l.event_date ? ` · ${esc(l.event_date)}` : ""} · ${esc(l.garment)}</p>
        <div class="foot-line">
          <span>${money(c.raised)} / ${money(c.goal)}</span>
          <span style="color:var(--aqua)">${c.open} open</span>
        </div>
      </div></button>`;
  }));

  grid.innerHTML = cards.join("");
  $$("#book-grid .lot").forEach(b => b.addEventListener("click", async () => {
    await load(b.dataset.listing);
    go("campaign");
  }));
}
$("#book-search").addEventListener("input", debounce(renderBook, 220));

/* =========================================================================
   auth
   ========================================================================= */
let authMode = "up", authRole = "client";

function setRole(role) {
  authRole = role;
  $("#role-client").setAttribute("aria-pressed", String(role === "client"));
  $("#role-brand").setAttribute("aria-pressed", String(role === "brand"));
  $("#au-brand-fld").hidden = role !== "brand";
  $("#au-name-label").textContent = role === "client" ? "Your name" : "Your name";
  $("#auth-lead").textContent = role === "client"
    ? "You list a garment, mark out the spots and set the floors."
    : "You bid on spots and your mark goes on the garment.";
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

  if (!email || !password) { err.textContent = "Email and password, please."; err.hidden = false; return; }
  if (authMode === "up" && password.length < 8) { err.textContent = "Use at least 8 characters."; err.hidden = false; return; }
  if (authMode === "up" && !name) { err.textContent = "What should we call you?"; err.hidden = false; return; }

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
    if (next) { go("campaign"); next(); }
    else if (u.role === "client") await enterStudio();
    else go("campaign");
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
          <span><b style="display:block">It's my garment</b>
          <span style="color:var(--soft);font-size:.86rem">I'm selling space on a gown or a suit</span></span>
        </button>
        <button class="btn ghost wide" data-role="brand" style="justify-content:flex-start;text-align:start;height:auto;padding:16px 20px">
          <span><b style="display:block">I'm buying</b>
          <span style="color:var(--soft);font-size:.86rem">I want my brand on somebody's garment</span></span>
        </button>
      </div>

      <div class="fld" id="role-brand-name" style="margin-top:18px" hidden>
        <label for="rc-brand">Brand name</label>
        <input class="inp" id="rc-brand" type="text" maxlength="60" placeholder="What should appear on the garment?">
      </div>
      <p class="err" id="rc-err" hidden></p>
      <button class="btn wide" id="rc-go" style="margin-top:16px" aria-disabled="true">Confirm</button>`,

    onOpen(root) {
      let picked = null;
      const brandFld = $("#role-brand-name", root);
      const go = $("#rc-go", root);

      $$("[data-role]", root).forEach(b => b.addEventListener("click", () => {
        picked = b.dataset.role;
        $$("[data-role]", root).forEach(x => x.style.borderColor = "");
        b.style.borderColor = "var(--magenta)";
        brandFld.hidden = picked !== "brand";
        go.removeAttribute("aria-disabled");
      }));

      go.addEventListener("click", async () => {
        const err = $("#rc-err", root);
        err.hidden = true;
        if (!picked) { err.textContent = "Pick one."; err.hidden = false; return; }
        const brand = picked === "brand" ? $("#rc-brand", root).value.trim() : null;
        if (picked === "brand" && !brand) { err.textContent = "A brand name is required."; err.hidden = false; return; }
        go.setAttribute("aria-disabled", "true");
        go.innerHTML = `<span class="spin"></span>`;
        try {
          await Store.auth.chooseRole(picked, brand);
          askingRole = false;
          closeSheet();
          toast(picked === "client" ? "You're set up as a publisher." : `Bidding as ${brand}.`, "ok");
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
    right.innerHTML = `<button class="btn sm" id="nav-get">Get a spot</button>`;
    mob.innerHTML = `<button class="btn wide" id="mob-get">Get a spot</button>`;
    const open = () => go("auth", { role: "brand" });
    $("#nav-get").addEventListener("click", open);
    $("#mob-get").addEventListener("click", open);
    return;
  }

  const label = esc(u.brand || u.name);
  right.innerHTML = `
    ${u.role === "client" ? `<button class="btn ghost sm" id="nav-studio">My listing</button>` : ""}
    <button class="btn quiet sm" id="nav-out">${label} · Sign out</button>`;
  mob.innerHTML = `
    ${u.role === "client" ? `<button class="btn ghost wide" id="mob-studio">My listing</button>` : ""}
    <button class="btn quiet wide" id="mob-out">${label} · Sign out</button>`;

  const out = async () => { await Store.auth.signOut(); toast("Signed out."); go("campaign"); };
  $$("#nav-out, #mob-out").forEach(b => b.addEventListener("click", out));
  $$("#nav-studio, #mob-studio").forEach(b => b.addEventListener("click", enterStudio));
}

/* =========================================================================
   studio
   ========================================================================= */
async function enterStudio() {
  const u = Store.auth.current();
  if (!u || u.role !== "client") { toast("Only a publisher has a listing."); return; }
  let mine = await Store.listings.mine();
  if (!mine.length) {
    const created = await Store.listings.create({
      names: u.name, garment: "gown",
      closes_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      headline: "Walking billboard for your brand",
      tagline: "Your logo on the dress, worn all day.",
    });
    mine = [created];
    toast("Listing created. Upload a photograph and mark out your first spot.", "ok");
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

  $("#studio-stats").innerHTML = `
    <div class="stat"><div class="k">Committed</div><div class="v w">${money(c.raised)}</div><div class="d">of ${money(c.goal)}</div></div>
    <div class="stat"><div class="k">Bids</div><div class="v">${state.bids.length}</div><div class="d">from ${plural(new Set(state.bids.map(b => b.bidder)).size, "brand")}</div></div>
    <div class="stat"><div class="k">Spots held</div><div class="v g">${c.held}/${c.total}</div><div class="d">${c.open} still open</div></div>
    <div class="stat"><div class="k">Closes in</div><div class="v a">${esc(Market.countdown(L.closes_at))}</div><div class="d">your deadline</div></div>`;

  $("#studio-spotcount").textContent = plural(state.spots.length, "spot");
  $("#studio-bidcount").textContent = plural(state.bids.length, "bid");

  /* the editable garment */
  const side = state.studioSide;
  $("#studio-garment").innerHTML = garmentPanel(side, { interactive: true, editing: state.drawing });
  wireStudioGarment();

  /* bids table */
  const rows = state.bids.slice().sort((a, b) => b.at - a.at).map(b => {
    const spot = state.spots.find(s => s.id === b.spotId);
    const st = spot ? Store.market(spot, bySpot[spot.id]) : null;
    const holding = st && st.holder === b.bidder;
    return `<tr>
      <td data-k="Brand">${esc(b.brand)}</td>
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
  $("#t-names").value = L.names || "";
  $("#t-city").value = L.city || "";
  $("#t-goal").value = L.goal || 0;
  $("#t-closes").value = L.closes_at ? new Date(L.closes_at).toISOString().slice(0, 16) : "";
  $("#t-headline").value = L.headline || "";
  $("#t-tagline").value = L.tagline || "";
  $("#t-about").value = L.about || "";
  $("#t-ig").value = L.instagram || "";
  $("#t-tw").value = L.twitter || "";
  $("#terms-open").textContent = L.is_open ? "Close the bidding" : "Open the bidding";

  $("#e-invited").value = L.invited || 0;
  $("#e-confirmed").value = L.confirmed || 0;
  $("#e-date").value = L.event_date || "";
  $("#e-venue").value = L.venue || "";
  $("#e-venuetype").value = L.venue_type || "";
  $("#e-shooters").value = L.shooters || "";
  $("#e-reach").value = L.reach || 0;
  $("#e-hashtag").value = L.hashtag || "";
  $("#e-press").value = L.press || "";
  $("#e-live").checked = !!L.livestream;

  const a = audience(L);
  $("#audience-out").innerHTML = `
    <div class="quote">
      <div class="ln"><span class="k">In the room</span><span class="v">${num(a.inRoom)}</span></div>
      <div class="ln"><span class="k">Social and gallery</span><span class="v">${num(a.social)}</span></div>
      ${a.livestream ? `<div class="ln"><span class="k">Livestream</span><span class="v">${num(a.livestream)}</span></div>` : ""}
      <div class="ln tot"><span class="k">Estimated impressions</span><span class="v">${num(a.total)}</span></div>
    </div>`;
}

/* ---------------------------------------------------- drawing out a spot */
function wireStudioGarment() {
  const pane = $("#studio-garment .garment");
  if (!pane) return;

  $$("#studio-garment .spot").forEach(b =>
    b.addEventListener("click", e => { e.stopPropagation(); editSpot(b.dataset.spot); }));

  if (!state.drawing) return;

  let start = null, draft = null;
  const pct = e => {
    const r = pane.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return {
      x: Math.min(100, Math.max(0, ((p.clientX - r.left) / r.width) * 100)),
      y: Math.min(100, Math.max(0, ((p.clientY - r.top) / r.height) * 100)),
    };
  };

  const down = e => {
    if (e.target.closest(".spot")) return;
    e.preventDefault();
    start = pct(e);
    draft = document.createElement("div");
    draft.className = "spot-draft";
    pane.append(draft);
  };
  const move = e => {
    if (!start || !draft) return;
    e.preventDefault();
    const now = pct(e);
    Object.assign(draft.style, {
      left: Math.min(start.x, now.x) + "%", top: Math.min(start.y, now.y) + "%",
      width: Math.abs(now.x - start.x) + "%", height: Math.abs(now.y - start.y) + "%",
    });
  };
  const up = async e => {
    if (!start || !draft) return;
    const now = pct(e.changedTouches ? { clientX: e.changedTouches[0].clientX, clientY: e.changedTouches[0].clientY } : e);
    const box = {
      x: +Math.min(start.x, now.x).toFixed(2), y: +Math.min(start.y, now.y).toFixed(2),
      w: +Math.abs(now.x - start.x).toFixed(2), h: +Math.abs(now.y - start.y).toFixed(2),
    };
    draft.remove(); draft = null; start = null;
    if (box.w < 4 || box.h < 3) { toast("Too small to print on. Drag out a bigger area."); return; }

    /* The label inside a spot is sized in container units off the spot's own
       WIDTH (22cqw for the number, 13cqw for the price), so a very wide, very
       short box cannot fit its own text - at 200% browser text it clips. CSS
       can only set one global floor, so the proportion is enforced here where
       the shape is actually decided. The garment box is 3:4, which is where
       the 0.28 comes from: 0.37 of the width in rendered pixels. */
    const minH = +(box.w * 0.28).toFixed(2);
    if (box.h < minH) {
      box.h = Math.min(minH, 100 - box.y);
      toast("Made that spot a little taller so its price still fits inside it.");
    }
    newSpot(box);
  };

  pane.addEventListener("pointerdown", down);
  pane.addEventListener("pointermove", move);
  pane.addEventListener("pointerup", up);
  pane.addEventListener("pointercancel", () => { if (draft) draft.remove(); draft = null; start = null; });
}

function newSpot(box) {
  const side = state.studioSide;
  const n = state.spots.filter(s => s.side === side).length + 1;
  spotSheet({ ...box, side, n, name: "New spot", floor: 350, blurb: "", badge: null }, async patch => {
    const created = await Store.spots.create(state.listing.id, patch);
    state.spots.push(created);
    toast("Spot added.", "ok");
    await refresh();
  });
}

function editSpot(id) {
  const spot = state.spots.find(s => s.id === id);
  if (!spot) return;
  spotSheet(spot, async patch => {
    await Store.spots.update(id, patch);
    toast("Spot updated.", "ok");
    await refresh();
  }, async () => {
    await Store.spots.remove(id);
    toast("Spot removed.");
    await refresh();
  });
}

function spotSheet(spot, onSave, onDelete) {
  openSheet({
    kicker: `${spot.side} · position ${String(+spot.n).padStart(2, "0")}`,
    title: spot.id ? "Edit this spot" : "Mark out a spot",
    body: `
      <form id="spot-form" novalidate>
        <div class="row2">
          <div class="fld"><label for="sp-name">Name it</label>
            <input class="inp" id="sp-name" type="text" maxlength="40" value="${esc(spot.name)}" required></div>
          <div class="fld"><label for="sp-floor">Floor price</label>
            <input class="inp num" id="sp-floor" type="number" min="1" step="1" value="${+spot.floor}" required></div>
        </div>
        <div class="row2">
          <div class="fld"><label for="sp-n">Position number</label>
            <input class="inp num" id="sp-n" type="number" min="1" step="1" value="${+spot.n}"></div>
          <div class="fld"><label for="sp-badge">Badge (optional)</label>
            <input class="inp" id="sp-badge" type="text" maxlength="10" value="${esc(spot.badge || "")}" placeholder="MEGA"></div>
        </div>
        <div class="fld"><label for="sp-blurb">Why a brand wants it</label>
          <textarea class="inp" id="sp-blurb" maxlength="240">${esc(spot.blurb || "")}</textarea></div>
        <div class="quote">
          <div class="ln"><span class="k">Placement</span>
            <span class="v">${(+spot.x).toFixed(1)}%, ${(+spot.y).toFixed(1)}% · ${(+spot.w).toFixed(1)} × ${(+spot.h).toFixed(1)}</span></div>
        </div>
        <p class="err" id="sp-err" hidden></p>
        <button class="btn wide" type="submit" style="margin-top:16px">Save the spot</button>
        ${onDelete ? `<button class="btn quiet wide sm" type="button" id="sp-del" style="margin-top:10px">Remove it</button>` : ""}
      </form>`,
    onOpen(root) {
      $("#spot-form", root).addEventListener("submit", async e => {
        e.preventDefault();
        const err = $("#sp-err", root);
        const patch = {
          side: spot.side, x: +spot.x, y: +spot.y, w: +spot.w, h: +spot.h,
          name: $("#sp-name", root).value.trim(),
          floor: Number($("#sp-floor", root).value),
          n: Number($("#sp-n", root).value) || 1,
          badge: $("#sp-badge", root).value.trim().toUpperCase() || null,
          blurb: $("#sp-blurb", root).value.trim(),
        };
        if (!patch.name) { err.textContent = "Give it a name."; err.hidden = false; return; }
        if (!(patch.floor >= 1)) { err.textContent = "The floor must be at least 1."; err.hidden = false; return; }
        try { await onSave(patch); closeSheet(); }
        catch (e2) { err.textContent = e2.message; err.hidden = false; }
      });
      const del = $("#sp-del", root);
      if (del) del.addEventListener("click", async () => {
        if (!confirm("Remove this spot? Any bids on it are void.")) return;
        try { await onDelete(); closeSheet(); }
        catch (e2) { toast(e2.message, "bad"); }
      });
    },
  });
}

/* --------------------------------------------------------------- uploads */
$$(".drop[data-side]").forEach(drop => {
  const side = drop.dataset.side;
  const input = $("input[type=file]", drop);

  ["dragenter", "dragover"].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev =>
    drop.addEventListener(ev, () => drop.classList.remove("over")));
  drop.addEventListener("drop", e => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) upload(side, e.dataTransfer.files[0], drop);
  });
  input.addEventListener("change", e => {
    if (e.target.files[0]) upload(side, e.target.files[0], drop);
  });
});

async function upload(side, file, drop) {
  if (!state.listing) return;
  const big = $(".big", drop);
  const was = big.textContent;
  big.textContent = "Uploading…";
  try {
    await Store.photos.upload(state.listing.id, side, file);
    big.textContent = "Uploaded ✓";
    toast(`${side[0].toUpperCase() + side.slice(1)} photograph saved.`, "ok");
    await refresh();
  } catch (e) {
    big.textContent = was;
    toast(e.message, "bad");
  }
}

/* ------------------------------------------------------------ studio bits */
$("#studio-front").addEventListener("click", () => { state.studioSide = "front"; syncStudioSide(); });
$("#studio-back-tab").addEventListener("click", () => { state.studioSide = "back"; syncStudioSide(); });
function syncStudioSide() {
  $("#studio-front").setAttribute("aria-pressed", String(state.studioSide === "front"));
  $("#studio-back-tab").setAttribute("aria-pressed", String(state.studioSide === "back"));
  renderStudio();
}

$("#studio-draw").addEventListener("click", () => {
  state.drawing = !state.drawing;
  $("#studio-draw").setAttribute("aria-pressed", String(state.drawing));
  $("#studio-draw").textContent = state.drawing ? "Done drawing" : "Draw a spot";
  if (state.drawing) toast("Drag a rectangle on the photograph.");
  renderStudio();
});

$("#studio-clear").addEventListener("click", async () => {
  const doomed = state.spots.filter(s => s.side === state.studioSide);
  if (!doomed.length) return;
  if (!confirm(`Remove all ${doomed.length} spots on the ${state.studioSide}?`)) return;
  for (const s of doomed) await Store.spots.remove(s.id);
  toast("Cleared.");
  await refresh();
});

$("#terms-form").addEventListener("submit", async e => {
  e.preventDefault();
  const err = $("#terms-err"); err.hidden = true;
  try {
    await Store.listings.update(state.listing.id, {
      garment: $("#t-garment").value,
      names: $("#t-names").value.trim(),
      city: $("#t-city").value.trim(),
      goal: Number($("#t-goal").value) || 0,
      closes_at: $("#t-closes").value ? new Date($("#t-closes").value).toISOString() : null,
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
  if (!L.is_open && !state.spots.length) { toast("Mark out at least one spot first.", "bad"); return; }
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
      venue_type: $("#e-venuetype").value.trim(),
      shooters: $("#e-shooters").value.trim(),
      reach: Number($("#e-reach").value) || 0,
      hashtag: $("#e-hashtag").value.trim(),
      press: $("#e-press").value.trim(),
      livestream: $("#e-live").checked,
    });
    toast("Saved.", "ok");
    await refresh();
  } catch (e2) { toast(e2.message, "bad"); }
});

$("#studio-view").addEventListener("click", () => go("campaign"));
$("#studio-share").addEventListener("click", () => openShare(null));
$("#studio-back").addEventListener("click", () => go("campaign"));
$("#book-back").addEventListener("click", () => go("campaign"));
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
$("#home-link").addEventListener("click", () => go("campaign"));
$$("#nav-book, #mob-book").forEach(b => b.addEventListener("click", () => go("book")));

$("#side-front").addEventListener("click", () => { state.side = "front"; syncSide(); });
$("#side-back").addEventListener("click", () => { state.side = "back"; syncSide(); });
function syncSide() {
  $("#side-front").setAttribute("aria-pressed", String(state.side === "front"));
  $("#side-back").setAttribute("aria-pressed", String(state.side === "back"));
  renderGarment();
}

$$("[data-legal]").forEach(a => a.addEventListener("click", e => {
  e.preventDefault();
  const which = a.dataset.legal;
  const copy = {
    terms: "Square Inch is a marketplace. The publisher owns the garment and decides what goes on it; the brand owns its mark and warrants it has the right to place it. Placement is a licence for the day of the event, not an assignment. We take a platform fee on each settled spot, shown before you bid.",
    privacy: "We store your email, your display name, your brand name, your logo and your bidding history. Session cookies are httpOnly and same-site. We do not sell anything to anyone and we do not run third-party analytics. Card details never reach our servers — Stripe holds them.",
    refunds: "Being outbid releases your authorisation in full, automatically, within minutes. If the campaign goal is not reached by the close, every authorisation is released and nobody is charged. Once a spot has settled and been captured, it is refundable only if the event does not take place.",
    content: "No marks you do not own. Nothing unlawful, hateful, or sexual. No political campaigning. The publisher has the final say on what goes on their own garment and may decline any brand without giving a reason; a declined bid is released in full.",
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
  renderAccount();
}

/* the countdown runs on its own clock so the whole page is not re-rendered */
function tickClock() {
  const L = state.listing;
  if (!L) return;
  $("#goal-clock").textContent = Market.countdown(L.closes_at);
}
setInterval(() => {
  tickClock();
  if (state.listing) {
    const c = Store.campaign(state.spots, Store.bids.bySpot(state.bids), state.listing.goal);
    renderTicker(c);
  }
}, 1000);

/* reveal on scroll */
const io = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add("shown"); io.unobserve(e.target); } });
}, { rootMargin: "0px 0px -8% 0px" });
setTimeout(() => $$(".rv").forEach(el => io.observe(el)), 60);

/* redraw the garment when the layout crosses the one-panel / two-panel line */
window.addEventListener("resize", debounce(() => {
  if (state.screen === "campaign") renderGarment();
}, 200));

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* =========================================================================
   boot
   ========================================================================= */
(async function boot() {
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

  let id = params.get("l");
  if (!id) {
    const open = await Store.listings.list({ openOnly: false });
    id = open.length ? open[0].id : null;
  }
  if (!id) { toast("No listings yet. Create an account as a publisher to make one.", ""); return; }

  await load(id);

  const spotParam = params.get("spot");
  if (spotParam && state.spots.some(s => s.id === spotParam)) {
    selectSpot(spotParam, false);
    document.getElementById("spots").scrollIntoView({ behavior: "smooth" });
  }
})();
