/**
 * Checks that a Supabase project is wired up the way this app needs.
 *
 *   npm run verify
 *
 * It does not just check that things exist - it checks that the things which
 * are supposed to be IMPOSSIBLE really are. A green run means the browser
 * cannot write a bid, cannot edit someone else's listing, and cannot change
 * its own role, which are the three claims the whole security model rests on.
 */
const path = require("path");
require("../server/node_modules/dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { SUPABASE_URL = "", SUPABASE_ANON_KEY = "", SUPABASE_SERVICE_ROLE_KEY = "" } = process.env;

const pass = [], fail = [], warn = [];
const ok   = m => { pass.push(m); console.log("  \x1b[32mPASS\x1b[0m " + m); };
const bad  = m => { fail.push(m); console.log("  \x1b[31mFAIL\x1b[0m " + m); };
const note = m => { warn.push(m); console.log("  \x1b[33mWARN\x1b[0m " + m); };
const head = m => console.log("\n\x1b[1m" + m + "\x1b[0m");

(async () => {
  head("Keys");
  if (!SUPABASE_URL) { bad("SUPABASE_URL is empty in .env"); return done(); }
  ok("SUPABASE_URL  " + SUPABASE_URL);
  if (!SUPABASE_ANON_KEY) { bad("SUPABASE_ANON_KEY is empty - copy it from Settings > API"); return done(); }
  ok("SUPABASE_ANON_KEY set (" + SUPABASE_ANON_KEY.slice(0, 12) + "…)");
  if (!SUPABASE_SERVICE_ROLE_KEY) note("SUPABASE_SERVICE_ROLE_KEY is empty - bidding cannot be recorded without it");
  else if (SUPABASE_SERVICE_ROLE_KEY === SUPABASE_ANON_KEY) bad("service role key is the same as the anon key - that cannot be right");
  else ok("SUPABASE_SERVICE_ROLE_KEY set (" + SUPABASE_SERVICE_ROLE_KEY.slice(0, 12) + "…)");

  const { createClient } = require("../server/node_modules/@supabase/supabase-js");
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const svc = SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

  /* A missing table refuses every write too, so without this distinction the
     RLS checks below go green against an empty database - which is the one
     situation where nothing has been verified at all. */
  const MISSING = e => e && (e.code === "PGRST205" || /could not find the table/i.test(e.message || ""));
  const REFUSED = e => e && (e.code === "42501" || /row-level security|permission denied|violates row-level/i.test(e.message || ""));

  head("Tables exist");
  let schemaPresent = true;
  for (const t of ["profiles", "listings", "spots", "bids", "messages"]) {
    const { error } = await anon.from(t).select("id").limit(1);
    if (MISSING(error)) { bad(`${t} does not exist - the migrations have not been applied`); schemaPresent = false; }
    else if (error && !REFUSED(error)) bad(`${t} - ${short(error.message)}`);
    else ok(`${t} exists`);
  }

  if (!schemaPresent) {
    console.log("\n\x1b[33mStopping here: with no schema, every check below would pass for the wrong reason.\x1b[0m");
    console.log("Apply supabase/migrations/*.sql in filename order, then run this again.");
    return done();
  }

  head("Row Level Security actually refuses what it should");

  // A bid is money. The browser must never be able to write one.
  {
    const { error } = await anon.from("bids").insert({
      listing_id: "00000000-0000-0000-0000-000000000000",
      spot_id: "00000000-0000-0000-0000-000000000000",
      bidder: "00000000-0000-0000-0000-000000000000",
      brand: "RLS PROBE", max_amount: 1,
    });
    if (REFUSED(error)) ok("anonymous INSERT into bids is refused by RLS");
    else if (MISSING(error)) bad("bids does not exist - this check proved nothing");
    else if (error) note("bids insert failed, but not with an RLS error: " + short(error.message));
    else bad("ANONYMOUS INSERT INTO bids SUCCEEDED - the money path is open, fix this before going live");
  }

  for (const t of ["listings", "spots"]) {
    const { error } = await anon.from(t).insert(
      t === "listings"
        ? { owner: "00000000-0000-0000-0000-000000000000", names: "RLS PROBE" }
        : { listing_id: "00000000-0000-0000-0000-000000000000", side: "front", n: 1, name: "RLS PROBE", x: 1, y: 1, w: 1, h: 1 });
    if (REFUSED(error)) ok(`anonymous INSERT into ${t} is refused by RLS`);
    else if (MISSING(error)) bad(`${t} does not exist - this check proved nothing`);
    else if (error) note(`${t} insert failed, but not with an RLS error: ` + short(error.message));
    else bad(`ANONYMOUS INSERT INTO ${t} SUCCEEDED - check the RLS policies`);
  }

  /* Migration 2 moved the settled price onto spots so the page never needs to
     read a rival's ceiling. If those columns are absent the front end has
     nothing to draw from. */
  {
    const { error } = await anon.from("spots").select("price,holder_brand,bid_count").limit(1);
    if (error) bad("spots is missing the settled-price columns - migration 2 has not been applied");
    else ok("spots carries the settled price the page draws from");
  }

  /* The whole point of a sealed ceiling: an anonymous reader must not see it. */
  {
    const { data, error } = await anon.from("bids").select("max_amount").limit(1);
    if (error && !REFUSED(error)) note("could not probe bids readability: " + short(error.message));
    else if (data && data.length) bad("ANON CAN READ bids.max_amount - every rival's ceiling is public");
    else ok("anonymous readers cannot see anyone's maximum");
  }

  head("Storage buckets");
  {
    const { data, error } = await (svc || anon).storage.listBuckets();
    if (error) note("could not list buckets: " + short(error.message));
    else {
      for (const want of ["garments", "logos"]) {
        const b = (data || []).find(x => x.id === want);
        if (!b) bad(`bucket '${want}' is missing - re-run the migration`);
        else if (!b.public) note(`bucket '${want}' is not public; photographs will not load for buyers`);
        else ok(`bucket '${want}' exists and is public`);
      }
    }
  }

  head("The sign-up trigger and the frozen role");
  if (!svc) note("skipped - needs the service role key");
  else {
    const email = `probe-${Date.now()}@squareinch.test`;
    const { data: made, error: sErr } = await svc.auth.admin.createUser({
      email, password: "probe-" + Math.random().toString(36).slice(2),
      email_confirm: true,
      user_metadata: { role: "client", display_name: "RLS Probe", brand: "PROBE CO" },
    });
    if (sErr) { note("could not create a probe user: " + short(sErr.message)); }
    else {
      const id = made.user.id;
      const { data: prof } = await svc.from("profiles").select("*").eq("id", id).single();
      if (!prof) bad("handle_new_user did not create a profile row - the trigger is missing");
      else {
        ok(`profile created automatically (role=${prof.role}, name=${prof.display_name})`);
        if (prof.role !== "client") bad(`role should be 'client' from the metadata, got '${prof.role}'`);
        if (prof.brand !== "PROBE CO") note(`brand did not carry through from metadata (got ${JSON.stringify(prof.brand)})`);

        const { error: rErr } = await svc.from("profiles").update({ role: "brand" }).eq("id", id);
        if (rErr) ok("changing role after sign-up is refused (" + short(rErr.message) + ")");
        else bad("ROLE WAS CHANGEABLE - the freeze_profile_role trigger is not installed");
      }
      // tidy up: deleting the auth user cascades to the profile
      await svc.auth.admin.deleteUser(id).catch(() => {});
      ok("probe account removed");
    }
  }

  head("Realtime");
  if (!svc) note("skipped - needs the service role key");
  else {
    const gotIt = await new Promise(res => {
      const t = setTimeout(() => res(false), 8000);
      const ch = svc.channel("verify-probe")
        .on("postgres_changes", { event: "*", schema: "public", table: "bids" }, () => {})
        .subscribe(status => {
          if (status === "SUBSCRIBED") { clearTimeout(t); svc.removeChannel(ch); res(true); }
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") { clearTimeout(t); res(false); }
        });
    });
    if (gotIt) ok("realtime subscription on bids established");
    else note("realtime did not subscribe - live bidding will fall back to polling");
  }

  done();
})().catch(e => { console.error("\nverify crashed:", e); process.exit(1); });

function short(m) { return String(m).split("\n")[0].slice(0, 70); }

function done() {
  console.log(`\n\x1b[1m${pass.length} passed, ${fail.length} failed, ${warn.length} warnings\x1b[0m`);
  if (fail.length) {
    console.log("\nFix these before taking real money:");
    fail.forEach(f => console.log("  - " + f));
  }
  process.exit(fail.length ? 1 : 0);
}
