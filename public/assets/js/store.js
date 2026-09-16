/* =========================================================================
   Square Inch - the data layer.

   Two adapters behind one interface:

     supabase  real accounts, Postgres, Storage for the photographs, and
               Realtime so bids and chat arrive without polling.
     demo      everything in localStorage, seeded so the site is alive the
               first time you open it with no keys configured at all.

   Whichever is running, the rest of the app only ever talks to `Store`.

   Money and bids never go straight to the database. They go to the server,
   which revalidates with market.js and holds the Stripe secret. The browser
   is not trusted with a price.
   ========================================================================= */
window.Store = (function () {
  "use strict";

  const LS = "squareinch.v2";
  let mode = "demo";
  let sb = null;                 // the supabase client, when there is one
  let config = { publishableKey: null, currency: "usd", feePercent: 8, supabaseUrl: null, supabaseAnonKey: null };
  let session = null;
  const listeners = new Set();

  /* ------------------------------------------------------------------ init */
  async function init() {
    try {
      const r = await fetch("/api/config", { credentials: "same-origin" });
      if (r.ok) config = Object.assign(config, await r.json());
    } catch { /* served as a bare static file - that is a supported way to run */ }

    // A static host with no server of its own can set this instead.
    if (window.SQUAREINCH_CONFIG) config = Object.assign(config, window.SQUAREINCH_CONFIG);

    if (config.supabaseUrl && config.supabaseAnonKey) {
      /* Vendored, not fetched from a CDN. A floating `@2` tag would let any
         compromised 2.x publish run with our origin's full script-src and
         read every user's session token out of localStorage. It is pulled in
         only when a project is actually configured, so demo mode pays nothing
         for it. */
      const { createClient } = await loadSupabase();
      sb = createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
      mode = "supabase";
      sb.auth.onAuthStateChange(async () => { await refreshSession(); emit(); });
      await refreshSession();
      /* Deliberately not wrapped in a try/catch. A configured deployment that
         silently drops to the demo store would show a live listing backed by
         localStorage, with a sign-in that accepts any password. Failing loudly
         is the only safe behaviour once real keys are present. */
    }

    if (mode === "demo") seed();
    return { mode, config };
  }

  /* The UMD build, served from our own origin. It is a classic script rather
     than a module because the `+esm` bundle re-exports from nine further CDN
     paths, which would put the supply chain straight back where it was. */
  function loadSupabase() {
    if (window.supabase) return Promise.resolve(window.supabase);
    return new Promise((res, rej) => {
      const el = document.createElement("script");
      el.src = "assets/js/vendor/supabase.js";
      el.onload = () => window.supabase
        ? res(window.supabase)
        : rej(new Error("The Supabase client loaded but exposed nothing."));
      el.onerror = () => rej(new Error("Could not load assets/js/vendor/supabase.js"));
      document.head.append(el);
    });
  }

  const emit = () => listeners.forEach(fn => { try { fn(session); } catch (e) { console.error(e); } });
  const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };

  /* ------------------------------------------------------------- local disk */
  function db() {
    try { return JSON.parse(localStorage.getItem(LS)) || {}; }
    catch { return {}; }
  }
  function save(next) {
    try { localStorage.setItem(LS, JSON.stringify(next)); }
    catch (e) { console.warn("Could not write local storage:", e.message); }
  }
  const uid = () => Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

  /* ------------------------------------------------------------------ seed
     A demo listing so the page has something to show before anyone signs up.
     Coordinates are percentages of the photograph, so they survive any
     screen size - that is the same scheme the real editor writes. */
  function seed() {
    const d = db();
    if (d.seeded) return;

    const listingId = "demo-mt";
    const spots = [
      /* front */
      ["front", 1, "Mega Spot",     "MEGA",    1200, 23,   23,   27,   10,   "Top-front placement. In nearly every photograph, every video, every recap montage. This is the one people screenshot."],
      ["front", 2, "Semi-Mega",     null,       900, 24,   34,   31,    7.5, "Smaller than the Mega, but it sits on the front and comes out in almost every frame."],
      ["front", 3, "Low Key",       null,       700, 20,   42.5, 20,   10.5, "Below the waist and it reads well in motion - walking, standing or posing."],
      ["front", 4, "Low Key",       null,       700, 43,   42.5, 19,   10.5, "The mirror of spot 3. Pairs well if you want both and a symmetrical mark."],
      ["front", 5, "Zero Chill",    null,       500, 28.5, 54,   33,    8,   "Sits under the two verticals. Bigger area, clean lines, good for a wordmark."],
      ["front", 6, "Prime",         "BIG",      900, 29.5, 64,   31.5, 24,   "Every eye travels to the hem first. The largest single area on the front."],
      /* back */
      ["back",  1, "Prime",         null,      1000, 50.3, 27,   22,   11,   "First spot on the back, and the most valuable one there - it holds its place in every photograph taken from behind."],
      ["back",  2, "Hotspot",       "BIGGEST", 1200, 36.4, 41,   42,   12,   "Needs no explanation. It also covers more fabric than anything else on the garment."],
      ["back",  3, "Mini",          null,       350, 34.8, 54.5, 16.8, 10,   "Small budget, biggest room. This is the one for you."],
      ["back",  4, "Mini",          null,       350, 53.5, 54.5, 16.8, 10,   "Small budget, biggest room. This is the one for you."],
      ["back",  5, "Slaying",       null,       700, 33,   66,   36.2, 10,   "A bottom spot, but a wide one - built to catch the room."],
      ["back",  6, "Mini",          null,       350, 29,   78.5, 20,   10.5, "Small budget, biggest room. This is the one for you."],
      ["back",  7, "Mini",          null,       350, 52,   78.5, 20,   10.5, "Small budget, biggest room. This is the one for you."],
    ].map(([side, n, name, badge, floor, x, y, w, h, blurb]) => ({
      id: `${listingId}-${side}-${n}`, listing_id: listingId, side, n, name, badge, floor, x, y, w, h, blurb,
    }));

    const closes = Date.now() + 6 * 86400000;
    save({
      seeded: true,
      users: {},
      listings: {
        [listingId]: {
          id: listingId, owner: "demo-owner",
          names: "Maya & Tal", garment: "gown",
          headline: "Walking billboard for your brand",
          tagline: "your logo on my dress, worn all day at our wedding in Tel Aviv",
          city: "Tel Aviv", venue: "Beit Hatfutsot", venue_type: "Garden, 180 covers",
          event_date: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
          invited: 220, confirmed: 180, shooters: "Noa Levi + a second shooter",
          gallery: "Public gallery, ~40k views on the last two weddings",
          reach: 48000, hashtag: "#mayaandtal", press: "Local lifestyle press confirmed",
          livestream: true,
          goal: 9200, fee_percent: 8, currency: "usd",
          closes_at: new Date(closes).toISOString(),
          is_open: true,
          photo_front: null, photo_back: null,
          about: "I costed this wedding down to the napkin. The dress is the only line on the spreadsheet that can earn, so it is going to.",
          instagram: "mayaandtal", twitter: "mayaandtal",
        },
      },
      spots: Object.fromEntries(spots.map(s => [s.id, s])),
      bids: {},
      messages: {},
    });
  }

  /* ================================================================== auth */
  async function refreshSession() {
    if (mode !== "supabase") return session;
    const { data } = await sb.auth.getUser();
    if (!data || !data.user) { session = null; return null; }
    const { data: profile } = await sb.from("profiles").select("*").eq("id", data.user.id).single();
    session = {
      id: data.user.id,
      email: data.user.email,
      name: (profile && profile.display_name) || data.user.email,
      role: (profile && profile.role) || "brand",
      brand: (profile && profile.brand) || null,
      logo: (profile && profile.logo_url) || null,
      /* False only between an OAuth arrival and the moment that person picks
         a side. The app uses it to know it still has to ask. */
      roleLocked: profile ? profile.role_locked !== false : true,
    };
    return session;
  }

  const auth = {
    current: () => session,

    async signUp({ email, password, name, role, brand }) {
      if (mode === "supabase") {
        const { data, error } = await sb.auth.signUp({
          email, password,
          /* handle_new_user() reads these and writes the profile row, so an
             account can never exist without one. Role is clamped there. */
          options: { data: { role, display_name: name, brand: brand || null } },
        });
        if (error) throw new Error(error.message);
        await refreshSession(); emit();
        return session || { pendingConfirmation: true };
      }
      const d = db();
      const id = "u-" + uid();
      d.users = d.users || {};
      if (Object.values(d.users).some(u => u.email === email)) throw new Error("That email already has an account.");
      d.users[id] = { id, email, name, role, brand: brand || null, logo: null };
      d.session = id; save(d);
      session = d.users[id]; emit();
      return session;
    },

    async signIn({ email, password }) {
      if (mode === "supabase") {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw new Error(error.message);
        await refreshSession(); emit();
        return session;
      }
      const d = db();
      const user = Object.values(d.users || {}).find(u => u.email === email);
      if (!user) throw new Error("No account with that email. Create one first.");
      d.session = user.id; save(d);
      session = user; emit();
      return session;
    },

    /* Google (and any other provider enabled in the dashboard). The browser
       leaves the page entirely and comes back with a session in the URL,
       which is why `detectSessionInUrl` is on in createClient. */
    async signInWithOAuth(provider = "google") {
      if (mode !== "supabase") throw new Error("Social sign-in needs a configured project.");
      const { error } = await sb.auth.signInWithOAuth({
        provider,
        options: {
          /* Wherever this copy of the page is actually running, so the same
             build works on localhost and on the live domain. Both have to be
             in the project's Redirect URLs allow-list. */
          redirectTo: window.location.origin + window.location.pathname,
        },
      });
      if (error) throw new Error(error.message);
      /* No return value worth having - the browser is navigating away. */
    },

    /* A provider cannot tell us which side of the table someone is on, so
       they arrive unlocked and are asked once. The database allows exactly
       one such change and then freezes it. */
    async chooseRole(role, brand) {
      if (!session) throw new Error("Not signed in.");
      if (!["client", "brand"].includes(role)) throw new Error("Pick a side.");
      if (session.roleLocked) throw new Error("Your account type is already set.");

      if (mode === "supabase") {
        const patch = { role, role_locked: true };
        if (role === "brand" && brand) patch.brand = brand;
        const { error } = await sb.from("profiles").update(patch).eq("id", session.id);
        if (error) throw new Error(error.message);
        await refreshSession();
      } else {
        const d = db();
        Object.assign(d.users[session.id], { role, brand: brand || null, roleLocked: true });
        save(d); session = d.users[session.id];
      }
      emit();
      return session;
    },

    async signOut() {
      if (mode === "supabase") await sb.auth.signOut();
      else { const d = db(); delete d.session; save(d); }
      session = null; emit();
    },

    async updateProfile(patch) {
      if (!session) throw new Error("Not signed in.");
      if (mode === "supabase") {
        const fields = {};
        if (patch.name  !== undefined) fields.display_name = patch.name;
        if (patch.brand !== undefined) fields.brand = patch.brand;
        if (patch.logo  !== undefined) fields.logo_url = patch.logo;
        const { error } = await sb.from("profiles").update(fields).eq("id", session.id);
        if (error) throw new Error(error.message);
        await refreshSession();
      } else {
        const d = db();
        Object.assign(d.users[session.id], patch);
        save(d); session = d.users[session.id];
      }
      emit();
      return session;
    },

    onChange,
  };

  /* ============================================================== listings */
  const listings = {
    async list({ openOnly = true } = {}) {
      if (mode === "supabase") {
        let q = sb.from("listings").select("*").order("closes_at", { ascending: true });
        if (openOnly) q = q.eq("is_open", true);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        return data || [];
      }
      const all = Object.values(db().listings || {});
      return openOnly ? all.filter(l => l.is_open) : all;
    },

    async get(id) {
      if (mode === "supabase") {
        const { data, error } = await sb.from("listings").select("*").eq("id", id).single();
        if (error) throw new Error(error.message);
        return data;
      }
      return (db().listings || {})[id] || null;
    },

    async mine() {
      if (!session) return [];
      if (mode === "supabase") {
        const { data, error } = await sb.from("listings").select("*").eq("owner", session.id);
        if (error) throw new Error(error.message);
        return data || [];
      }
      return Object.values(db().listings || {}).filter(l => l.owner === session.id);
    },

    async create(patch) {
      if (!session) throw new Error("Sign in first.");
      const row = Object.assign({
        owner: session.id, garment: "gown", is_open: false,
        goal: 5000, fee_percent: config.feePercent || 8, currency: config.currency || "usd",
      }, patch);
      if (mode === "supabase") {
        const { data, error } = await sb.from("listings").insert(row).select().single();
        if (error) throw new Error(error.message);
        return data;
      }
      const d = db(); row.id = "l-" + uid();
      d.listings = d.listings || {}; d.listings[row.id] = row; save(d);
      return row;
    },

    async update(id, patch) {
      if (mode === "supabase") {
        const { data, error } = await sb.from("listings").update(patch).eq("id", id).select().single();
        if (error) throw new Error(error.message);
        return data;
      }
      const d = db();
      if (!d.listings[id]) throw new Error("No such listing.");
      Object.assign(d.listings[id], patch); save(d);
      return d.listings[id];
    },
  };

  /* ================================================================= spots */
  const spots = {
    async list(listingId) {
      if (mode === "supabase") {
        const { data, error } = await sb.from("spots").select("*")
          .eq("listing_id", listingId).order("side").order("n");
        if (error) throw new Error(error.message);
        return data || [];
      }
      return Object.values(db().spots || {})
        .filter(s => s.listing_id === listingId)
        .sort((a, b) => a.side.localeCompare(b.side) || a.n - b.n);
    },

    async create(listingId, spot) {
      const row = Object.assign({ listing_id: listingId }, spot);
      if (mode === "supabase") {
        const { data, error } = await sb.from("spots").insert(row).select().single();
        if (error) throw new Error(error.message);
        return data;
      }
      const d = db(); row.id = "s-" + uid();
      d.spots = d.spots || {}; d.spots[row.id] = row; save(d);
      return row;
    },

    async update(id, patch) {
      if (mode === "supabase") {
        const { data, error } = await sb.from("spots").update(patch).eq("id", id).select().single();
        if (error) throw new Error(error.message);
        return data;
      }
      const d = db(); Object.assign(d.spots[id], patch); save(d);
      return d.spots[id];
    },

    async remove(id) {
      if (mode === "supabase") {
        const { error } = await sb.from("spots").delete().eq("id", id);
        if (error) throw new Error(error.message);
        return;
      }
      const d = db(); delete d.spots[id]; save(d);
    },
  };

  /* ================================================================ photos
     Front and back are two named objects under the listing's own folder, so
     re-uploading a side replaces it rather than accumulating orphans. */
  const photos = {
    async upload(listingId, side, file) {
      if (!["front", "back"].includes(side)) throw new Error("Side must be front or back.");
      if (!file || !file.type.startsWith("image/")) throw new Error("That is not an image.");
      if (file.size > 8 * 1024 * 1024) throw new Error("Keep photographs under 8MB.");

      if (mode === "supabase") {
        const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
        const key = `${listingId}/${side}.${ext}`;
        const { error } = await sb.storage.from("garments")
          .upload(key, file, { upsert: true, cacheControl: "3600", contentType: file.type });
        if (error) throw new Error(error.message);
        const { data } = sb.storage.from("garments").getPublicUrl(key);
        const url = `${data.publicUrl}?v=${Date.now()}`;
        await listings.update(listingId, { [`photo_${side}`]: url });
        return url;
      }

      const url = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = () => rej(new Error("Could not read that file."));
        fr.readAsDataURL(file);
      });
      await listings.update(listingId, { [`photo_${side}`]: url });
      return url;
    },

    async remove(listingId, side) {
      if (mode === "supabase") {
        const { data } = await sb.storage.from("garments").list(listingId);
        const hit = (data || []).find(f => f.name.startsWith(side + "."));
        if (hit) await sb.storage.from("garments").remove([`${listingId}/${hit.name}`]);
      }
      await listings.update(listingId, { [`photo_${side}`]: null });
    },

    /* A brand's mark. Kept small - it is printed, not displayed at size. */
    async uploadLogo(file) {
      if (!session) throw new Error("Sign in first.");
      if (!file || !/^image\/(png|jpeg|svg\+xml|webp)$/.test(file.type))
        throw new Error("Use a PNG, JPEG, WEBP or SVG.");
      if (file.size > 2 * 1024 * 1024) throw new Error("Keep the logo under 2MB.");

      if (mode === "supabase") {
        const ext = ({ "image/png": "png", "image/jpeg": "jpg", "image/svg+xml": "svg", "image/webp": "webp" })[file.type];
        const key = `${session.id}/logo.${ext}`;
        const { error } = await sb.storage.from("logos")
          .upload(key, file, { upsert: true, cacheControl: "3600", contentType: file.type });
        if (error) throw new Error(error.message);
        const { data } = sb.storage.from("logos").getPublicUrl(key);
        const url = `${data.publicUrl}?v=${Date.now()}`;
        await auth.updateProfile({ name: session.name, brand: session.brand, logo: url });
        return url;
      }

      const url = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = () => rej(new Error("Could not read that file."));
        fr.readAsDataURL(file);
      });
      const d = db();
      if (d.users && d.users[session.id]) { d.users[session.id].logo = url; save(d); session = d.users[session.id]; }
      return url;
    },
  };

  /* ================================================================== bids
     Reads are direct; writes go through the server, which is the only thing
     allowed to decide a price or take money. */
  const bids = {
    async list(listingId) {
      if (mode === "supabase") {
        const { data, error } = await sb.from("bids").select("*")
          .eq("listing_id", listingId).order("created_at", { ascending: true });
        if (error) throw new Error(error.message);
        return (data || []).map(b => ({
          id: b.id, spotId: b.spot_id, bidder: b.bidder, brand: b.brand,
          logo: b.logo_url, max: Number(b.max_amount), at: Date.parse(b.created_at),
          withdrawn: b.withdrawn, status: b.status,
        }));
      }
      return Object.values(db().bids || {}).filter(b => b.listing_id === listingId);
    },

    /* Group by spot for the engine. */
    bySpot(all) {
      const out = {};
      for (const b of all || []) (out[b.spotId] = out[b.spotId] || []).push(b);
      return out;
    },

    /* The server validates, holds the money, and writes the row. */
    async place({ listingId, spotId, max, brand, logo }) {
      const res = await api("/api/bid", { listingId, spotId, max, brand, logo });

      /* The demo fallback is ONLY for a demo. When a real database is behind
         this, a 503 or a dropped connection means the bid did not happen, and
         saying "placed in demo mode" would be telling a bidder their money is
         committed on a live listing where nothing was recorded. */
      if (res.demo) {
        if (mode === "supabase") {
          throw new Error(res.reason || "The server could not take that bid. Nothing was charged — try again.");
        }
        const d = db();
        const bid = { id: "b-" + uid(), listing_id: listingId, spotId, bidder: session.id, brand, logo: logo || null, max: Number(max), at: Date.now() };
        d.bids = d.bids || {}; d.bids[bid.id] = bid; save(d);
        return { ...res, bid };
      }
      return res;
    },
  };

  /* ================================================================ market
     What the page is allowed to know about a spot.

     In demo mode every bid is local, so the engine computes the settlement
     directly. Against a real database a browser may NOT read anyone's
     maximum - that is the whole point of a sealed-bid ceiling - so the
     settled figures are read from columns the server wrote after each bid.

     Both adapters return the same shape, so nothing above this line has to
     care which one is running. */
  function market(spot, bidsForSpot) {
    if (mode === "supabase") {
      const price = Number(spot.price);
      return {
        holder: spot.holder || null,
        holderName: spot.holder_brand || null,
        holderLogo: spot.holder_logo || null,
        price: Number.isFinite(price) ? price : Number(spot.floor),
        depth: Number(spot.bid_count) || 0,
        blind: true,
      };
    }
    return Object.assign({ blind: false }, Market.settle(spot, bidsForSpot || []));
  }

  function minimum(spot, bidsForSpot) {
    const m = market(spot, bidsForSpot);
    return m.holder ? Market.raiseOver(m.price) : m.price;
  }

  function campaign(spots, bidsBySpot, goal) {
    let raised = 0, held = 0, open = 0, floorTotal = 0;
    for (const spot of spots || []) {
      const m = market(spot, (bidsBySpot || {})[spot.id]);
      floorTotal += Number(spot.floor) || 0;
      if (m.holder) { raised += m.price; held++; } else { open++; }
    }
    const target = Number(goal) > 0 ? Number(goal) : floorTotal;
    const r = Market.money(raised), g = Market.money(target);
    return { raised: r, goal: g, pct: g > 0 ? Math.min(Math.max(r / g, 0), 1) : 0,
             met: r >= g, held, open, total: (spots || []).length };
  }

  /* Quote a bid before it is placed. Demo mode can answer exactly. Against a
     real database the leader's ceiling is hidden, so the honest answer is a
     range: you pay at least the minimum and never more than your own maximum,
     and only the server can say where in between it lands. */
  function quote(spot, bidsForSpot, offer) {
    if (mode !== "supabase") return Market.evaluate(spot, bidsForSpot || [], offer);

    const m = market(spot);
    const min = minimum(spot);
    const max = Number(offer && offer.max);
    const reject = reason => ({ ok: false, reason, minimum: min, price: m.price, holder: m.holder });

    if (!Number.isFinite(max)) return reject("Enter an amount.");
    if (max > Market.RULES.MAX_BID) return reject("That is over the maximum bid.");
    if (max < min) {
      return reject(m.holder
        ? `You need at least ${min} to take this spot.`
        : `The floor on this spot is ${min}.`);
    }
    return {
      ok: true, blind: true,
      won: null,                 // unknowable here; the server decides
      price: min,                // the least it can settle at
      settlesBetween: [min, Market.money(max)],
      minimum: min,
      max: Market.money(max),
      outbid: null, pushedTo: null, holder: m.holder,
    };
  }

  /* ================================================================== chat */
  const chat = {
    async list(listingId) {
      if (mode === "supabase") {
        const { data, error } = await sb.from("messages").select("*")
          .eq("listing_id", listingId).order("created_at", { ascending: true }).limit(200);
        if (error) throw new Error(error.message);
        return data || [];
      }
      return (db().messages || {})[listingId] || [];
    },

    async send(listingId, body) {
      if (!session) throw new Error("Sign in to send a message.");
      const text = String(body).slice(0, 400).trim();
      if (!text) throw new Error("Nothing to send.");
      const row = {
        listing_id: listingId, author: session.id,
        display_name: session.brand || session.name, role: session.role, body: text,
      };
      if (mode === "supabase") {
        const { data, error } = await sb.from("messages").insert(row).select().single();
        if (error) throw new Error(error.message);
        return data;
      }
      const d = db();
      d.messages = d.messages || {};
      row.id = "m-" + uid(); row.created_at = new Date().toISOString();
      (d.messages[listingId] = d.messages[listingId] || []).push(row);
      save(d);
      return row;
    },
  };

  /* ================================================================== live
     Realtime where there is a database, a cheap poll where there is not. */
  function subscribe(listingId, onChangeFn) {
    if (mode === "supabase") {
      const ch = sb.channel("listing:" + listingId)
        .on("postgres_changes", { event: "*", schema: "public", table: "bids", filter: `listing_id=eq.${listingId}` }, onChangeFn)
        .on("postgres_changes", { event: "*", schema: "public", table: "spots", filter: `listing_id=eq.${listingId}` }, onChangeFn)
        .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `listing_id=eq.${listingId}` }, onChangeFn)
        .on("postgres_changes", { event: "*", schema: "public", table: "listings", filter: `id=eq.${listingId}` }, onChangeFn)
        .subscribe();
      return () => sb.removeChannel(ch);
    }
    const t = setInterval(onChangeFn, 4000);
    return () => clearInterval(t);
  }

  /* ================================================================== http
     Every state-changing call carries the CSRF token the server set as a
     readable cookie next to the httpOnly session cookie. */
  function cookie(name) {
    return document.cookie.split("; ").reduce((acc, part) => {
      const [k, ...v] = part.split("=");
      return k === name ? decodeURIComponent(v.join("=")) : acc;
    }, null);
  }

  async function api(path, body) {
    const headers = { "content-type": "application/json" };
    const csrf = cookie("si_csrf");
    if (csrf) headers["x-csrf-token"] = csrf;
    if (mode === "supabase" && sb) {
      const { data } = await sb.auth.getSession();
      if (data && data.session) headers.authorization = "Bearer " + data.session.access_token;
    }
    let res;
    try {
      res = await fetch(path, {
        method: "POST", headers, credentials: "same-origin",
        body: JSON.stringify(body || {}),
      });
    } catch {
      return { demo: true, reason: "No server reachable - staying in demo mode." };
    }
    if (res.status === 503) return { demo: true, reason: (await res.json().catch(() => ({}))).error || "Payments are not configured." };
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Request failed (${res.status}).`);
    return json;
  }

  return {
    init, get mode() { return mode; }, get config() { return config; },
    auth, listings, spots, photos, bids, chat, subscribe, api,
    market, minimum, campaign, quote,
    /* exposed so the studio can wipe a demo and start again */
    resetDemo() { localStorage.removeItem(LS); seed(); },
  };
})();
