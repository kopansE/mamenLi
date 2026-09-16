"use strict";

/* =========================================================================
   Integration tests against the REAL Supabase project named in .env.

   `npm run verify` proves the three headline claims from the outside with an
   anonymous client. This goes further and uses real signed-in accounts,
   because most of the security model is about one authenticated user versus
   another, which an anonymous probe cannot express: a brand editing somebody
   else's listing, a publisher uploading into somebody else's storage folder,
   an account trying to change the side it is on.

   Rules this file holds itself to:

     * Every row it creates carries a unique run tag, `__test_<ms>__`, and it
       only ever deletes ids it created in this process. A row without the tag
       is never touched, whatever else happens.
     * Cleanup is in after(), so it runs when assertions FAIL, which is
       exactly when leftovers would otherwise accumulate.
     * Deleting the auth user cascades to profiles -> listings -> spots ->
       bids -> messages. Storage objects do not cascade, so they are removed
       by hand.
     * With no keys in .env the whole suite skips, so a developer who has
       never touched Supabase still gets a green run.
   ========================================================================= */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

let createClient = null;
let loadError = null;
try {
  require("../server/node_modules/dotenv").config({ path: path.join(__dirname, "..", ".env") });
  ({ createClient } = require("../server/node_modules/@supabase/supabase-js"));
} catch (err) {
  loadError = err;
}

const {
  SUPABASE_URL = "",
  SUPABASE_ANON_KEY = "",
  SUPABASE_SERVICE_ROLE_KEY = "",
} = process.env;

const missing = [
  !SUPABASE_URL && "SUPABASE_URL",
  !SUPABASE_ANON_KEY && "SUPABASE_ANON_KEY",
  !SUPABASE_SERVICE_ROLE_KEY && "SUPABASE_SERVICE_ROLE_KEY",
].filter(Boolean);

const SUITE_OPTS = loadError
  ? { skip: `server/node_modules is not installed (${loadError.message}) - run npm run setup` }
  : missing.length
    ? { skip: `no Supabase keys configured: ${missing.join(", ")} empty in .env` }
    : {};

/* A tag nothing real could collide with, and the only thing this file will
   ever agree to delete. */
const RUN = `__test_${Date.now()}__`;
const TAGGED = new RegExp(`^${RUN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

const A_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

describe("Supabase project", SUITE_OPTS, () => {
  /** Everything this run made, and therefore everything it may delete. */
  const made = { users: [], storage: [] /* [bucket, key] */ };

  let svc = null;              // service role - bypasses RLS
  let anon = null;             // the browser's own key, signed out
  let brand = null;            // { id, email, client } - role 'brand'
  let owner = null;            // { id, email, client } - role 'client', owns a listing
  let stranger = null;         // { id, email, client } - role 'brand', owns nothing
  let listing = null;          // owned by `owner`
  let spot = null;             // on `listing`

  const password = () => "T3st-" + Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2);
  const email = who => `${RUN}${who}@squareinch.test`.toLowerCase();

  /** Create an auth user through the admin API and sign a client in as them. */
  async function makeUser(who, meta) {
    const pw = password();
    const { data, error } = await svc.auth.admin.createUser({
      email: email(who), password: pw, email_confirm: true,
      user_metadata: { display_name: `${RUN}${who}`, ...meta },
    });
    assert.ok(!error, `could not create the ${who} account: ${error && error.message}`);
    made.users.push(data.user.id);

    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { error: sErr } = await client.auth.signInWithPassword({ email: email(who), password: pw });
    assert.ok(!sErr, `could not sign in as ${who}: ${sErr && sErr.message}`);
    return { id: data.user.id, email: email(who), client };
  }

  before(async () => {
    svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    brand = await makeUser("brand", { role: "brand", brand: `${RUN}Acme` });
    owner = await makeUser("owner", { role: "client" });
    stranger = await makeUser("stranger", { role: "brand", brand: `${RUN}Rival` });

    /* The owner creates their own listing through the anon key, as the page
       does. If this fails, the insert policy is wrong and every later
       assertion about "somebody else's listing" would be vacuous. */
    const { data: l, error: lErr } = await owner.client.from("listings").insert({
      owner: owner.id,
      names: `${RUN}Maya & Tal`,
      garment: "gown",
      goal: 5000,
      is_open: true,
      closes_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    }).select().single();
    assert.ok(!lErr, `the owner could not create their own listing: ${lErr && lErr.message}`);
    listing = l;

    const { data: s, error: sErr } = await owner.client.from("spots").insert({
      listing_id: listing.id, side: "front", n: 1,
      name: `${RUN}spot`, x: 10, y: 10, w: 20, h: 10, floor: 500,
    }).select().single();
    assert.ok(!sErr, `the owner could not create a spot on their own listing: ${sErr && sErr.message}`);
    spot = s;
  });

  /* A PostgREST builder is a thenable, not a Promise - it has no .catch. */
  const quietly = async thenable => { try { return await thenable; } catch { return null; } };

  /* The only folders this run is allowed to delete out of storage. */
  const ours = key => {
    const folder = String(key).split("/")[0];
    return made.users.includes(folder) || (listing && folder === listing.id);
  };

  /* Runs even when an assertion above threw - which is exactly when
     leftovers would otherwise pile up in a real project. */
  after(async () => {
    if (!svc) return;

    for (const [bucket, key] of made.storage) {
      if (!ours(key)) continue;                       // never touch anything else
      await quietly(svc.storage.from(bucket).remove([key]));
    }

    /* Deleting the auth user cascades: profiles -> listings -> spots -> bids
       -> messages. Nothing untagged is reachable from these ids. */
    for (const id of made.users) {
      await quietly(svc.auth.admin.deleteUser(id));
    }

    /* A belt-and-braces sweep, still only for rows carrying this run's tag. */
    await quietly(svc.from("listings").delete().like("names", `${RUN}%`));
    await quietly(svc.from("profiles").delete().like("display_name", `${RUN}%`));
  });

  /* ==================================================================== */
  describe("the sign-up trigger", () => {
    it("gives every new account a profile row", async () => {
      const { data, error } = await svc.from("profiles").select("*").eq("id", brand.id).single();
      assert.ok(!error, `handle_new_user did not create a profile: ${error && error.message}`);
      assert.equal(data.id, brand.id);
      assert.equal(data.display_name, `${RUN}brand`);
      assert.equal(data.brand, `${RUN}Acme`);
    });

    it("honours a self-selected 'client' role", async () => {
      const { data } = await svc.from("profiles").select("role").eq("id", owner.id).single();
      assert.equal(data.role, "client");
    });

    it("CLAMPS anything that is not 'client' to 'brand'", async () => {
      /* The role decides who may bid and who may list. Anything unrecognised
         must land on the less privileged side, not be stored verbatim. */
      for (const claimed of ["admin", "service_role", "CLIENT", "client ", "", null, 42, { role: "client" }]) {
        const who = `clamp-${Math.random().toString(36).slice(2, 8)}`;
        const { data, error } = await svc.auth.admin.createUser({
          email: email(who), password: password(), email_confirm: true,
          user_metadata: { role: claimed, display_name: `${RUN}${who}` },
        });
        assert.ok(!error, `could not create the probe account: ${error && error.message}`);
        made.users.push(data.user.id);

        const { data: prof } = await svc.from("profiles").select("role").eq("id", data.user.id).single();
        assert.equal(prof.role, "brand",
          `a role of ${JSON.stringify(claimed)} was stored as ${JSON.stringify(prof.role)}`);
      }
    });

    it("falls back to the email local part when no display name is given", async () => {
      const who = `noname-${Math.random().toString(36).slice(2, 8)}`;
      const { data, error } = await svc.auth.admin.createUser({
        email: email(who), password: password(), email_confirm: true,
        user_metadata: { role: "brand" },
      });
      assert.ok(!error, error && error.message);
      made.users.push(data.user.id);

      const { data: prof } = await svc.from("profiles").select("display_name").eq("id", data.user.id).single();
      assert.equal(prof.display_name, email(who).split("@")[0]);
    });
  });

  /* ==================================================================== */
  describe("the frozen role", () => {
    it("refuses a role change even from the SERVICE ROLE", async () => {
      /* The trigger is not an RLS policy, so it binds the service role too.
         That matters: an owner opening a second account to bid themselves up
         is the attack, and the service key is what the server holds. */
      const { error } = await svc.from("profiles").update({ role: "client" }).eq("id", brand.id);
      assert.ok(error, "the role was changed - freeze_profile_role is not installed");
      assert.match(error.message, /role cannot be changed/i);

      const { data } = await svc.from("profiles").select("role").eq("id", brand.id).single();
      assert.equal(data.role, "brand", "the role changed despite the error");
    });

    it("refuses a role change from the account's own client", async () => {
      const { error } = await brand.client.from("profiles").update({ role: "client" }).eq("id", brand.id);
      assert.ok(error, "an account changed its own side of the table");
    });

    it("still allows the fields that ARE meant to be editable", async () => {
      const { error } = await brand.client.from("profiles")
        .update({ display_name: `${RUN}renamed`, brand: `${RUN}Renamed Co` }).eq("id", brand.id);
      assert.ok(!error, `the profile became read-only: ${error && error.message}`);

      const { data } = await svc.from("profiles").select("display_name, role").eq("id", brand.id).single();
      assert.equal(data.display_name, `${RUN}renamed`);
      assert.equal(data.role, "brand", "an unrelated update must not disturb the role");
    });

    it("an account cannot write a profile row for somebody else", async () => {
      const { error } = await stranger.client.from("profiles")
        .update({ display_name: `${RUN}hijacked` }).eq("id", brand.id);
      /* RLS answers by matching nothing rather than by erroring. */
      const { data } = await svc.from("profiles").select("display_name").eq("id", brand.id).single();
      assert.notEqual(data.display_name, `${RUN}hijacked`,
        `a stranger rewrote another account's profile${error ? "" : " with no error at all"}`);
    });
  });

  /* ==================================================================== */
  describe("listings and spots belong to their owner", () => {
    it("a signed-in non-owner cannot update someone else's listing", async () => {
      const { error } = await brand.client.from("listings")
        .update({ names: `${RUN}HIJACKED`, goal: 1, is_open: false }).eq("id", listing.id);

      const { data } = await svc.from("listings").select("names, goal, is_open").eq("id", listing.id).single();
      assert.equal(data.names, `${RUN}Maya & Tal`,
        `a non-owner rewrote the listing${error ? "" : " with no error at all"}`);
      assert.equal(Number(data.goal), 5000);
      assert.equal(data.is_open, true);
    });

    it("a signed-in non-owner cannot delete someone else's listing", async () => {
      await brand.client.from("listings").delete().eq("id", listing.id);
      const { data } = await svc.from("listings").select("id").eq("id", listing.id).maybeSingle();
      assert.ok(data, "a non-owner deleted somebody else's listing");
    });

    it("a listing cannot be inserted under somebody else's name", async () => {
      const { error } = await brand.client.from("listings")
        .insert({ owner: owner.id, names: `${RUN}forged` }).select();
      assert.ok(error, "a listing was created with a forged owner");
    });

    it("a BRAND account cannot open a listing at all", async () => {
      /* Without a role check on insert, the client/brand split lives only in
         the UI and any signed-in account can create listings through
         PostgREST - and then bid on the ones it does not own. */
      const { error } = await brand.client.from("listings")
        .insert({ owner: brand.id, names: `${RUN}brand-owned` }).select();
      assert.ok(error, "a brand account opened a listing of its own");
    });

    it("a non-owner cannot update a spot on someone else's listing", async () => {
      /* Spots are checked against the owner of their PARENT listing, which is
         the easy one to get wrong. */
      const { error } = await brand.client.from("spots")
        .update({ floor: 1, name: `${RUN}HIJACKED` }).eq("id", spot.id);

      const { data } = await svc.from("spots").select("floor, name").eq("id", spot.id).single();
      assert.equal(Number(data.floor), 500,
        `a non-owner moved the floor on somebody else's spot${error ? "" : " with no error at all"}`);
      assert.equal(data.name, `${RUN}spot`);
    });

    it("a non-owner cannot insert a spot onto someone else's listing", async () => {
      const { error } = await brand.client.from("spots").insert({
        listing_id: listing.id, side: "back", n: 99,
        name: `${RUN}squatter`, x: 1, y: 1, w: 5, h: 5, floor: 1,
      }).select();
      assert.ok(error, "a stranger added a spot to somebody else's garment");
    });

    it("a non-owner cannot delete a spot from someone else's listing", async () => {
      await brand.client.from("spots").delete().eq("id", spot.id);
      const { data } = await svc.from("spots").select("id").eq("id", spot.id).maybeSingle();
      assert.ok(data, "a stranger deleted a spot from somebody else's garment");
    });

    it("the owner CAN still edit their own", async () => {
      const { error } = await owner.client.from("spots").update({ floor: 600 }).eq("id", spot.id);
      assert.ok(!error, `the owner lost write access to their own spot: ${error && error.message}`);
      const { data } = await svc.from("spots").select("floor").eq("id", spot.id).single();
      assert.equal(Number(data.floor), 600);
      await owner.client.from("spots").update({ floor: 500 }).eq("id", spot.id);
    });

    it("everyone can READ - the market is meant to be visible", async () => {
      for (const [who, client] of [["anon", anon], ["a brand", brand.client]]) {
        const { data, error } = await client.from("listings").select("id").eq("id", listing.id);
        assert.ok(!error, `${who} could not read listings: ${error && error.message}`);
        assert.equal(data.length, 1, `${who} could not see an open listing`);
      }
    });
  });

  /* ==================================================================== */
  describe("bids are writable by nobody but the server, and readable by almost nobody", () => {
    let serverBid = null;

    before(async () => {
      /* Written with the service role, the way the server does once Stripe
         has authorised a card. Everything below tries to disturb it. */
      const { data, error } = await svc.from("bids").insert({
        listing_id: listing.id, spot_id: spot.id, bidder: brand.id,
        brand: `${RUN}Acme`, max_amount: 1000, status: "held",
      }).select().single();
      assert.ok(!error, `even the service role could not write a bid: ${error && error.message}`);
      serverBid = data;
    });

    it("the anon client cannot INSERT a bid", async () => {
      const { error } = await anon.from("bids").insert({
        listing_id: listing.id, spot_id: spot.id, bidder: brand.id,
        brand: `${RUN}forged`, max_amount: 999999,
      }).select();
      assert.ok(error, "ANONYMOUS INSERT INTO bids SUCCEEDED - the money path is open");
    });

    it("a SIGNED-IN brand cannot insert a bid either", async () => {
      /* verify-supabase.js probes this anonymously; a real attacker has an
         account, and `authenticated` is a different Postgres role to `anon`. */
      const { error } = await brand.client.from("bids").insert({
        listing_id: listing.id, spot_id: spot.id, bidder: brand.id,
        brand: `${RUN}forged`, max_amount: 999999,
      }).select();
      assert.ok(error, "a signed-in brand wrote its own bid - it could then name its own price");
    });

    it("nobody can UPDATE a bid", async () => {
      for (const [who, client] of [["anon", anon], ["the bidder", brand.client], ["the owner", owner.client]]) {
        await client.from("bids").update({ max_amount: 1, status: "captured", withdrawn: true }).eq("id", serverBid.id);
        const { data } = await svc.from("bids").select("max_amount, status, withdrawn").eq("id", serverBid.id).single();
        assert.equal(Number(data.max_amount), 1000, `${who} rewrote a bid`);
        assert.equal(data.status, "held", `${who} changed a bid's status`);
        assert.equal(data.withdrawn, false, `${who} withdrew somebody's bid`);
      }
    });

    it("nobody can DELETE a bid", async () => {
      for (const [who, client] of [["anon", anon], ["the bidder", brand.client], ["the owner", owner.client]]) {
        await client.from("bids").delete().eq("id", serverBid.id);
        const { data } = await svc.from("bids").select("id").eq("id", serverBid.id).maybeSingle();
        assert.ok(data, `${who} deleted a bid`);
      }
    });

    it("a rival cannot READ a maximum - proxy bidding only works if the ceiling is secret", async () => {
      /* `bids readable using (true)` published every brand's ceiling to
         anyone holding the anon key, which the page publishes by design.
         Knowing the ceiling, you bid one unit over it every time. */
      for (const [who, client] of [["anon", anon], ["a rival brand", stranger.client]]) {
        const { data, error } = await client.from("bids").select("max_amount").eq("id", serverBid.id);
        assert.ok(!error || /permission|policy/i.test(error.message),
          `${who} got an unexpected error reading bids: ${error && error.message}`);
        assert.equal((data || []).length, 0,
          `${who} can read a rival's maximum (${JSON.stringify(data)}) and outbid it by one unit`);
      }
    });

    it("the bidder can read their own bid", async () => {
      const { data, error } = await brand.client.from("bids").select("max_amount").eq("id", serverBid.id);
      assert.ok(!error, `a brand could not see its own bid: ${error && error.message}`);
      assert.equal((data || []).length, 1, "a brand cannot see its own bidding history");
    });

    it("the publisher can read the bids on their own garment - they are the one being paid", async () => {
      const { data, error } = await owner.client.from("bids").select("max_amount").eq("id", serverBid.id);
      assert.ok(!error, `the owner could not see bids on their own listing: ${error && error.message}`);
      assert.equal((data || []).length, 1);
    });

    it("the page can still draw the market from the spot row, without reading anyone's maximum", async () => {
      /* The settled figures are denormalised onto `spots` by the server
         precisely so the browser never needs the bids table. */
      const { data, error } = await anon.from("spots")
        .select("price, holder, holder_brand, bid_count").eq("id", spot.id).single();
      assert.ok(!error, `the public spot row is unreadable: ${error && error.message}`);
      assert.ok("price" in data && "holder_brand" in data,
        "spots does not carry the settled price, so the page has nothing to draw with");
    });

    it("one bidder cannot hold two live authorisations on the same spot", async () => {
      /* Two `held` rows for one bidder meant settlement captured both and
         charged the same brand twice for one spot. */
      const { error } = await svc.from("bids").insert({
        listing_id: listing.id, spot_id: spot.id, bidder: brand.id,
        brand: `${RUN}Acme`, max_amount: 2000, status: "held",
      }).select();
      assert.ok(error, "a second live authorisation was allowed on one spot for one bidder");
      assert.match(error.message, /duplicate key|unique/i);
    });
  });

  /* ==================================================================== */
  describe("messages", () => {
    /* The insert policy checks display_name against coalesce(brand, display_name)
       on the writer's own profile, so read it rather than assuming. */
    const nameFor = async id => {
      const { data } = await svc.from("profiles").select("brand, display_name, role").eq("id", id).single();
      return { name: data.brand || data.display_name, role: data.role };
    };

    it("you may only write as yourself", async () => {
      const { error } = await brand.client.from("messages").insert({
        listing_id: listing.id, author: owner.id,
        display_name: `${RUN}Maya`, role: "client", body: "Pay the deposit to this account instead",
      }).select();
      assert.ok(error, "a brand posted a message signed as the publisher");
    });

    it("you may not claim a display name or a role that is not yours", async () => {
      const me = await nameFor(brand.id);
      for (const forged of [
        { display_name: `${RUN}Maya`, role: me.role },
        { display_name: me.name, role: "client" },
      ]) {
        const { error } = await brand.client.from("messages").insert({
          listing_id: listing.id, author: brand.id, body: `${RUN} impersonation attempt`, ...forged,
        }).select();
        assert.ok(error,
          `a brand posted as ${JSON.stringify(forged)} - the page renders role 'client' with a ` +
          "'· publisher' badge, which is a ready-made payment-redirect scam");
      }
    });

    it("writing as yourself works", async () => {
      const me = await nameFor(brand.id);
      const { error } = await brand.client.from("messages").insert({
        listing_id: listing.id, author: brand.id,
        display_name: me.name, role: me.role, body: `${RUN} a genuine question`,
      }).select();
      assert.ok(!error, `a brand could not ask a question: ${error && error.message}`);
    });
  });

  /* ==================================================================== */
  describe("storage", () => {
    it("both buckets exist and are public", async () => {
      const { data, error } = await svc.storage.listBuckets();
      assert.ok(!error, `could not list buckets: ${error && error.message}`);
      for (const want of ["garments", "logos"]) {
        const bucket = (data || []).find(b => b.id === want);
        assert.ok(bucket, `bucket '${want}' is missing - re-run the migration`);
        assert.equal(bucket.public, true, `bucket '${want}' is private; photographs would not load for buyers`);
      }
    });

    it("you may write into a logos folder named after your own id", async () => {
      const key = `${brand.id}/logo.png`;
      const { error } = await brand.client.storage.from("logos")
        .upload(key, A_PNG, { upsert: true, contentType: "image/png" });
      assert.ok(!error, `a brand could not upload its own mark: ${error && error.message}`);
      made.storage.push(["logos", key]);
    });

    it("you may NOT write into somebody else's logos folder", async () => {
      const key = `${brand.id}/logo.png`;
      const { error } = await stranger.client.storage.from("logos")
        .upload(key, A_PNG, { upsert: true, contentType: "image/png" });
      assert.ok(error, "a stranger overwrote another brand's mark - every page would render it");
    });

    it("an anonymous caller may not write a logo at all", async () => {
      const { error } = await anon.storage.from("logos")
        .upload(`${brand.id}/logo.png`, A_PNG, { upsert: true, contentType: "image/png" });
      assert.ok(error, "an anonymous caller wrote into the logos bucket");
    });

    it("the owner may write into their own listing's garments folder", async () => {
      const key = `${listing.id}/front.png`;
      const { error } = await owner.client.storage.from("garments")
        .upload(key, A_PNG, { upsert: true, contentType: "image/png" });
      assert.ok(!error, `the owner could not upload their own photograph: ${error && error.message}`);
      made.storage.push(["garments", key]);
    });

    it("a non-owner may NOT write into another owner's garments folder", async () => {
      const { error } = await brand.client.storage.from("garments")
        .upload(`${listing.id}/front.png`, A_PNG, { upsert: true, contentType: "image/png" });
      assert.ok(error, "a brand replaced the publisher's photograph");
    });

    it("a bucket is not free hosting: a non-image extension is refused", async () => {
      /* Both buckets are public and sit on a *.supabase.co domain. The size
         and type limits used to live in the browser, which an attacker skips
         by calling the storage API directly. */
      for (const name of ["payload.html", "payload.txt", "payload.js", "payload.png.html", "payload"]) {
        const key = `${brand.id}/${name}`;
        const { error } = await brand.client.storage.from("logos")
          .upload(key, Buffer.from("<html>not an image</html>"), { upsert: true, contentType: "image/png" });
        if (!error) made.storage.push(["logos", key]);
        assert.ok(error, `'${name}' was accepted into the logos bucket`);
      }
    });

    it("a mime type outside the allowlist is refused", async () => {
      const key = `${brand.id}/logo.png`;
      const { error } = await brand.client.storage.from("logos")
        .upload(key, Buffer.from("<html>not an image</html>"), { upsert: true, contentType: "text/html" });
      assert.ok(error, "text/html was stored in a public bucket");
    });

    it("a file over the bucket's size limit is refused", async () => {
      const key = `${brand.id}/logo.png`;
      const tooBig = Buffer.alloc(2 * 1024 * 1024 + 4096, 0x41);   // the logos limit is 2MB
      const { error } = await brand.client.storage.from("logos")
        .upload(key, tooBig, { upsert: true, contentType: "image/png" });
      assert.ok(error, "a file over the bucket's own limit was accepted - the browser check is not the limit");
    });

    it("a brand may remove its own mark, so replacing it is possible", async () => {
      const key = `${brand.id}/replaceable.png`;
      const { error: up } = await brand.client.storage.from("logos")
        .upload(key, A_PNG, { upsert: true, contentType: "image/png" });
      assert.ok(!up, `could not upload: ${up && up.message}`);
      made.storage.push(["logos", key]);

      const { error } = await brand.client.storage.from("logos").remove([key]);
      assert.ok(!error, `a brand could not remove its own mark: ${error && error.message}`);
    });

    it("a non-owner may not delete another owner's photograph", async () => {
      await brand.client.storage.from("garments").remove([`${listing.id}/front.png`]);
      const { data } = await svc.storage.from("garments").list(listing.id);
      assert.ok((data || []).some(f => f.name === "front.png"), "a brand deleted the publisher's photograph");
    });

    it("but anyone may read - the buckets are public on purpose", async () => {
      const { data } = anon.storage.from("garments").getPublicUrl(`${listing.id}/front.png`);
      const res = await fetch(data.publicUrl);
      assert.equal(res.status, 200, "a buyer could not load the garment photograph");
      await res.arrayBuffer();
    });
  });

  /* ==================================================================== */
  describe("realtime", () => {
    it("subscribes on bids", async () => {
      const subscribed = await new Promise(resolve => {
        const timer = setTimeout(() => resolve("TIMED_OUT"), 12_000);
        const channel = anon.channel(`${RUN}bids`)
          .on("postgres_changes", { event: "*", schema: "public", table: "bids" }, () => {})
          .subscribe(status => {
            if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
              clearTimeout(timer);
              anon.removeChannel(channel);
              resolve(status);
            }
          });
      });
      assert.equal(subscribed, "SUBSCRIBED",
        "realtime did not subscribe on bids - live bidding silently falls back to polling");
    });

    it("subscribes on the other three tables the page watches", async () => {
      for (const table of ["spots", "messages", "listings"]) {
        const status = await new Promise(resolve => {
          const timer = setTimeout(() => resolve("TIMED_OUT"), 12_000);
          const channel = anon.channel(`${RUN}${table}`)
            .on("postgres_changes", { event: "*", schema: "public", table }, () => {})
            .subscribe(s => {
              if (s === "SUBSCRIBED" || s === "CHANNEL_ERROR" || s === "TIMED_OUT") {
                clearTimeout(timer); anon.removeChannel(channel); resolve(s);
              }
            });
        });
        assert.equal(status, "SUBSCRIBED", `realtime is not publishing ${table}`);
      }
    });
  });

  /* ==================================================================== */
  describe("cleanup is honest about what it will delete", () => {
    it("only ever deletes ids this run created", () => {
      assert.ok(made.users.length >= 3, "no accounts were registered for cleanup");
      for (const key of made.storage.map(([, k]) => k)) {
        const folder = key.split("/")[0];
        assert.ok(made.users.includes(folder) || folder === listing.id,
          `a storage key outside this run's own folders was registered for deletion: ${key}`);
      }
    });

    it("every row it created carries the run tag", async () => {
      const { data } = await svc.from("listings").select("names").eq("id", listing.id).single();
      assert.match(data.names, TAGGED);
      const { data: s } = await svc.from("spots").select("name").eq("id", spot.id).single();
      assert.match(s.name, TAGGED);
    });
  });
});
