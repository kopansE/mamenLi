/**
 * Square Inch - the server.
 *
 * It exists for three things the browser must never be trusted with:
 *
 *   1. the Stripe secret key,
 *   2. deciding what a bid costs,
 *   3. writing to the bids table.
 *
 * Everything else - listings, spots, photographs, chat - the browser does
 * directly against Postgres under Row Level Security, which is why this file
 * is short.
 *
 * With a blank .env it still runs and still serves the site; /api/config just
 * reports that nothing is configured and the front end stays in demo mode.
 */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");

/* The same engine the page quoted with. Sharing it is the point: a bid the
   browser drew cannot be priced differently here, because it is one file. */
const Market = require("../public/assets/js/market.js");

const {
  STRIPE_SECRET_KEY = "",
  STRIPE_PUBLISHABLE_KEY = "",
  STRIPE_WEBHOOK_SECRET = "",
  SUPABASE_URL = "",
  SUPABASE_ANON_KEY = "",
  SUPABASE_SERVICE_ROLE_KEY = "",
  PLATFORM_FEE_PERCENT = "8",
  CURRENCY = "usd",
  PORT = "8787",
  PUBLIC_BASE_URL = "",
  NODE_ENV = "development",
  TRUST_PROXY = "",
  CANONICAL_HOST = "",
} = process.env;

const FEE_PERCENT = Number(PLATFORM_FEE_PERCENT) || 0;

/* ------------------------------------------------------------------ money
   `listings` is owner-writable, so neither the fee nor the currency on the
   row may be trusted: a publisher could PATCH fee_percent to 0 through
   PostgREST and zero our commission, or set a zero-decimal currency and turn
   a 1,000 bid into a 100,000 charge. Both are decided here instead. */
const feeFor = () => FEE_PERCENT;

/* Stripe takes amounts in the currency's smallest unit, and how small that is
   varies: JPY has no minor unit at all, so ¥1000 is `1000`, not `100000`. */
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw",
  "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);
const SUPPORTED = new Set(["usd", "eur", "gbp", "ils", "cad", "aud", "chf",
  "sek", "nok", "dkk", "nzd", "sgd", "jpy"]);

const currencyFor = listing => {
  const want = String((listing && listing.currency) || CURRENCY).toLowerCase();
  return SUPPORTED.has(want) ? want : String(CURRENCY).toLowerCase();
};

/* A mark is only displayable if it came out of our own logos bucket. Anything
   else - another origin, a data: URI - is dropped rather than rendered. */
function ownLogo(url) {
  const s = String(url || "");
  if (!SUPABASE_URL) return "";
  const prefix = `${SUPABASE_URL}/storage/v1/object/public/logos/`;
  return s.startsWith(prefix) && s.length <= 500 ? s : "";
}

function minorUnits(amount, currency) {
  const c = String(currency).toLowerCase();
  if (ZERO_DECIMAL.has(c)) return Math.round(Number(amount));
  /* Stripe wants three-decimal currencies rounded to the nearest 10. */
  if (THREE_DECIMAL.has(c)) return Math.round(Number(amount) * 100) * 10;
  return Math.round(Number(amount) * 100);
}
const ROOT = path.join(__dirname, "..");
/* Only this directory is ever served. Pointing express.static at the repo root
   handed out .git - and therefore every key ever committed - along with
   server/, supabase/ and node_modules/. serve-static only hides dotfiles in
   the LAST path segment, so /.env correctly 404s while /.git/config returned
   200. An allowlisted directory is the fix; a denylist is not. */
const PUBLIC = path.join(ROOT, "public");
const PROD = NODE_ENV === "production";
const stripe = STRIPE_SECRET_KEY ? require("stripe")(STRIPE_SECRET_KEY) : null;

/* The service-role client bypasses RLS, so it never leaves this process. */
let db = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  const { createClient } = require("@supabase/supabase-js");
  db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const app = express();
/* How many proxies sit in front of us, as a number, or `false` when none do.
   This must match the real topology. Hardcoding `1` with nothing in front
   means express believes an attacker-supplied X-Forwarded-For, which hands
   every rate limiter a key the attacker chooses - measured: 12/min on
   /api/bid became unlimited by rotating the header. Behind Vercel/Fly/Render
   set TRUST_PROXY=1; behind a CDN *and* a load balancer, 2. */
app.set("trust proxy", /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : false);
app.disable("x-powered-by");

/* ========================================================== security headers
   No 'unsafe-inline' on script-src: every line of JavaScript on this site is
   in a file, so the one real XSS mitigation is available to us. */
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      /* No CDN: supabase-js is vendored under public/assets/js/vendor. */
      "script-src": ["'self'", "https://js.stripe.com"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com"],
      "img-src": ["'self'", "data:", "blob:", "https:"],
      /* Only the configured project, never `*.supabase.co` - a wildcard there
         is an exfiltration endpoint that happens to be on an allowed host. */
      "connect-src": ["'self'", "https://api.stripe.com",
                      ...(SUPABASE_URL ? [SUPABASE_URL, SUPABASE_URL.replace(/^https/, "wss")] : [])],
      "frame-src": ["https://js.stripe.com", "https://hooks.stripe.com"],
      "frame-ancestors": ["'none'"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'", "https://checkout.stripe.com"],
      "upgrade-insecure-requests": PROD ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: PROD ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
}));

/* ------------------------------------------------------- one canonical host
   mimonim.com and www.mimonim.com must not both serve the site: two origins
   means two cookie jars, two Supabase sessions, and a Google redirect that
   works on one and not the other. Everything is funnelled to CANONICAL_HOST.
   Skipped for the Stripe webhook, which must never be redirected. */
if (CANONICAL_HOST) {
  app.use((req, res, next) => {
    const host = req.get("host");
    if (!host || host === CANONICAL_HOST || req.path === "/api/webhook") return next();
    if (/^localhost(:\d+)?$|^127\.0\.0\.1(:\d+)?$/.test(host)) return next();
    return res.redirect(308, `https://${CANONICAL_HOST}${req.originalUrl}`);
  });
}

/* A liveness probe the host can poll without tripping rate limits or setting
   a CSRF cookie on every check. It also reports which commit is actually
   running, which is the only reliable way to tell whether a push deployed -
   a docs-only change looks identical in a browser otherwise. Render sets
   RENDER_GIT_COMMIT itself; locally it is simply absent. */
const STARTED_AT = new Date().toISOString();
app.get("/healthz", (_req, res) => {
  res.type("application/json").json({
    ok: true,
    commit: (process.env.RENDER_GIT_COMMIT || "local").slice(0, 7),
    branch: process.env.RENDER_GIT_BRANCH || null,
    startedAt: STARTED_AT,
  });
});

/* ============================================================ the webhook
   Mounted before the JSON parser because the signature is over the raw body,
   and exempt from CSRF because Stripe's signature is the stronger check. */
app.post("/api/webhook", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("webhook signature rejected:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") await onAuthorised(event.data.object);
    if (event.type === "checkout.session.expired") await onAbandoned(event.data.object);
  } catch (err) {
    /* Answer 500 so Stripe retries rather than dropping a paid bid. */
    console.error("webhook handling failed:", err);
    return res.status(500).json({ error: "handler failed" });
  }
  res.json({ received: true });
});

app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());

/* ================================================================ rate limits
   A ladder rather than one number: reading is cheap, bidding is not. */
const limiter = (max, windowMs = 60_000, message = "Too many requests. Slow down.", keyGenerator, skip) =>
  rateLimit({
    windowMs, max, standardHeaders: true, legacyHeaders: false,
    message: { error: message },
    ...(keyGenerator ? { keyGenerator } : {}),
    ...(skip ? { skip } : {}),
  });

/* Bidding is keyed on the account, not the address: one person behind one IP
   should not be able to spend another's quota, and one person on many
   addresses should not get many quotas. The token is only hashed for a key
   here - it is verified properly in requireUser. */
const byAccount = req => {
  const auth = req.get("authorization") || "";
  if (auth.startsWith("Bearer ")) {
    return "u:" + crypto.createHash("sha256").update(auth.slice(7)).digest("hex").slice(0, 32);
  }
  return "ip:" + (req.ip || "unknown");
};

/* A drawn box is not a bid, it is a WRITE. Every one of them that gets past
   validation is a permanent rectangle on a stranger's wedding clothes, so it
   is rationed harder than an ordinary bid: 12 a minute would be 12 rectangles
   a minute, and a publisher waking up to a garment tiled edge to edge with
   pending requests has been vandalised whether or not any of them is approved.

   Four a minute, keyed on the account like the bid limiter above. A brand
   drawing in good faith draws once, and redraws once or twice if the box came
   back too small or landed on somebody else - the page runs the same
   validateBox before it ever posts, so a refusal here means either a race
   with another brand or a client that has been tampered with. Neither needs a
   fifth attempt inside the same minute. The 12/min bid ceiling still applies
   on top, so this only ever tightens. */
const isDrawnBox = req => !!(req.body && req.body.draw && typeof req.body.draw === "object"
  && !Array.isArray(req.body.draw));

app.use("/api", limiter(240));
app.use("/api/bid", limiter(12, 60_000, "Too many bids in a minute. Wait a moment.", byAccount));
app.use("/api/bid", limiter(4, 60_000, "Too many spots drawn in a minute. Wait a moment.",
  byAccount, req => !isDrawnBox(req)));
app.use("/api/chat", limiter(40));
app.use("/api/settle", limiter(6, 60_000, "Too many settlement attempts."));

/* ======================================================================= CSRF
   Double-submit: a readable cookie the page echoes back in a header. An
   attacker's page can make the browser send the cookie, but same-origin
   policy stops it reading the value to set the header. */
const CSRF_COOKIE = "si_csrf";

function issueCsrf(req, res) {
  let token = req.cookies[CSRF_COOKIE];
  if (!token || !/^[a-f0-9]{32}$/.test(token)) {
    token = crypto.randomBytes(16).toString("hex");
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: false,                 // the page has to read it - that is the design
      sameSite: "lax",
      secure: PROD,
      maxAge: 12 * 3600 * 1000,
      path: "/",
    });
  }
  return token;
}

const CSRF_SHAPE = /^[a-f0-9]{32}$/;

function requireCsrf(req, res, next) {
  const cookie = req.cookies[CSRF_COOKIE];
  const header = req.get("x-csrf-token");
  if (!cookie || !header) return res.status(403).json({ error: "Missing CSRF token. Reload the page." });
  /* Re-check the shape here, not only when issuing. Comparing two
     attacker-chosen strings to each other proves nothing; requiring a token
     we could actually have minted means a forger has to have read one. */
  if (!CSRF_SHAPE.test(cookie) || !CSRF_SHAPE.test(header))
    return res.status(403).json({ error: "Malformed CSRF token. Reload the page." });
  const a = Buffer.from(String(cookie)), b = Buffer.from(String(header));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: "Bad CSRF token. Reload the page." });
  }
  next();
}

/* ======================================================================= auth
   The browser holds a Supabase access token; we verify it here rather than
   believing any user id the request claims. */
async function requireUser(req, res, next) {
  if (!db) return res.status(503).json({ error: "No database configured.", demo: true });
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Sign in first." });

  const { data, error } = await db.auth.getUser(token);
  if (error || !data || !data.user) return res.status(401).json({ error: "Your session has expired. Sign in again." });

  const { data: profile } = await db.from("profiles").select("*").eq("id", data.user.id).single();
  /* No profile, no session. Defaulting the role to "brand" here meant an
     account whose trigger had not run could bid, which is the one thing the
     role is load-bearing for. */
  if (!profile) return res.status(403).json({ error: "Your account is not set up yet. Sign out and back in." });

  req.user = {
    id: data.user.id,
    email: data.user.email,
    role: profile.role,
    brand: profile.brand || null,
    logo: profile.logo_url || null,
  };
  next();
}

/* ===================================================================== config
   Only things that are safe in a browser. The service role key and the
   Stripe secret are not among them. */
app.get("/api/config", (req, res) => {
  issueCsrf(req, res);
  res.json({
    publishableKey: STRIPE_PUBLISHABLE_KEY || null,
    currency: CURRENCY,
    feePercent: FEE_PERCENT,
    mode: STRIPE_SECRET_KEY.startsWith("sk_live") ? "live" : "test",
    supabaseUrl: SUPABASE_URL || null,
    supabaseAnonKey: SUPABASE_ANON_KEY || null,
    minRaise: Market.RULES.MIN_RAISE,
    antiSnipeMinutes: Market.RULES.ANTI_SNIPE_MIN,
  });
});

/* ======================================================================= bid
   The one endpoint that matters. It reads the listing, the spot and every
   live bid from its own database, revalidates with the shared engine, and
   only then asks Stripe for money. Nothing the client sent is used as a
   price - only as an intent.

   It now takes two shapes of request, and they are told apart by ONE thing:
   whether the body carries a `draw` object.

     { listingId, spotId, max, brand }                    bid on a spot that
                                                          already exists
     { listingId, draw:{side,x,y,w,h}, max, brand }        draw the rectangle
                                                          you want, then bid
                                                          on it

   A body carrying both takes the drawn path - `draw` is the more specific
   intent, and a stray spotId beside it is never read. The second shape is
   the product now; the first is kept because a spot a brand drew last week is
   an ordinary spot that anybody may bid on. */
app.post("/api/bid", requireCsrf, requireUser, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Payments are not configured.", demo: true });

  const { listingId, spotId, draw, max, brand, logo } = req.body || {};
  const drawn = isDrawnBox(req);
  if (typeof listingId !== "string" || (!drawn && typeof spotId !== "string"))
    return res.status(400).json({ error: "Which spot?" });
  if (typeof brand !== "string" || !brand.trim() || brand.length > 60)
    return res.status(400).json({ error: "A brand name is required." });
  if (!Number.isFinite(Number(max)))
    return res.status(400).json({ error: "Enter an amount." });
  if (req.user.role !== "brand")
    return res.status(403).json({ error: "Only a brand account can bid." });

  /* --- authoritative state ------------------------------------------- */
  const { data: listing, error: lErr } = await db.from("listings").select("*").eq("id", listingId).single();
  if (lErr || !listing) return res.status(404).json({ error: "No such listing." });
  if (!listing.is_open) return res.status(409).json({ error: "Bidding on this listing is closed." });
  /* You cannot bid your own garment up. Roles are frozen at sign-up, but an
     owner could still hold a second account, so this checks ownership rather
     than trusting the role alone. This guard is why the drawn path reuses
     this route rather than getting one of its own: an owner drawing a spot on
     their own dress and bidding it up is the same shill it always was. */
  if (listing.owner === req.user.id)
    return res.status(403).json({ error: "You cannot bid on your own listing." });

  let spot = null;
  /* Set only on the drawn path, and only once the row really exists. It is
     what the cleanup at the bottom deletes if anything after this fails. */
  let created = null;

  if (drawn) {
    /* A brand draws on a photograph. Half a garment photographed is half a
       garment that cannot be drawn on at all, and a listing that opened with
       one side missing would sell the front twice. */
    if (!listing.photo_front || !listing.photo_back)
      return res.status(409).json({ error: "This garment is not photographed yet." });

    /* One read for both jobs: the neighbours the box must not overlap, and
       the highest number already used on that side. Filtering the side here
       rather than in the query means a `side` the client invented comes back
       as an empty neighbour list and is then refused by validateBox on the
       side rule itself, instead of being quietly priced as a back. */
    const { data: allSpots, error: spErr } = await db.from("spots").select("*").eq("listing_id", listingId);
    if (spErr) return res.status(500).json({ error: "Could not read the garment." });

    const box = {
      side: draw.side,
      x: Number(draw.x), y: Number(draw.y), w: Number(draw.w), h: Number(draw.h),
    };
    const onThisSide = (allSpots || []).filter(s => s.side === box.side);

    /* The page ran this exact function before it posted. Running it again
       here is the whole point of sharing market.js: the browser says WHERE,
       never what that costs or whether it is allowed. */
    const check = Market.validateBox(box, listing, onThisSide);
    if (!check.ok) return res.status(400).json({ error: check.reason });

    /* `spots.floor` is `>= 1` in the schema and settle() lifts anything below
       MIN_BID to MIN_BID anyway, so a publisher who has set their rate to
       zero gets a one-unit floor rather than a constraint violation and a
       500 the brand cannot act on. */
    const floor = Math.max(Market.priceForBox(box, listing), Market.RULES.MIN_BID);
    const n = (onThisSide.reduce((m, s) => Math.max(m, Number(s.n) || 0), 0)) + 1;

    const { data: row, error: cErr } = await db.from("spots").insert({
      listing_id: listingId,
      side: box.side,
      n,
      name: "Brand spot",
      x: box.x, y: box.y, w: box.w, h: box.h,
      floor,
      /* Who asked, and the fact that nobody has said yes yet. The publisher
         approves or declines through their own RLS update policy; until then
         the rectangle is claimed but not agreed to. */
      proposed_by: req.user.id,
      approved: false,
    }).select().single();

    if (cErr || !row) {
      console.error("could not create a drawn spot:", cErr && cErr.message);
      return res.status(500).json({ error: "Could not reserve that space." });
    }
    spot = row;
    created = row.id;
  } else {
    const { data: row, error: sErr } = await db.from("spots").select("*").eq("id", spotId).single();
    if (sErr || !row || row.listing_id !== listingId)
      return res.status(404).json({ error: "No such spot on that listing." });
    spot = row;
  }

  const out = await placeBid({ req, listing, spot, brand: brand.trim(), max });

  /* Nothing is left behind on somebody's dress. The rectangle only exists
     because this bid was about to be made; if the bid did not happen - too
     low, Stripe refused, anything - the rectangle has no reason to be there,
     and a publisher should not have to decline a spot nobody ever bid on. */
  if (created && out.status >= 400) {
    /* Loud on failure, and checked BOTH ways: supabase-js reports a refused
       delete in `error` rather than by throwing, so a try/catch on its own
       would have reported every orphan as a clean sweep. */
    try {
      const { error: dErr } = await db.from("spots").delete().eq("id", created);
      if (dErr) throw new Error(dErr.message);
    } catch (err) {
      console.error("ORPHANED SPOT", created, "on listing", listingId, "-", err.message);
    }
  }

  return res.status(out.status).json(out.body);
});

/* The bid itself, unchanged by where the spot came from. Answers
   { status, body } rather than writing the response, so the caller can undo a
   spot it had to create first. */
async function placeBid({ req, listing, spot, brand, max }) {
  const listingId = listing.id;
  const spotId = spot.id;

  const { data: rows, error: bErr } = await db.from("bids").select("*")
    .eq("spot_id", spotId).eq("withdrawn", false).in("status", ["held", "captured"]);
  if (bErr) return { status: 500, body: { error: "Could not read the market." } };

  const bids = (rows || []).map(b => ({
    id: b.id, bidder: b.bidder, brand: b.brand, logo: b.logo_url,
    max: Number(b.max_amount), at: Date.parse(b.created_at),
  }));

  /* --- the rules, applied here and not in the browser ----------------- */
  const spotForEngine = {
    id: spot.id, floor: Number(spot.floor),
    closesAt: spot.closes_at || listing.closes_at,
    listingClosed: !listing.is_open,
  };
  const verdict = Market.evaluate(spotForEngine, bids, {
    bidder: req.user.id, brand, max: Number(max),
  });
  if (!verdict.ok) return { status: 400, body: { error: verdict.reason, minimum: verdict.minimum } };

  /* --- money ----------------------------------------------------------
     We authorise the bidder's MAXIMUM, then capture only the price that
     actually settles at close. Stripe allows capturing less than was
     authorised, which is exactly the shape proxy bidding needs: the hold
     covers the ceiling, the charge is what they really owed. */
  const feePct = feeFor();
  const hold = Market.quote(verdict.max, feePct);
  const currency = currencyFor(listing);
  const amount = minorUnits(hold.total, currency);
  if (amount < minorUnits(1, currency)) return { status: 400, body: { error: "Below the minimum charge." } };

  const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  /* The price is in the key: a retry after the market has moved must open a
     new session rather than silently hand back the old, cheaper one. */
  const idem = crypto.createHash("sha256")
    .update([req.user.id, spotId, verdict.max, verdict.price, Date.now() / 60000 | 0].join(":")).digest("hex");

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: req.user.id,
      customer_email: req.user.email,
      payment_intent_data: {
        /* an authorisation, not a charge - released the moment they are outbid */
        capture_method: "manual",
        description: `Spot ${spot.n} (${spot.side}) on ${listing.names}'s ${listing.garment}`,
        metadata: { listingId, spotId, bidder: req.user.id },
      },
      line_items: [{
        quantity: 1,
        price_data: {
          currency,
          unit_amount: amount,
          product_data: {
            name: `${spot.name} — ${spot.side} position ${spot.n}`,
            description: `On ${listing.names}'s ${listing.garment}. Maximum bid, incl. ${feePct}% platform fee. You are charged the settled price, which may be lower.`,
          },
        },
      }],
      metadata: {
        listingId, spotId, bidder: req.user.id,
        brand, max: String(verdict.max),
        /* The bidder's OWN stored mark, read from the profile we verified -
           never req.body.logo. A client-supplied URL ends up as an <img src>
           on every visitor's page, which is a free tracking beacon (and,
           with a data: URI, arbitrary attacker-authored artwork). */
        logo: ownLogo(req.user.logo),
      },
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      success_url: `${base}/?l=${encodeURIComponent(listingId)}&spot=${encodeURIComponent(spotId)}&paid=1`,
      cancel_url: `${base}/?l=${encodeURIComponent(listingId)}&paid=0`,
    }, { idempotencyKey: idem });

    return {
      status: 200,
      body: { url: session.url, id: session.id, price: verdict.price, max: verdict.max, spotId },
    };
  } catch (err) {
    console.error("checkout failed:", err.message);
    return { status: 502, body: { error: "Could not start checkout." } };
  }
}

/* ============================================================ webhook bodies */

/* The card was authorised. Record the bid, then release whoever it displaced. */
async function onAuthorised(session) {
  if (!db) return;
  const m = session.metadata || {};
  if (!m.spotId || !m.bidder) return;

  const { data: existing } = await db.from("bids").select("id").eq("stripe_session", session.id).maybeSingle();
  if (existing) return;                                  // Stripe retries; we do not double-insert

  /* Checkout was validated up to 30 minutes ago and the market has moved
     since. Revalidate against current state before writing anything: without
     this, a session opened just before the close can be completed afterwards,
     and extendForSnipe would then push a finished auction back open. */
  const fresh = await marketState(m.spotId);
  if (!fresh) return void console.warn("authorised bid for a spot that no longer exists:", m.spotId);

  const verdict = Market.evaluate(fresh.spotForEngine, fresh.bids, {
    bidder: m.bidder, brand: m.brand, max: Number(m.max),
  });
  if (!verdict.ok) {
    console.warn("authorised bid no longer valid (", verdict.reason, ") - cancelling", session.payment_intent);
    try { if (stripe && session.payment_intent) await stripe.paymentIntents.cancel(session.payment_intent); }
    catch (err) { console.error("could not cancel a stale authorisation:", err.message); }
    return;
  }

  await db.from("bids").insert({
    listing_id: m.listingId,
    spot_id: m.spotId,
    bidder: m.bidder,
    brand: m.brand,
    /* never the client's value - the bidder's own stored mark, or nothing */
    logo_url: m.logo || null,
    max_amount: Number(m.max),
    status: "held",
    stripe_session: session.id,
    stripe_payment_intent: session.payment_intent,
  });

  await resettle(m.spotId);
  await extendForSnipe(m.spotId);
}

/* Everything the rules need about one spot, read from our own database. */
async function marketState(spotId) {
  const { data: spot } = await db.from("spots").select("*, listings(*)").eq("id", spotId).single();
  if (!spot) return null;
  const listing = spot.listings || {};

  /* Every bid that was ever authorised and not withdrawn, whatever its
     payment status. A released bid still sets the price - that is the whole
     point of a second-price auction - even though its money went back. */
  const { data: rows } = await db.from("bids").select("*")
    .eq("spot_id", spotId).eq("withdrawn", false).in("status", ["held", "captured", "released"]);

  return {
    spot, listing,
    rows: rows || [],
    bids: (rows || []).map(b => ({
      id: b.id, bidder: b.bidder, brand: b.brand, logo: b.logo_url,
      max: Number(b.max_amount), at: Date.parse(b.created_at),
    })),
    spotForEngine: {
      id: spot.id, floor: Number(spot.floor),
      closesAt: spot.closes_at || listing.closes_at,
      listingClosed: listing.is_open === false,
    },
  };
}

/* They never finished checkout. Nothing to undo - no bid was ever written. */
async function onAbandoned(session) {
  console.log("checkout expired:", session.id);
}

/* Re-price a spot and cancel every authorisation that is no longer the leader.
   Their money was never taken, so this is a release rather than a refund.
   The settled price is written onto the spot: it is what the page shows, what
   settlement captures, and the only figure a browser is allowed to see. */
async function resettle(spotId) {
  const st = await marketState(spotId);
  if (!st) return null;

  const settled = Market.settle(st.spotForEngine, st.bids);

  /* Compare by ROW, not by bidder. `evaluate` lets a holder raise their own
     maximum, which leaves two live rows for one bidder; matching on bidder
     would keep both authorised and then capture both at settlement - the same
     brand charged twice for one spot. */
  const leaderRowId = settled.leader ? settled.leader.id : null;

  for (const row of st.rows) {
    if (row.id === leaderRowId || row.status !== "held") continue;
    try {
      if (stripe && row.stripe_payment_intent) await stripe.paymentIntents.cancel(row.stripe_payment_intent);
      await db.from("bids").update({ status: "released", released_at: new Date().toISOString() }).eq("id", row.id);
      console.log("released", row.brand, "on spot", spotId);
    } catch (err) {
      console.error("could not release", row.id, err.message);
    }
  }

  /* Denormalised onto the spot so the browser never needs to read anyone's
     maximum to draw the page. See the bids RLS policy. */
  await db.from("spots").update({
    price: settled.price,
    holder: settled.holder || null,
    holder_brand: settled.holderName || null,
    holder_logo: settled.holderLogo || null,
    bid_count: settled.depth,
  }).eq("id", spotId);

  return settled;
}

/* A bid inside the anti-snipe window pushes that spot's close out. */
async function extendForSnipe(spotId) {
  const { data: spot } = await db.from("spots").select("*, listings(closes_at)").eq("id", spotId).single();
  if (!spot) return;
  const current = spot.closes_at || (spot.listings && spot.listings.closes_at);
  if (!current) return;
  const extended = Market.extendIfLate({ closesAt: current }, Date.now());
  if (extended && extended > Date.parse(current)) {
    await db.from("spots").update({ closes_at: new Date(extended).toISOString() }).eq("id", spotId);
    console.log("anti-snipe: spot", spotId, "extended to", new Date(extended).toISOString());
  }
}

/* =================================================================== decline
   The wearer says no to a rectangle somebody drew on them.

   This has to be a server route rather than a PostgREST write, for one
   reason: the authorisation on the sponsor's card can only be cancelled with
   the Stripe secret key, and that key never leaves this process. The studio
   used to DELETE the spot instead, which cascaded to the bids and took
   `stripe_payment_intent` with it - after which nothing on earth could
   release the hold, while the page cheerfully said it had.

   The row is kept and marked. Both sides keep the record of what was asked
   and what was answered, and a declined rectangle stops blocking the fabric
   so somebody else can draw there.
   ========================================================================= */
app.post("/api/decline/:spotId", requireCsrf, requireUser, async (req, res) => {
  const { spotId } = req.params;

  const { data: spot } = await db.from("spots").select("*").eq("id", spotId).single();
  if (!spot) return res.status(404).json({ error: "No such spot." });

  /* Only the person wearing the garment may refuse what goes on it. */
  const { data: listing } = await db.from("listings").select("id, owner").eq("id", spot.listing_id).single();
  if (!listing || listing.owner !== req.user.id) {
    return res.status(403).json({ error: "That is not your garment." });
  }
  if (spot.approved === true) {
    return res.status(409).json({ error: "That one is already accepted. It settles with the rest." });
  }
  if (spot.declined) return res.json({ ok: true, released: 0, alreadyDeclined: true });

  const { data: rows } = await db.from("bids").select("*").eq("spot_id", spotId);

  /* Release the money BEFORE marking the row. If the cancel fails we want the
     spot still visibly pending, so the next attempt tries again - marking it
     first would leave a released-looking rectangle with a live hold behind it,
     which is the exact failure this route exists to end. */
  const released = [], failed = [];
  for (const row of rows || []) {
    if (row.status !== "held") continue;
    try {
      if (stripe && row.stripe_payment_intent) {
        await stripe.paymentIntents.cancel(row.stripe_payment_intent);
      }
      await db.from("bids").update({
        status: "released", released_at: new Date().toISOString(),
      }).eq("id", row.id);
      released.push({ brand: row.brand, amount: Number(row.max_amount) });
    } catch (err) {
      console.error("DECLINE: could not release", row.id, row.brand, "-", err.message);
      failed.push(row.brand);
    }
  }

  if (failed.length) {
    return res.status(502).json({
      error: "We could not release " + failed.join(", ") + " just yet. Nothing was declined - try again in a moment.",
    });
  }

  const { error } = await db.from("spots")
    .update({ declined: true, declined_at: new Date().toISOString() }).eq("id", spotId);
  if (error) return res.status(500).json({ error: "Released their card, but could not mark it declined." });

  res.json({ ok: true, released: released.length, brands: released.map(r => r.brand) });
});

/* ==================================================================== settle
   Run at (or after) close: capture the holder at the price that settled,
   which is normally less than the maximum they authorised. Protected by a
   shared secret so it can be driven from cron, a Supabase scheduled function
   or by hand. */
app.post("/api/settle/:listingId", async (req, res) => {
  const secret = process.env.SETTLE_SECRET || "";
  const given = req.get("x-settle-secret") || "";
  if (!secret || !sameSecret(secret, given)) return res.status(403).json({ error: "Forbidden." });
  if (!db || !stripe) return res.status(503).json({ error: "Not configured." });

  const { listingId } = req.params;
  const force = req.query.force === "1";
  const { data: listing } = await db.from("listings").select("*").eq("id", listingId).single();
  if (!listing) return res.status(404).json({ error: "No such listing." });

  const { data: spots } = await db.from("spots").select("*").eq("listing_id", listingId);
  const now = Date.now();

  /* Price every spot from ALL its bids, not just the ones still holding money.
     Releasing a loser must never change the price - the runner-up's maximum is
     precisely what the leader pays just above. Reading only status='held' made
     the leader the sole bid, so settle() fell through to the floor and the
     publisher lost every penny of competitive uplift. */
  const states = {};
  for (const spot of spots || []) states[spot.id] = await marketState(spot.id);

  const bidsBySpot = {};
  for (const [id, st] of Object.entries(states)) if (st) bidsBySpot[id] = st.bids;

  /* A spot the wearer never accepted is not part of this campaign: it is not
     on the page, it is not in the goal the page shows, and its money must not
     be counted towards whether the goal was met. Counting it here would let a
     pile of unapproved requests drag a campaign over the line and capture the
     cards of everyone who WAS accepted. */
  const approved = (spots || []).filter(s => s.approved !== false);

  /* Goal not met means nobody is charged. That is the promise on the page. */
  const totals = Market.campaign(
    approved.map(s => ({ id: s.id, floor: Number(s.floor) })), bidsBySpot, listing.goal);

  const out = { captured: [], released: [], skipped: [], goalMet: totals.met, raised: totals.raised };

  for (const spot of spots || []) {
    const st = states[spot.id];
    if (!st || !st.rows.length) continue;

    /* Never charge for a patch of somebody's clothing they did not agree to.
       A drawn spot arrives approved=false and stays that way until the wearer
       says yes; if the campaign closes while it is still waiting, the answer
       is no, and every authorisation behind it is released. Without this the
       settlement job captured cards for placements that were never accepted
       and could never be printed. */
    if (spot.approved === false) {
      for (const row of st.rows) {
        if (row.status !== "held") continue;
        try {
          await stripe.paymentIntents.cancel(row.stripe_payment_intent);
          await db.from("bids").update({ status: "released", released_at: new Date().toISOString() }).eq("id", row.id);
          out.released.push({ brand: row.brand, spot: spot.n, reason: "never accepted" });
        } catch (err) {
          console.error("RELEASE FAILED for unaccepted bid", row.id, row.brand, "-", err.message);
          out.skipped.push({ spot: spot.n, brand: row.brand, error: err.message });
        }
      }
      continue;
    }

    /* Respect a per-spot anti-snipe extension: a spot whose clock is still
       running has not finished, and capturing it early would cut off a bid
       somebody is entitled to answer. */
    const closes = st.spotForEngine.closesAt ? Date.parse(st.spotForEngine.closesAt) : null;
    if (!force && closes && now < closes) {
      out.skipped.push({ spot: spot.n, side: spot.side, closesAt: new Date(closes).toISOString() });
      continue;
    }

    const settled = Market.settle(st.spotForEngine, st.bids);
    const leaderRowId = settled.leader ? settled.leader.id : null;
    const feePct = feeFor(listing);
    const due = Market.quote(settled.price, feePct);

    for (const row of st.rows) {
      if (row.status !== "held") continue;
      const wins = totals.met && row.id === leaderRowId;   // by row, never by bidder
      try {
        if (wins) {
          await stripe.paymentIntents.capture(row.stripe_payment_intent, {
            amount_to_capture: minorUnits(due.total, listing.currency || CURRENCY),
          });
          await db.from("bids").update({
            status: "captured", settled_amount: settled.price, settled_at: new Date().toISOString(),
          }).eq("id", row.id);
          out.captured.push({ brand: row.brand, spot: spot.n, amount: due.total });
        } else {
          await stripe.paymentIntents.cancel(row.stripe_payment_intent);
          await db.from("bids").update({ status: "released", released_at: new Date().toISOString() }).eq("id", row.id);
          out.released.push({ brand: row.brand, spot: spot.n });
        }
      } catch (err) {
        /* An authorisation that lapsed (Stripe expires them after ~7 days)
           lands here. It must be loud: silently swallowing it gives the spot
           away for nothing. */
        console.error("SETTLEMENT FAILED for bid", row.id, row.brand, "on spot", spot.n, "-", err.message);
        out.skipped.push({ spot: spot.n, brand: row.brand, error: err.message });
      }
    }
  }

  if (!out.skipped.length) await db.from("listings").update({ is_open: false }).eq("id", listingId);
  res.json(out);
});

function sameSecret(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ====================================================================== chat
   Kept in memory when there is no database, which is fine for a demo and for
   one process. With Supabase the browser talks to the messages table directly and
   this is never called. */
const CHATS = new Map();
const CHAT_CAP = 200;      // messages kept per room
const ROOM_CAP = 500;      // rooms kept at all, oldest evicted first
const clean = t => String(t).replace(/[<>]/g, "").trim().slice(0, 400);

app.get("/api/chat/:id", (req, res) => {
  const room = CHATS.get(req.params.id) || [];
  const since = Number(req.query.since) || 0;
  res.json({ messages: room.filter(m => m.at > since), now: Date.now() });
});

app.post("/api/chat/:id", requireCsrf, requireUser, (req, res) => {
  const { text } = req.body || {};
  const body = clean(text || "");
  if (!body) return res.status(400).json({ error: "Empty message." });

  /* `who` and `role` come from the verified session, never from the body.
     Taking them from the request let an unauthenticated caller post as
     `{who:"Maya (the publisher)", role:"client"}`, which the UI renders with
     a "· publisher" badge - a ready-made payment-redirect scam. */
  const room = CHATS.get(req.params.id) || [];
  const msg = {
    id: crypto.randomUUID(),
    who: clean(req.user.brand || req.user.email).slice(0, 60),
    role: req.user.role === "client" ? "client" : "brand",
    text: body,
    at: Date.now(),
  };
  room.push(msg);

  /* CHAT_CAP bounds messages per room, not the number of rooms, and the room
     id is any path segment a caller invents - so evict the oldest rooms. */
  CHATS.set(req.params.id, room.slice(-CHAT_CAP));
  while (CHATS.size > ROOM_CAP) CHATS.delete(CHATS.keys().next().value);

  res.json({ message: msg });
});

/* =================================================================== the site

   Cache busting, and why it is not optional here.

   index.html is revalidated on every load, but the CSS and JS it points at
   used to be cached for five minutes under their own unchanging URLs. That
   gap is not theoretical: a deploy put new markup in front of the previous
   build's app.js, which threw on the first element that no longer existed,
   and every screen stayed hidden. The visitor got a header, a footer and
   nothing in between - and no error they could see.

   So the page names its assets with the build that produced them. Those URLs
   are immutable and cached for a year; the next build asks for different
   ones. An unversioned request still works, but must revalidate, so no stale
   copy can outlive a deploy. */
const BUILD_AT_BOOT = (process.env.RENDER_GIT_COMMIT || "").slice(0, 7) || buildIdFromDisk();
/* Fixed in production, where the files cannot change under us. Recomputed per
   request in development, so saving a stylesheet changes the stamp the page
   asks for instead of leaving a year-long immutable copy of the old one in
   the browser. */
const buildId = () => PROD ? BUILD_AT_BOOT : buildIdFromDisk();

/* Render hands us the commit. Locally there is none, so the assets hash
   themselves - which is better anyway during development, because it changes
   the moment a file does rather than at the next commit. */
function buildIdFromDisk() {
  const h = crypto.createHash("sha1");
  for (const f of ["assets/css/app.css", "assets/js/app.js",
                   "assets/js/store.js", "assets/js/market.js"]) {
    try { h.update(fs.readFileSync(path.join(PUBLIC, f))); }
    catch { /* a checkout without one of them still has to boot */ }
  }
  return h.digest("hex").slice(0, 8);
}

/* The one page, with its asset URLs stamped. Built once in production, where
   it cannot change under a running process and a deploy is a new process.

   In development it is rebuilt every request, because the cached version is
   the same trap this whole section exists to close, just moved: edit
   index.html, and the server keeps serving the copy it read at boot while
   express.static happily hands out the app.js you just saved. New markup,
   old page, and a null element takes the script out on load. */
let INDEX_HTML = null;
function indexHtml() {
  if (INDEX_HTML && PROD) return INDEX_HTML;
  const raw = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  INDEX_HTML = raw.replace(
    /\b(href|src)="(assets\/(?:css|js)\/[^"?]+\.(?:css|js))"/g,
    (_m, attr, url) => `${attr}="${url}?v=${buildId()}"`);
  return INDEX_HTML;
}

/* Ahead of express.static, so /index.html gets the stamped copy too rather
   than the raw file off disk. */
const sendIndex = (_req, res) => {
  res.set("Cache-Control", "no-cache").type("html").send(indexHtml());
};
app.get("/", sendIndex);
app.get("/index.html", sendIndex);

app.use((req, res, next) => {
  /* Only production ever hands out an immutable year-long cache. In
     development a correct stamp still has to revalidate, or an edit made
     after the page was loaded is invisible until the cache is cleared. */
  res.locals.versioned = PROD && req.query && req.query.v === BUILD_AT_BOOT;
  next();
});

app.use(express.static(PUBLIC, {
  extensions: ["html"],
  dotfiles: "deny",
  index: false,
  setHeaders(res, filePath) {
    if (/\.(css|js)$/.test(filePath)) {
      res.setHeader("Cache-Control", res.locals.versioned
        ? "public, max-age=31536000, immutable"
        : "no-cache");
    } else if (/\.(jpe?g|png|webp|avif|gif|svg|woff2?)$/.test(filePath)) {
      /* Photographs and fonts are replaced by name, not edited in place. */
      res.setHeader("Cache-Control", "public, max-age=86400");
    }
  },
}));

app.use((err, _req, res, _next) => {
  /* body-parser already put the right status on the error: 400 for malformed
     JSON, 413 for an oversized body. Flattening those to 500 claims the fault
     was ours - it pages whoever is on call for a client's typo, and on the
     webhook path it tells Stripe to retry something that can never succeed. */
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: status >= 500 ? "Something went wrong."
         : status === 413 ? "That request was too large."
         : "That request could not be read.",
  });
});

app.listen(Number(PORT), () => {
  console.log(`Square Inch on http://localhost:${PORT}`);
  console.log(stripe
    ? `  Stripe    ${STRIPE_SECRET_KEY.startsWith("sk_live") ? "LIVE" : "test"} mode, manual capture`
    : "  Stripe    not configured - the front end stays in demo mode");
  console.log(db
    ? `  Supabase  ${SUPABASE_URL}`
    : "  Supabase  not configured - listings live in the browser only");
});
