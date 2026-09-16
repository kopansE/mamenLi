"use strict";

/* =========================================================================
   A local stand-in for Supabase: GoTrue's /auth/v1/user plus enough of
   PostgREST for the queries server/index.js actually makes.

   This exists so /api/bid can be tested at all. Every interesting guard on
   that route - "you cannot bid your own listing", "bidding is closed",
   "that is below the minimum" - sits behind `requireUser`, which returns 503
   the moment there is no database. Without a database of some kind the one
   endpoint that decides prices and takes money is untestable.

   It is in-process and bound to 127.0.0.1, so nothing leaves the machine.

   What it implements, and no more:
     GET   /auth/v1/user                 - the bearer token to a user object
     GET   /rest/v1/<table>?col=eq.v&…   - eq / in filters, select=*
     POST|PATCH|DELETE /rest/v1/<table>  - recorded, so a test can prove the
                                           server did NOT write on a refusal
   ========================================================================= */

const http = require("node:http");

/* PostgREST's answer when `.single()` does not find exactly one row. */
const PGRST116 = {
  code: "PGRST116",
  details: "The result contains 0 rows",
  hint: null,
  message: "JSON object requested, multiple (or no) rows returned",
};

function matches(row, filters) {
  return filters.every(([col, op, val]) => {
    const cell = row[col];
    if (op === "eq") return String(cell) === val;
    if (op === "neq") return String(cell) !== val;
    if (op === "in") {
      const set = val.replace(/^\(|\)$/g, "").split(",").map(s => s.replace(/^"|"$/g, ""));
      return set.includes(String(cell));
    }
    if (op === "is") return val === "null" ? cell == null : String(cell) === val;
    return true;
  });
}

/**
 * @param {{ tables?: object, tokens?: Record<string,string> }} seed
 *   tables: { profiles:[], listings:[], spots:[], bids:[] }
 *   tokens: { "<access token>": "<user id>" }
 */
async function startFakeSupabase(seed = {}) {
  const tables = seed.tables || {};
  const tokens = seed.tokens || {};
  const users = seed.users || {};           // id -> { id, email }
  const writes = [];                        // every non-GET against /rest/v1

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fake");
    const send = (status, body) => {
      const text = body === undefined ? "" : JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(text);
    };

    /* ------------------------------------------------------------ auth */
    if (url.pathname === "/auth/v1/user") {
      const auth = req.headers.authorization || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const id = tokens[token];
      if (!id) return send(401, { code: 401, msg: "invalid claim: missing sub claim" });
      return send(200, users[id] || { id, email: `${id}@example.test`, aud: "authenticated" });
    }

    /* -------------------------------------------------------- postgrest */
    const rest = url.pathname.match(/^\/rest\/v1\/([A-Za-z0-9_]+)$/);
    if (!rest) return send(404, { message: "not found" });
    const table = rest[1];
    const rows = tables[table] || [];

    const filters = [];
    for (const [key, raw] of url.searchParams) {
      if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(key)) continue;
      const i = raw.indexOf(".");
      if (i > 0) filters.push([key, raw.slice(0, i), raw.slice(i + 1)]);
    }

    if (req.method !== "GET") {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => {
        writes.push({ method: req.method, table, filters, body });
        /* PostgREST answers 204 with no body unless Prefer: return= asks. */
        const wants = /return=representation/.test(req.headers.prefer || "");
        if (!wants) { res.writeHead(204).end(); return; }
        send(200, []);
      });
      return;
    }

    const hit = rows.filter(r => matches(r, filters));
    const single = /pgrst\.object/.test(req.headers.accept || "");
    if (single) {
      if (hit.length !== 1) return send(406, PGRST116);
      return send(200, hit[0]);
    }
    return send(200, hit);
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    writes,
    tables,
    stop: () => new Promise(r => server.close(r)),
  };
}

module.exports = { startFakeSupabase };
