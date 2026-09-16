"use strict";

/* =========================================================================
   Start the REAL server (server/index.js) as a child process, on a spare
   port, with a deliberately scrubbed environment.

   Why a child process and not `require`ing the app: server/index.js calls
   app.listen() at module scope and exports nothing, so the only honest way
   to test the HTTP contract is to run it the way production runs it and
   talk to it over a socket.

   Why the environment has to be scrubbed rather than just "not set": the
   server does `dotenv.config({ path: <repo>/.env })`. dotenv never
   overwrites a key that already exists in process.env - not even an empty
   one - so handing the child `STRIPE_SECRET_KEY: ""` is what actually keeps
   the developer's real .env out of the test run. Deleting the key would let
   .env win.
   ========================================================================= */

const path = require("path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");
const ENTRY = path.join(ROOT, "server", "index.js");

/* Every variable server/index.js reads, blanked. Anything added to the
   server's destructured env block should be added here too, otherwise a
   developer's real key silently leaks into the test run. */
const SCRUBBED = {
  STRIPE_SECRET_KEY: "",
  STRIPE_PUBLISHABLE_KEY: "",
  STRIPE_WEBHOOK_SECRET: "",
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  PLATFORM_FEE_PERCENT: "8",
  CURRENCY: "usd",
  PUBLIC_BASE_URL: "",
  NODE_ENV: "development",
  TRUST_PROXY: "",
  SETTLE_SECRET: "",
};

/**
 * @param {{ port: number, env?: Record<string,string> }} opts
 * @returns {Promise<{ port:number, base:string, stop:()=>Promise<void>,
 *                     out:()=>string, err:()=>string }>}
 */
async function startServer({ port, env = {} }) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, ...SCRUBBED, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let out = "", err = "";
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { err += d; });

  let exited = false;
  child.on("exit", () => { exited = true; });

  const base = `http://127.0.0.1:${port}`;

  /* Listening is when it answers, not when it logs. */
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (exited) throw new Error(`server exited before listening.\nstdout:\n${out}\nstderr:\n${err}`);
    try {
      const r = await fetch(`${base}/api/config`);
      if (r.ok) { await r.arrayBuffer(); break; }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`server never listened on ${port}.\nstdout:\n${out}\nstderr:\n${err}`);
    }
    await new Promise(r => setTimeout(r, 120));
  }

  const stop = () => new Promise(resolve => {
    if (exited) return resolve();
    child.once("exit", () => resolve());
    child.kill();
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 3000).unref();
  });

  return { port, base, stop, out: () => out, err: () => err, child };
}

/* -------------------------------------------------------------------------
   A request that sends the path EXACTLY as written.

   fetch() runs every URL through the WHATWG parser, which collapses `..`
   and - importantly - also collapses the percent-encoded spellings `%2e%2e`
   and `.%2e`. That means fetch can never actually put a traversal sequence
   on the wire, so a traversal test written with fetch tests the URL parser
   rather than the server. node:http's `path` option is passed through
   untouched, which is what an attacker with a socket would send.
   ------------------------------------------------------------------------- */
function rawRequest(port, rawPath, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: rawPath, headers },
      res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/* The single value of the Set-Cookie header for `name`, or null. */
function cookieValue(res, name) {
  const raw = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : [res.headers.get("set-cookie")].filter(Boolean);
  for (const line of raw) {
    const [pair] = String(line).split(";");
    const i = pair.indexOf("=");
    if (pair.slice(0, i).trim() === name) return decodeURIComponent(pair.slice(i + 1).trim());
  }
  return null;
}

module.exports = { startServer, rawRequest, cookieValue, SCRUBBED, ROOT };
