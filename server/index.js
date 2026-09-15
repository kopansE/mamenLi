/**
 * Square Inch - payment backend.
 *
 * Card details never reach the front end: this creates a Stripe Checkout
 * Session and the browser is handed to Stripe's hosted page. The secret key
 * stays here and is never sent to the client.
 *
 * With an empty .env the server still runs and serves the site - /api/config
 * simply reports that payments are not configured, and the front end drops
 * into demo mode.
 */
const path = require("path");

/* load .env from the project root, whichever directory npm was run from */
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const {
  STRIPE_SECRET_KEY = "",
  STRIPE_PUBLISHABLE_KEY = "",
  STRIPE_WEBHOOK_SECRET = "",
  PLATFORM_FEE_PERCENT = "8",
  CURRENCY = "usd",
  PORT = "8787",
  PUBLIC_BASE_URL = "",
} = process.env;

const FEE_PERCENT = Number(PLATFORM_FEE_PERCENT) || 0;
const ROOT = path.join(__dirname, "..");
const stripe = STRIPE_SECRET_KEY ? require("stripe")(STRIPE_SECRET_KEY) : null;

const app = express();
app.set("trust proxy", 1);

/* Stripe.js and Stripe's hosted checkout need to be reachable from the page. */
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "script-src": ["'self'", "'unsafe-inline'", "https://js.stripe.com",
                     "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com"],
      "frame-src": ["https://js.stripe.com", "https://hooks.stripe.com"],
      "connect-src": ["'self'", "https://api.stripe.com"],
      "img-src": ["'self'", "data:", "blob:"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

/* The webhook needs the raw body to verify its signature, so it is mounted
   before the JSON parser. */
app.post("/api/webhook", express.raw({ type: "application/json" }), (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("webhook signature rejected:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    // TODO: mark the placement paid in your datastore, keyed on s.metadata.listingId
    console.log("paid:", s.metadata && s.metadata.listingId, s.amount_total, s.currency);
  }
  res.json({ received: true });
});

app.use(express.json({ limit: "32kb" }));
app.use("/api", rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false }));

/* ---------------------------------------------------------------- config */
app.get("/api/config", (_req, res) => {
  res.json({
    publishableKey: STRIPE_PUBLISHABLE_KEY || null,
    currency: CURRENCY,
    feePercent: FEE_PERCENT,
    mode: STRIPE_SECRET_KEY.startsWith("sk_live") ? "live" : "test",
  });
});

/* ------------------------------------------------- the listings, server-side
   Amounts are recomputed here from our own record of the listing. The client
   is never trusted for price - it only says which listing and how much area. */
const LISTINGS = {
  mt: { names: "Maya & Tal", garment: "gown", floor: 12, minArea: 20 },
  jr: { names: "June & Rosa", garment: "gown", floor: 15, minArea: 25 },
  ak: { names: "Adaeze & Kit", garment: "suit", floor: 18, minArea: 30 },
  ps: { names: "Priya & Sam", garment: "gown", floor: 20, minArea: 25 },
  ne: { names: "Noor & Eli", garment: "suit", floor: 14, minArea: 20 },
  gc: { names: "Greta & Cass", garment: "gown", floor: 11, minArea: 15 },
};
const SQIN_PER_CELL = 0.46;
const MAX_RATE = 500;

app.post("/api/checkout", async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: "Payments are not configured. Add STRIPE_SECRET_KEY to .env." });
  }
  const { listingId, brand, cells, rate } = req.body || {};
  const listing = LISTINGS[listingId];

  if (!listing) return res.status(400).json({ error: "Unknown listing." });
  if (typeof brand !== "string" || !brand.trim() || brand.length > 80)
    return res.status(400).json({ error: "Brand name is required." });
  if (!Number.isFinite(cells) || cells <= 0 || cells > 5000)
    return res.status(400).json({ error: "Invalid area." });
  if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_RATE)
    return res.status(400).json({ error: "Invalid rate." });

  const area = cells * SQIN_PER_CELL;
  if (area < listing.minArea)
    return res.status(400).json({ error: `Minimum allocation is ${listing.minArea} sq in.` });
  if (rate < listing.floor)
    return res.status(400).json({ error: `Below the floor rate of ${listing.floor}/sq in.` });

  const placement = area * rate;
  const fee = placement * (FEE_PERCENT / 100);
  const amount = Math.round((placement + fee) * 100); // minor units
  if (amount < 100) return res.status(400).json({ error: "Amount below the minimum charge." });

  const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: CURRENCY,
          unit_amount: amount,
          product_data: {
            name: `${Math.round(area)} sq in on ${listing.names}'s ${listing.garment}`,
            description: `${brand.trim()} at ${rate.toFixed(2)} per sq in, incl. ${FEE_PERCENT}% platform fee`,
          },
        },
      }],
      metadata: {
        listingId, brand: brand.trim(),
        area: String(Math.round(area)), rate: rate.toFixed(2),
      },
      success_url: `${base}/squareinch.html?paid=1&listing=${encodeURIComponent(listingId)}`,
      cancel_url: `${base}/squareinch.html?paid=0`,
    });
    res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error("checkout failed:", err.message);
    res.status(502).json({ error: "Could not start checkout." });
  }
});

/* ---------------------------------------------------------------- the site */
app.use(express.static(ROOT, { extensions: ["html"] }));
app.get("/", (_req, res) => res.sendFile(path.join(ROOT, "squareinch.html")));

app.listen(Number(PORT), () => {
  console.log(`Square Inch on http://localhost:${PORT}`);
  console.log(stripe
    ? `Stripe ready (${STRIPE_SECRET_KEY.startsWith("sk_live") ? "LIVE" : "test"} mode)`
    : "No STRIPE_SECRET_KEY in .env - running in demo mode");
});
