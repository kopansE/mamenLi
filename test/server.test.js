"use strict";

/* =========================================================================
   HTTP contract tests for server/index.js.

   Nothing external is contacted. Four real server processes are started on
   spare ports with hand-built environments:

     srv   8788  nothing configured - the shape a fresh clone runs in - plus
                 a known SETTLE_SECRET so the settlement guard can be
                 exercised without a database behind it.
     rl    8789  the same, used only for rate limiting. The limiter's state
                 is per-process and per-minute, so it gets its own server
                 rather than making every other test order-dependent.
     prod  8790  NODE_ENV=production with CANARY values in every secret. Its
                 whole job is to prove that a configured server still hands
                 the browser nothing it should not have.
     bid   8791  pointed at an in-process fake of GoTrue + PostgREST (see
                 helpers/fake-supabase.js). Every guard on /api/bid sits
                 behind requireUser, which answers 503 the moment there is no
                 database - so without a stand-in, the one endpoint that
                 decides prices and takes money cannot be tested at all.

   The prod server is deliberately never asked to do anything that would
   touch the network: its Supabase URL does not resolve, and express 4 does
   not catch a rejected promise inside an async route handler.

   The bid server never exercises the happy path either: stripe-node has no
   host override, so a successful bid would really call api.stripe.com. Every
   assertion below stops at a guard that returns before Stripe is reached -
   which is every guard that matters.

   Run from the project root:

       npm test
   ========================================================================= */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const { startServer, rawRequest, cookieValue } = require("./helpers/server.js");
const { startFakeSupabase } = require("./helpers/fake-supabase.js");
const Market = require("../public/assets/js/market.js");

const PORT_MAIN = 8788;
const PORT_RATE = 8789;
const PORT_PROD = 8790;
const PORT_BID = 8791;

const SETTLE = "s".repeat(64);                       // known, and 64 chars long

/* Values that must never come back out of /api/config. */
const CANARY = {
  stripe: "sk_live_CANARY_thisMustNeverReachTheBrowser",
  publishable: "pk_live_CANARY_thisIsSafeToExpose",
  webhook: "whsec_CANARY_signingSecret",
  serviceRole: "service_role_CANARY_thisBypassesRls",
  anon: "anon_CANARY_thisIsSafeToExpose",
};

/* ------------------------------------------------------------ the fake db */
const OWNER = "11111111-1111-1111-1111-111111111111";   // publisher
const BUYER = "22222222-2222-2222-2222-222222222222";   // brand
const PUBBER = "33333333-3333-3333-3333-333333333333";  // a second publisher
const RIVAL = "99999999-9999-9999-9999-999999999999";   // already holding S-1

const FLOOR = 1200;
const RIVAL_MAX = 2000;

/* One token per request, all resolving to the same account: /api/bid is rate
   limited by a hash of the bearer token, and these tests are about the
   route's logic rather than about its limiter. */
let tokenSeq = 0;
const tokens = {};
const tokenFor = who => {
  const t = `tok-${who}-${++tokenSeq}`;
  tokens[t] = who === "buyer" ? BUYER : who === "owner" ? OWNER : PUBBER;
  return t;
};
for (const who of ["buyer", "owner", "pubber"]) for (let i = 0; i < 40; i++) tokenFor(who);

const fixture = {
  tokens,
  users: {
    [OWNER]: { id: OWNER, email: "maya@example.test", aud: "authenticated" },
    [BUYER]: { id: BUYER, email: "buyer@acme.test", aud: "authenticated" },
    [PUBBER]: { id: PUBBER, email: "tal@example.test", aud: "authenticated" },
  },
  tables: {
    profiles: [
      { id: OWNER, role: "client", display_name: "Maya", brand: null, logo_url: null },
      { id: BUYER, role: "brand", display_name: "Buyer", brand: "Acme", logo_url: null },
      { id: PUBBER, role: "client", display_name: "Tal", brand: null, logo_url: null },
    ],
    listings: [
      {
        id: "L-OPEN", owner: PUBBER, names: "Maya & Tal", garment: "gown", is_open: true,
        goal: 9200, fee_percent: 8, currency: "usd",
        closes_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      },
      {
        id: "L-SHUT", owner: PUBBER, names: "Closed", garment: "suit", is_open: false,
        goal: 100, fee_percent: 8, currency: "usd",
        closes_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      },
      /* A brand account that also owns a garment: roles are frozen at
         sign-up, but nothing stops a publisher opening a second account. */
      {
        id: "L-MINE", owner: BUYER, names: "Self dealer", garment: "gown", is_open: true,
        goal: 100, fee_percent: 8, currency: "usd",
        closes_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      },
    ],
    spots: [
      { id: "S-1", listing_id: "L-OPEN", side: "front", n: 1, name: "Mega Spot", floor: FLOOR, closes_at: null },
      { id: "S-SHUT", listing_id: "L-SHUT", side: "front", n: 1, name: "Shut", floor: 100, closes_at: null },
      { id: "S-MINE", listing_id: "L-MINE", side: "front", n: 1, name: "Mine", floor: 100, closes_at: null },
    ],
    bids: [
      {
        id: "B-1", listing_id: "L-OPEN", spot_id: "S-1", bidder: RIVAL, brand: "Rival Co",
        logo_url: null, max_amount: RIVAL_MAX, status: "held", withdrawn: false,
        created_at: new Date(Date.now() - 3600000).toISOString(),
      },
    ],
  },
};

let srv = null, rl = null, prod = null, bidSrv = null, fakeDb = null;

before(async () => {
  fakeDb = await startFakeSupabase(fixture);
  [srv, rl, prod, bidSrv] = await Promise.all([
    startServer({ port: PORT_MAIN, env: { SETTLE_SECRET: SETTLE } }),
    startServer({ port: PORT_RATE }),
    startServer({
      port: PORT_PROD,
      env: {
        NODE_ENV: "production",
        STRIPE_SECRET_KEY: CANARY.stripe,
        STRIPE_PUBLISHABLE_KEY: CANARY.publishable,
        STRIPE_WEBHOOK_SECRET: CANARY.webhook,
        SUPABASE_URL: "https://canary.supabase.co",
        SUPABASE_ANON_KEY: CANARY.anon,
        SUPABASE_SERVICE_ROLE_KEY: CANARY.serviceRole,
        SETTLE_SECRET: "",
      },
    }),
    startServer({
      port: PORT_BID,
      env: {
        STRIPE_SECRET_KEY: "sk_test_FAKE_neverActuallyCalled",
        SUPABASE_URL: fakeDb.url,
        SUPABASE_ANON_KEY: "anon-fake",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-fake",
      },
    }),
  ]);
});

after(async () => {
  await Promise.all([srv && srv.stop(), rl && rl.stop(), prod && prod.stop(), bidSrv && bidSrv.stop()]);
  if (fakeDb) await fakeDb.stop();
});

/* ---------------------------------------------------------------- helpers */

/* A page's-eye view: read /api/config, keep the CSRF cookie it hands out. */
async function handshake(base) {
  const res = await fetch(`${base}/api/config`);
  const token = cookieValue(res, "si_csrf");
  const config = await res.json();
  return { res, token, config };
}

const postJson = (base, path, body, headers = {}) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/* Split a CSP header into { directive: [values] }. */
function csp(headerValue) {
  const out = {};
  for (const part of String(headerValue || "").split(";")) {
    const bits = part.trim().split(/\s+/).filter(Boolean);
    if (bits.length) out[bits[0].toLowerCase()] = bits.slice(1);
  }
  return out;
}

const setCookieLines = res =>
  (typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : [res.headers.get("set-cookie")]).filter(Boolean);

/* =========================================================================
   GET /api/config
   ========================================================================= */
const CONFIG_KEYS = [
  "antiSnipeMinutes", "currency", "feePercent", "minRaise",
  "mode", "publishableKey", "supabaseAnonKey", "supabaseUrl",
];

describe("GET /api/config", () => {
  it("returns exactly the documented key set and nothing else", async () => {
    const { config } = await handshake(srv.base);
    assert.deepEqual(Object.keys(config).sort(), CONFIG_KEYS);
  });

  it("reports the unconfigured shape when nothing is set", async () => {
    const { config } = await handshake(srv.base);
    assert.equal(config.publishableKey, null);
    assert.equal(config.supabaseUrl, null);
    assert.equal(config.supabaseAnonKey, null);
    assert.equal(config.mode, "test");
    assert.equal(config.currency, "usd");
    assert.equal(config.feePercent, 8);
  });

  it("publishes the market rules the page has to quote with", async () => {
    const { config } = await handshake(srv.base);
    assert.equal(config.minRaise, Market.RULES.MIN_RAISE);
    assert.equal(config.antiSnipeMinutes, Market.RULES.ANTI_SNIPE_MIN);
  });

  it("a FULLY configured server still leaks no secret", async () => {
    const res = await fetch(`${prod.base}/api/config`);
    const text = await res.text();
    const config = JSON.parse(text);

    /* the key set must not grow just because things are configured */
    assert.deepEqual(Object.keys(config).sort(), CONFIG_KEYS);

    for (const secret of [CANARY.stripe, CANARY.webhook, CANARY.serviceRole]) {
      assert.ok(!text.includes(secret), `/api/config leaked ${secret.slice(0, 20)}…`);
    }
    /* and not by any other spelling either */
    assert.ok(!/sk_(live|test)_/.test(text), "a Stripe secret key pattern appeared in /api/config");
    assert.ok(!/service_role/.test(text), "'service_role' appeared in /api/config");
    assert.ok(!/whsec_/.test(text), "a webhook signing secret appeared in /api/config");

    /* the two that ARE meant for the browser are there */
    assert.equal(config.publishableKey, CANARY.publishable);
    assert.equal(config.supabaseAnonKey, CANARY.anon);
    assert.equal(config.supabaseUrl, "https://canary.supabase.co");
    assert.equal(config.mode, "live", "sk_live_ must be reported as live mode");
  });

  it("no /api response body anywhere leaks a secret", async () => {
    for (const path of ["/api/config", "/api/chat/probe"]) {
      const text = await (await fetch(prod.base + path)).text();
      assert.ok(!/sk_live_CANARY|service_role_CANARY|whsec_CANARY/.test(text), `${path} leaked a secret`);
    }
  });

  it("no response HEADER leaks a secret either", async () => {
    const res = await fetch(`${prod.base}/api/config`);
    const dump = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
    assert.ok(!/CANARY_this(MustNever|Bypasses)|whsec_CANARY/.test(dump), `a secret appeared in a header:\n${dump}`);
  });
});

/* =========================================================================
   CSRF
   ========================================================================= */
describe("CSRF (double-submit cookie)", () => {
  it("/api/config sets si_csrf as 32 lowercase hex characters", async () => {
    const { token } = await handshake(srv.base);
    assert.ok(token, "no si_csrf cookie was set");
    assert.match(token, /^[a-f0-9]{32}$/);
  });

  it("two handshakes hand out two different tokens", async () => {
    const a = (await handshake(srv.base)).token;
    const b = (await handshake(srv.base)).token;
    assert.notEqual(a, b, "the token must be unpredictable per browser, not a constant");
  });

  it("the cookie is readable by script - that is the design", async () => {
    const line = setCookieLines(await fetch(`${srv.base}/api/config`)).find(c => c.startsWith("si_csrf="));
    assert.ok(!/httponly/i.test(line), "si_csrf must NOT be httpOnly - the page has to echo it");
    assert.match(line, /SameSite=Lax/i);
    assert.match(line, /Path=\//i);
  });

  it("in production the cookie is marked Secure", async () => {
    const line = setCookieLines(await fetch(`${prod.base}/api/config`)).find(c => c.startsWith("si_csrf="));
    assert.match(line, /;\s*Secure/i);
  });

  it("POST /api/bid with no token at all is refused", async () => {
    const res = await postJson(srv.base, "/api/bid", { listingId: "x", spotId: "y", max: 1, brand: "B" });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /CSRF/i);
  });

  it("POST /api/bid with a cookie but no header is refused", async () => {
    const { token } = await handshake(srv.base);
    const res = await postJson(srv.base, "/api/bid", {}, { cookie: `si_csrf=${token}` });
    assert.equal(res.status, 403);
  });

  it("POST /api/bid with a header but no cookie is refused", async () => {
    const { token } = await handshake(srv.base);
    const res = await postJson(srv.base, "/api/bid", {}, { "x-csrf-token": token });
    assert.equal(res.status, 403);
  });

  it("POST /api/bid with a MISMATCHED cookie and header is refused", async () => {
    const { token } = await handshake(srv.base);
    const res = await postJson(srv.base, "/api/bid", {}, {
      cookie: `si_csrf=${token}`, "x-csrf-token": "0".repeat(32),
    });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /Bad CSRF/i);
  });

  it("a mismatch of a DIFFERENT length is refused, not a timingSafeEqual crash", async () => {
    const { token } = await handshake(srv.base);
    const res = await postJson(srv.base, "/api/bid", {}, {
      cookie: `si_csrf=${token}`, "x-csrf-token": "short",
    });
    assert.equal(res.status, 403);
    assert.equal((await fetch(`${srv.base}/api/config`)).status, 200, "the process must still be alive");
  });

  it("a self-chosen pair the server could never have minted is refused", async () => {
    /* Comparing two attacker-supplied strings to each other proves nothing;
       a forger has to have READ a token we issued. */
    const forged = "not-a-32-hex-token";
    const res = await postJson(srv.base, "/api/bid", {}, {
      cookie: `si_csrf=${forged}`, "x-csrf-token": forged,
    });
    assert.equal(res.status, 403, "an equal-but-malformed pair must not pass");
  });

  it("a MATCHING pair gets past CSRF - the next refusal is auth, not 403", async () => {
    const { token } = await handshake(srv.base);
    const res = await postJson(srv.base, "/api/bid",
      { listingId: "l", spotId: "s", max: 500, brand: "Acme" },
      { cookie: `si_csrf=${token}`, "x-csrf-token": token });
    assert.notEqual(res.status, 403);
    assert.ok([401, 503].includes(res.status), `expected 401 or 503 past CSRF, got ${res.status}`);
  });

  it("chat writes are behind CSRF as well", async () => {
    const res = await postJson(srv.base, "/api/chat/room-1", { who: "Acme", text: "hello" });
    assert.equal(res.status, 403);
  });

  it("reads are NOT behind CSRF", async () => {
    assert.equal((await fetch(`${srv.base}/api/chat/room-1`)).status, 200);
  });
});

/* =========================================================================
   Static file exposure.

   A regression guard for a real bug: express.static was pointed at the repo
   root, which served .git - and therefore every key ever committed - along
   with server/, supabase/ and node_modules/. serve-static's
   `dotfiles: "deny"` only looks at the LAST path segment, so /.env correctly
   404'd while /.git/config returned 200. Allowlisting public/ is the fix.
   ========================================================================= */
describe("only public/ is ever served", () => {
  /* Read off disk rather than hardcoded, so a migration added tomorrow is
     covered the day it lands. */
  const migrations = (() => {
    try {
      return fs.readdirSync(path.join(ROOT, "supabase", "migrations"))
        .map(f => `/supabase/migrations/${f}`);
    } catch { return []; }
  })();

  const FORBIDDEN = [
    "/.git/config",
    "/.git/HEAD",
    "/.git/logs/HEAD",
    "/.env",
    "/.env.example",
    "/server/index.js",
    "/server/package.json",
    "/package.json",
    "/package-lock.json",
    "/supabase/config.toml",
    "/scripts/verify-supabase.js",
    "/test/server.test.js",
    "/test/helpers/server.js",
    "/server/node_modules/express/package.json",
    "/README.md",
    ...migrations,
  ];

  /* fetch() cannot send these: the WHATWG URL parser collapses `..` and, less
     obviously, its percent-encoded spellings `%2e%2e` and `.%2e` too. These
     go out over a raw socket, the way an attacker would send them. */
  const TRAVERSAL = [
    "/../.env",
    "/../.git/config",
    "/../../.env",
    "/..%2f.git%2fconfig",
    "/..%2F.git%2FHEAD",
    "/%2e%2e/%2e%2e/.env",
    "/%2e%2e%2f%2e%2e%2f.env",
    "/assets/../../.env",
    "/assets/..%2f..%2f.git%2fconfig",
    "/.%2e/.%2e/.env",
    "/....//.env",
    "/..;/.env",
    "/assets/css/../../../.env",
    "/%252e%252e/.env",
    "/..\\.env",
    "/..%5c.env",
  ];

  const LEAKED = /SUPABASE_SERVICE_ROLE_KEY|STRIPE_SECRET_KEY|\[core\]|ref: refs\/|"name": "square-inch"/;

  for (const p of FORBIDDEN) {
    it(`refuses ${p}`, async () => {
      const res = await rawRequest(PORT_MAIN, p);
      assert.ok([403, 404].includes(res.status), `${p} answered ${res.status} - it must not be served`);
      assert.ok(!LEAKED.test(res.body), `${p} returned repository content`);
    });
  }

  for (const p of TRAVERSAL) {
    it(`refuses the traversal ${p}`, async () => {
      const res = await rawRequest(PORT_MAIN, p);
      assert.ok([400, 403, 404].includes(res.status),
        `${p} answered ${res.status} - traversal escaped public/`);
      assert.ok(!LEAKED.test(res.body),
        `${p} returned repository content:\n${res.body.slice(0, 200)}`);
    });
  }

  it("serves the product itself", async () => {
    const res = await fetch(`${srv.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    assert.match(await res.text(), /<title>Square Inch/);
  });

  for (const [p, type] of [["/assets/css/app.css", /text\/css/], ["/assets/js/market.js", /javascript/]]) {
    it(`serves ${p}`, async () => {
      const res = await fetch(srv.base + p);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") || "", type);
      assert.match(res.headers.get("cache-control") || "", /max-age=300/);
      assert.ok((await res.text()).length > 100);
    });
  }

  it("serves every script tag the page actually asks for", async () => {
    const html = await (await fetch(`${srv.base}/`)).text();
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]);
    assert.ok(srcs.length >= 3, `expected the page to load its scripts, found ${srcs.length}`);
    for (const src of srcs) {
      if (/^https?:/.test(src)) continue;                      // a CDN is not ours to serve
      const res = await fetch(`${srv.base}/${src.replace(/^\.?\//, "")}`);
      assert.equal(res.status, 200, `the page references ${src} but the server answers ${res.status}`);
      await res.arrayBuffer();
    }
  });

  it("serves every stylesheet the page asks for", async () => {
    const html = await (await fetch(`${srv.base}/`)).text();
    const hrefs = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(m => m[1]);
    for (const href of hrefs) {
      if (/^https?:/.test(href)) continue;
      const res = await fetch(`${srv.base}/${href.replace(/^\.?\//, "")}`);
      assert.equal(res.status, 200, `the page references ${href} but the server answers ${res.status}`);
      await res.arrayBuffer();
    }
  });

  it("an unknown path under public/ is a 404, not the index page", async () => {
    assert.equal((await fetch(`${srv.base}/definitely-not-a-file-here`)).status, 404);
  });
});

/* =========================================================================
   Security headers
   ========================================================================= */
describe("security headers", () => {
  it("CSP carries no 'unsafe-inline' in script-src", async () => {
    const d = csp((await fetch(`${srv.base}/`)).headers.get("content-security-policy"));
    assert.ok(d["script-src"], "no script-src directive at all");
    assert.ok(!d["script-src"].includes("'unsafe-inline'"),
      `script-src must not allow inline script: ${d["script-src"].join(" ")}`);
    assert.ok(!d["script-src"].includes("'unsafe-eval'"),
      `script-src must not allow eval: ${d["script-src"].join(" ")}`);
    assert.ok(!d["script-src"].includes("*"), "script-src must not be a wildcard");
    assert.ok(d["script-src"].includes("'self'"));
  });

  it("CSP forbids framing and plugins", async () => {
    const d = csp((await fetch(`${srv.base}/`)).headers.get("content-security-policy"));
    assert.deepEqual(d["frame-ancestors"], ["'none'"]);
    assert.deepEqual(d["object-src"], ["'none'"]);
    assert.deepEqual(d["base-uri"], ["'self'"]);
    assert.deepEqual(d["default-src"], ["'self'"]);
  });

  it("X-Content-Type-Options is nosniff and the framework is not advertised", async () => {
    const res = await fetch(`${srv.base}/`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-powered-by"), null);
    assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  });

  it("the same headers are on API responses, not just on HTML", async () => {
    const res = await fetch(`${srv.base}/api/config`);
    const d = csp(res.headers.get("content-security-policy"));
    assert.ok(!d["script-src"].includes("'unsafe-inline'"));
    assert.deepEqual(d["frame-ancestors"], ["'none'"]);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });

  it("development does not force HSTS; production does, with preload", async () => {
    assert.equal((await fetch(`${srv.base}/`)).headers.get("strict-transport-security"), null,
      "HSTS on plain-HTTP development would lock the machine to https://localhost");

    const hsts = (await fetch(`${prod.base}/`)).headers.get("strict-transport-security");
    assert.match(hsts || "", /max-age=31536000/);
    assert.match(hsts || "", /includeSubDomains/i);
    assert.match(hsts || "", /preload/i);
  });

  it("production upgrades insecure requests, development does not", async () => {
    assert.ok("upgrade-insecure-requests" in
      csp((await fetch(`${prod.base}/`)).headers.get("content-security-policy")));
    assert.ok(!("upgrade-insecure-requests" in
      csp((await fetch(`${srv.base}/`)).headers.get("content-security-policy"))));
  });

  it("connect-src is scoped to the configured project, with no wildcard host", async () => {
    const d = csp((await fetch(`${prod.base}/`)).headers.get("content-security-policy"));
    assert.ok(d["connect-src"].includes("https://canary.supabase.co"));
    assert.ok(d["connect-src"].includes("wss://canary.supabase.co"),
      "realtime needs the wss:// origin allowed or live bidding dies silently");
    assert.ok(!d["connect-src"].some(v => v.includes("*")),
      `a wildcard in connect-src is an exfiltration endpoint on an allowed host: ${d["connect-src"].join(" ")}`);
  });

  it("the CSP a browser gets is the CSP the page can actually run under", async () => {
    /* If the page loads a script from an origin script-src does not name,
       the browser drops it and the site is silently dead. */
    const html = await (await fetch(`${srv.base}/`)).text();
    const d = csp((await fetch(`${srv.base}/`)).headers.get("content-security-policy"));
    const srcs = [...html.matchAll(/<script[^>]+src="(https?:[^"]+)"/g)].map(m => m[1]);
    for (const src of srcs) {
      const origin = new URL(src).origin;
      assert.ok(d["script-src"].includes(origin),
        `index.html loads ${src} but script-src does not allow ${origin}`);
    }
    assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html),
      "an inline <script> cannot run under this CSP - it must move into a file");
  });
});

/* =========================================================================
   Rate limiting - its own server, because the counters are per-process.
   ========================================================================= */
describe("rate limiting", () => {
  it("/api/bid gives up at 12 in a minute", async () => {
    const { token } = await handshake(rl.base);
    const headers = { cookie: `si_csrf=${token}`, "x-csrf-token": token };
    const seen = [];
    for (let i = 0; i < 16; i++) {
      const res = await postJson(rl.base, "/api/bid", { listingId: "l", spotId: "s", max: 1, brand: "B" }, headers);
      seen.push(res.status);
      await res.arrayBuffer();
      if (res.status === 429) break;
    }
    assert.ok(seen.includes(429), `never rate limited: ${seen.join(",")}`);
    assert.ok(seen.indexOf(429) >= 12,
      `refused too early (at request ${seen.indexOf(429) + 1}) - the documented limit is 12/min`);
  });

  it("a rotating X-Forwarded-For does NOT buy a fresh quota", async () => {
    /* Hardcoding `trust proxy` used to make express believe an
       attacker-supplied X-Forwarded-For, which handed the limiter a key the
       attacker chose - measured: 12/min became unlimited. */
    const { token } = await handshake(rl.base);
    const statuses = [];
    for (let i = 0; i < 8; i++) {
      const res = await postJson(rl.base, "/api/bid",
        { listingId: "l", spotId: "s", max: 1, brand: "B" },
        {
          cookie: `si_csrf=${token}`,
          "x-csrf-token": token,
          "x-forwarded-for": `203.0.113.${i + 1}`,
          "x-real-ip": `198.51.100.${i + 1}`,
          "forwarded": `for=192.0.2.${i + 1}`,
        });
      statuses.push(res.status);
      await res.arrayBuffer();
    }
    assert.ok(statuses.every(s => s === 429),
      `rotating X-Forwarded-For reset the limiter: ${statuses.join(",")}`);
  });

  it("the limiter reports itself in standard headers only", async () => {
    const res = await fetch(`${rl.base}/api/config`);
    assert.ok(res.headers.get("ratelimit-limit") || res.headers.get("ratelimit"),
      "standardHeaders: true should publish a RateLimit-* header");
    assert.equal(res.headers.get("x-ratelimit-limit"), null, "legacy headers should be off");
  });

  it("a 429 carries a JSON message rather than an HTML error page", async () => {
    const { token } = await handshake(rl.base);
    const res = await postJson(rl.base, "/api/bid", { listingId: "l", spotId: "s", max: 1, brand: "B" },
      { cookie: `si_csrf=${token}`, "x-csrf-token": token });
    assert.equal(res.status, 429);
    assert.match((await res.json()).error, /bid/i);
  });
});

/* =========================================================================
   POST /api/settle/:listingId
   ========================================================================= */
describe("POST /api/settle/:listingId", () => {
  it("with no secret at all is forbidden", async () => {
    const res = await postJson(srv.base, "/api/settle/any-listing", {});
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "Forbidden.");
  });

  it("with the wrong secret of the same length is forbidden", async () => {
    const res = await postJson(srv.base, "/api/settle/any-listing", {},
      { "x-settle-secret": "x".repeat(SETTLE.length) });
    assert.equal(res.status, 403);
  });

  it("with a wrong secret of a different length is forbidden, not a crash", async () => {
    const res = await postJson(srv.base, "/api/settle/any-listing", {}, { "x-settle-secret": "nope" });
    assert.equal(res.status, 403);
  });

  it("with the RIGHT secret gets past the guard and stops at 'not configured'", async () => {
    const res = await postJson(srv.base, "/api/settle/any-listing", {}, { "x-settle-secret": SETTLE });
    assert.equal(res.status, 503, "the shared secret should be accepted; only the missing db stops it");
    assert.equal((await res.json()).error, "Not configured.");
  });

  it("a server with NO secret configured refuses even an empty secret", async () => {
    /* `if (!secret || ...)` - an unset SETTLE_SECRET must close the door,
       not open it to everyone who also sends nothing. */
    const res = await postJson(prod.base, "/api/settle/any-listing", {}, { "x-settle-secret": "" });
    assert.equal(res.status, 403);
  });
});

/* =========================================================================
   POST /api/webhook
   ========================================================================= */
describe("POST /api/webhook", () => {
  const EVENT = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: {} } });

  it("a bogus signature is never accepted (unconfigured)", async () => {
    const res = await postJson(srv.base, "/api/webhook", EVENT, { "stripe-signature": "t=1,v1=deadbeef" });
    assert.notEqual(res.status, 200);
    assert.ok([400, 503].includes(res.status), `got ${res.status}`);
  });

  it("a bogus signature is rejected with 400 when a signing secret IS configured", async () => {
    const res = await postJson(prod.base, "/api/webhook", EVENT, { "stripe-signature": "t=1,v1=deadbeef" });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Webhook Error/);
  });

  it("no signature header at all is rejected", async () => {
    for (const base of [srv.base, prod.base]) {
      const res = await postJson(base, "/api/webhook", EVENT);
      assert.notEqual(res.status, 200);
      assert.ok([400, 503].includes(res.status), `${base} answered ${res.status}`);
    }
  });

  it("a well-formed but wrongly-signed event is rejected", async () => {
    const res = await postJson(prod.base, "/api/webhook", EVENT, {
      "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}`,
    });
    assert.equal(res.status, 400);
  });

  it("the webhook is exempt from CSRF - Stripe's signature is the stronger check", async () => {
    /* It must fail on the SIGNATURE, not on a missing CSRF token: a 403 here
       would mean Stripe could never deliver anything. */
    const res = await postJson(prod.base, "/api/webhook", EVENT, { "stripe-signature": "t=1,v1=bad" });
    assert.notEqual(res.status, 403);
  });

  it("the rejection does not echo the body back", async () => {
    const res = await postJson(prod.base, "/api/webhook",
      JSON.stringify({ secret: "sk_live_shouldNotBeEchoed" }), { "stripe-signature": "t=1,v1=bad" });
    assert.ok(!(await res.text()).includes("sk_live_shouldNotBeEchoed"));
  });
});

/* =========================================================================
   The body parser.

   Aimed at a path no route claims, so the only thing under test is
   express.json() and the error handler behind it. A valid body at the same
   path is a 404, which is what proves a 500 came from the parser.
   ========================================================================= */
describe("malformed bodies", () => {
  const probe = (body, headers = {}) =>
    postJson(srv.base, "/api/parser-probe", body, headers);

  it("a valid body at the probe path is a plain 404", async () => {
    const res = await probe({ hello: "world" });
    assert.equal(res.status, 404);
  });

  it("BUG: malformed JSON answers 4xx, not 5xx", async () => {
    const res = await probe("{not valid json");
    assert.ok(res.status >= 400 && res.status < 500,
      `malformed JSON answered ${res.status}. body-parser raises an error carrying ` +
      `status 400, but the catch-all error handler at the bottom of server/index.js ` +
      `ignores err.status and rewrites every error to 500.`);
  });

  it("BUG: a body over the 64kb limit answers 413, not 5xx", async () => {
    const big = JSON.stringify({ text: "x".repeat(70_000) });
    const res = await probe(big);
    assert.ok(res.status >= 400 && res.status < 500,
      `a ${big.length}-byte body answered ${res.status}. body-parser raises ` +
      `entity.too.large with status 413; the catch-all error handler rewrites it to 500.`);
  });

  it("the oversized body is at least refused rather than accepted", async () => {
    const res = await probe(JSON.stringify({ text: "x".repeat(70_000) }));
    assert.notEqual(res.status, 200, "a body over the limit must not be processed");
  });

  it("a body just under the limit is accepted by the parser", async () => {
    const res = await probe(JSON.stringify({ text: "x".repeat(60_000) }));
    assert.equal(res.status, 404, "60kb is inside the 64kb limit, so the parser should pass it through");
  });

  it("an empty body is not a 5xx", async () => {
    const res = await probe("");
    assert.ok(res.status < 500, `empty body answered ${res.status}`);
  });

  it("a deeply nested body does not take the process down", async () => {
    let nested = { leaf: true };
    for (let i = 0; i < 500; i++) nested = { n: nested };
    const res = await probe(nested);
    assert.ok(res.status < 500, `answered ${res.status}`);
    assert.equal((await fetch(`${srv.base}/api/config`)).status, 200, "still alive");
  });

  it("a truncated body does not hang the connection", async () => {
    const res = await rawRequest(PORT_MAIN, "/api/parser-probe", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "2" },
      body: "{}",
    });
    assert.ok(res.status < 500, `answered ${res.status}`);
  });

  it("an error response never carries a stack trace", async () => {
    const res = await probe("{not valid json");
    const text = await res.text();
    assert.ok(!/at Object|node:internal|server[\\/]index\.js/.test(text),
      `an error response leaked internals:\n${text.slice(0, 400)}`);
  });
});

/* =========================================================================
   POST /api/bid, against the local stand-in database.

   "The server recomputes the price from its own copy of the listing and the
   spot, using market.js. The browser says WHICH spot and WHAT IT IS WILLING
   TO PAY. It never says what something costs." - README.

   Every case here stops before Stripe is reached.
   ========================================================================= */
describe("POST /api/bid", () => {
  const bid = async (body, { token, csrf } = {}) => {
    const { token: c } = csrf ? { token: csrf } : await handshake(bidSrv.base);
    const headers = { cookie: `si_csrf=${c}`, "x-csrf-token": c };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await postJson(bidSrv.base, "/api/bid", body, headers);
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };

  const good = over => Object.assign(
    { listingId: "L-OPEN", spotId: "S-1", max: FLOOR - 1, brand: "Acme" }, over);

  /* What the engine says, computed here rather than copied from the server. */
  const engineMinimum = () => Market.nextMinimum(
    { id: "S-1", floor: FLOOR },
    [{ bidder: RIVAL, brand: "Rival Co", max: RIVAL_MAX, at: Date.now() - 3600000 }]);

  it("the stand-in database really is standing in", async () => {
    const { config } = await handshake(bidSrv.base);
    assert.equal(config.supabaseUrl, fakeDb.url);
    assert.equal(config.mode, "test");
  });

  it("without a bearer token it is 401, not 503", async () => {
    const r = await bid(good());
    assert.equal(r.status, 401);
    assert.match(r.json.error, /Sign in/i);
  });

  it("an unrecognised bearer token is 401", async () => {
    const r = await bid(good(), { token: "not-a-real-token" });
    assert.equal(r.status, 401);
    assert.match(r.json.error, /session/i);
  });

  it("a non-string listingId or spotId is refused", async () => {
    const cases = [
      { listingId: 1, spotId: "S-1" },
      { listingId: "L-OPEN", spotId: 2 },
      { listingId: null, spotId: null },
      { listingId: ["L-OPEN"], spotId: "S-1" },
      { listingId: { id: "L-OPEN" }, spotId: "S-1" },
      { spotId: "S-1" },                       // listingId absent altogether
      { listingId: "L-OPEN" },                 // spotId absent altogether
    ];
    for (const over of cases) {
      const body = { max: FLOOR - 1, brand: "Acme", ...over };
      const r = await bid(body, { token: tokenFor("buyer") });
      assert.equal(r.status, 400, `${JSON.stringify(over)} answered ${r.status}`);
      assert.equal(r.json.error, "Which spot?", `${JSON.stringify(over)} gave "${r.json.error}"`);
    }
  });

  it("a missing, blank or oversized brand name is refused", async () => {
    for (const brand of [undefined, "", "   ", "x".repeat(61), 42, { toString: () => "x" }]) {
      const r = await bid(good({ brand }), { token: tokenFor("buyer") });
      assert.equal(r.status, 400, `brand ${JSON.stringify(brand)} answered ${r.status}`);
      assert.match(r.json.error, /brand name/i);
    }
  });

  it("a non-numeric maximum is refused", async () => {
    /* JSON cannot carry NaN or Infinity, so the interesting shapes are the
       ones a form or a tampered client really sends. */
    for (const max of ["abc", "1,200", "$1380", "1380 USD", {}, { v: 1 }, [1, 2], undefined]) {
      const r = await bid(good({ max }), { token: tokenFor("buyer") });
      assert.equal(r.status, 400, `max ${JSON.stringify(max)} answered ${r.status}`);
      assert.match(r.json.error, /amount/i, `max ${JSON.stringify(max)} gave "${r.json.error}"`);
    }
  });

  it("a numeric STRING maximum is read as a number, not rejected and not concatenated", async () => {
    const minimum = engineMinimum();
    const r = await bid(good({ max: String(minimum - 1) }), { token: tokenFor("buyer") });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /at least/i, "a numeric string should reach the price rules");
    assert.equal(r.json.minimum, minimum);
  });

  it("a publisher account cannot bid", async () => {
    const r = await bid(good(), { token: tokenFor("pubber") });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /brand account/i);
  });

  it("an unknown listing is a 404", async () => {
    const r = await bid(good({ listingId: "no-such-listing" }), { token: tokenFor("buyer") });
    assert.equal(r.status, 404);
    assert.match(r.json.error, /listing/i);
  });

  it("a closed listing is a 409", async () => {
    const r = await bid(good({ listingId: "L-SHUT", spotId: "S-SHUT" }), { token: tokenFor("buyer") });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /closed/i);
  });

  it("you cannot bid on your own listing, whatever your role says", async () => {
    const r = await bid(good({ listingId: "L-MINE", spotId: "S-MINE" }), { token: tokenFor("buyer") });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /your own listing/i);
  });

  it("a spot that belongs to another listing is a 404", async () => {
    const r = await bid(good({ listingId: "L-OPEN", spotId: "S-SHUT" }), { token: tokenFor("buyer") });
    assert.equal(r.status, 404);
    assert.match(r.json.error, /spot/i);
  });

  it("an unknown spot is a 404", async () => {
    const r = await bid(good({ spotId: "no-such-spot" }), { token: tokenFor("buyer") });
    assert.equal(r.status, 404);
  });

  it("a bid below the server's own minimum is refused, and the server states the minimum", async () => {
    const minimum = engineMinimum();
    const r = await bid(good({ max: minimum - 1 }), { token: tokenFor("buyer") });
    assert.equal(r.status, 400);
    assert.equal(r.json.minimum, minimum,
      "the server must answer with the minimum IT computed, not one the client proposed");
    assert.match(r.json.error, /at least/i);
  });

  it("the minimum the server enforces is the one the shared engine produces", async () => {
    /* The page quoted the buyer with Market.nextMinimum; if the server used a
       different number, an honest bid drawn by the page would be refused. */
    const minimum = engineMinimum();
    assert.equal(minimum, Market.raiseOver(FLOOR), "a lone bid sits at the floor, so the next bid is floor + 15%");
    const r = await bid(good({ max: FLOOR }), { token: tokenFor("buyer") });
    assert.equal(r.status, 400, "the floor itself no longer takes a spot somebody is holding");
    assert.equal(r.json.minimum, minimum);
  });

  it("a price the client invents in the body is ignored", async () => {
    /* Only listingId, spotId, max, brand and logo are read. Anything else a
       tampered client adds must change nothing. */
    const minimum = engineMinimum();
    const r = await bid(good({
      max: minimum - 1,
      price: 1, floor: 1, settled: 1, amount: 1, feePercent: 0, currency: "jpy",
    }), { token: tokenFor("buyer") });
    assert.equal(r.status, 400);
    assert.equal(r.json.minimum, minimum, "a client-supplied floor must not move the minimum");
  });

  it("nothing was written to the database by any refusal", async () => {
    assert.deepEqual(fakeDb.writes, [],
      `a refused bid wrote to the database: ${JSON.stringify(fakeDb.writes).slice(0, 300)}`);
  });
});

/* =========================================================================
   POST /api/chat/:id
   ========================================================================= */
describe("chat", () => {
  const say = async (room, body, token) => {
    const { token: c } = await handshake(bidSrv.base);
    const headers = { cookie: `si_csrf=${c}`, "x-csrf-token": c };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await postJson(bidSrv.base, `/api/chat/${room}`, body, headers);
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  it("an anonymous caller cannot post", async () => {
    const r = await say("room-anon", { text: "hello" });
    assert.equal(r.status, 401);
  });

  it("an empty message is a 400", async () => {
    for (const text of ["", "   ", "<>", undefined, null]) {
      const r = await say("room-empty", { text }, tokenFor("buyer"));
      assert.equal(r.status, 400, `text ${JSON.stringify(text)} answered ${r.status}`);
      assert.equal(r.json.error, "Empty message.");
    }
  });

  it("the author is taken from the verified session, never from the body", async () => {
    /* Trusting `who`/`role` from the body let anyone post as
       {who:"Maya (the publisher)", role:"client"}, which the page renders
       with a "· publisher" badge - a ready-made payment-redirect scam. */
    const r = await say("room-spoof", {
      who: "Maya (the publisher)", role: "client",
      text: "Pay the deposit to this account instead",
    }, tokenFor("buyer"));
    assert.equal(r.status, 200);
    assert.equal(r.json.message.who, "Acme", "who must come from the signed-in profile");
    assert.equal(r.json.message.role, "brand", "role must come from the signed-in profile");
  });

  it("a publisher is labelled a publisher", async () => {
    const r = await say("room-roles", { text: "I am the publisher" }, tokenFor("pubber"));
    assert.equal(r.status, 200);
    assert.equal(r.json.message.role, "client");
  });

  it("angle brackets are stripped and the length is capped", async () => {
    const r = await say("room-xss", {
      text: '<img src=x onerror="alert(1)">' + "y".repeat(600),
    }, tokenFor("buyer"));
    assert.equal(r.status, 200);
    assert.ok(!/[<>]/.test(r.json.message.text), "angle brackets survived into a stored message");
    assert.ok(r.json.message.text.length <= 400);
    assert.ok(r.json.message.who.length <= 60);
  });

  it("messages come back, and `since` filters them", async () => {
    const room = "room-read-" + Date.now();
    const first = await say(room, { text: "one" }, tokenFor("buyer"));
    const all = await (await fetch(`${bidSrv.base}/api/chat/${room}`)).json();
    assert.equal(all.messages.length, 1);
    assert.equal(all.messages[0].text, "one");

    const later = await (await fetch(`${bidSrv.base}/api/chat/${room}?since=${first.json.message.at}`)).json();
    assert.equal(later.messages.length, 0, "`since` should exclude what the caller already has");
  });

  it("an unknown room reads as empty rather than erroring", async () => {
    const res = await fetch(`${bidSrv.base}/api/chat/nobody-has-been-here`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).messages, []);
  });

  it("a garbage `since` does not throw", async () => {
    for (const q of ["abc", "", "-1", "1e999", "null"]) {
      const res = await fetch(`${bidSrv.base}/api/chat/room-xss?since=${q}`);
      assert.equal(res.status, 200, `since=${q} answered ${res.status}`);
      await res.arrayBuffer();
    }
  });
});
