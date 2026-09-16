---
name: mimonim-migrate
description: Change the Supabase Postgres schema behind mimonim.com - add a table, column, RLS policy, trigger or storage rule. Use when asked to alter the database, write or apply a migration, fix a policy, or when npm run verify reports a missing table or a policy that no longer refuses what it should. Covers the push command, the IPv6-only database host, what each existing migration did, and the SQL traps that already broke production here.
---

# Changing the database

Project ref **`zhwathzwrqxzgizanabn`**. `supabase/migrations/` is the source of
truth — never the dashboard, never `apply-all.sql`.

## The rule

**Never edit a migration that has already run.** Add a new one beside it. The
CLI tracks applied migrations by filename; editing one that has run means the
change is never applied and the file no longer describes the database.

## Writing and applying one

Create `supabase/migrations/<UTC timestamp>_short_name.sql`, then:

```powershell
npx supabase db push --db-url "postgresql://postgres:<SUPABASE_DB_PASSWORD>@db.zhwathzwrqxzgizanabn.supabase.co:5432/postgres"
npm run verify
```

`SUPABASE_DB_PASSWORD` is in `.env`. It is **not viewable in the dashboard** —
Supabase shows it once at project creation. If lost: Project Settings →
Database → *Reset password*. Rotating it breaks nothing that is running; only
the CLI uses it.

**The direct database host is IPv6-only.** On a network without IPv6 the push
times out. Use the Supabase pooler host instead (Project Settings → Database →
Connection pooling, session mode).

## What has already been applied

| Migration | What it did |
|---|---|
| `20260916120000_init` | tables, RLS, both storage buckets, realtime publication, new-user trigger |
| `20260916140000_seal_the_market` | made bid ceilings private; moved the settled price onto `spots` |
| `20260916160000_spot_price_defaults_to_floor` | an unbid spot is worth its floor, not `null` |
| `20260916180000_role_chosen_once` | OAuth users pick a side once, then it freezes |
| `20260916190000_fix_role_locked_null` | fixed a `NULL` bug in the above that broke **every** sign-up |

## Invariants a migration must not break

These are the security model, not preferences. `npm run verify` checks each.

- **`bids` has no INSERT, UPDATE or DELETE policy at all.** With RLS on and no
  policy, every browser write is refused. Only the server's service-role key
  writes bids, and only after revalidating the price with `market.js`. Do not
  "helpfully" add a write policy.
- **A bidder's `max_amount` is private** — readable only by that bidder and by
  the listing owner being paid. The page draws from `spots.price`, which the
  server writes. If the browser could read ceilings, proxy bidding is pointless:
  a rival reads your maximum and bids one over.
- **`profiles.role` is frozen once chosen** (`role_locked`). This is what stops
  an account listing a garment and then bidding it up itself.
- **Storage uploads are scoped by folder** to `auth.uid()` or to a listing you
  own, and constrained by extension, mime type and size. Without those, an
  account is free public file hosting on a `*.supabase.co` domain.

## SQL traps that already bit this project

- **`NULL` is not `false`.** `wanted in ('client','brand')` evaluates to `NULL`
  when `wanted` is `NULL`. Writing that into a `NOT NULL` column aborted the
  `auth.users` insert, and **every account creation failed** with "Database
  error creating new user". Wrap membership tests: `coalesce(x in (…), false)`.
- **A missing table refuses writes exactly like RLS does.** An early version of
  `verify-supabase.js` passed against a completely empty database. It now
  distinguishes `PGRST205` (no such table) from `42501` (RLS refused). Keep that
  distinction in anything you add.
- **An `AFTER INSERT` trigger on `auth.users` that raises aborts the sign-up.**
  A `security definer` trigger failing is indistinguishable, from the client,
  from a broken auth service.

## Verifying

`npm run verify` does not just check that tables exist — it checks that the
things which are meant to be impossible really are: anonymous insert into
`bids`, into `listings`, into `spots`, reading a rival's ceiling, changing your
own role. A green run is the model holding, not a comment claiming it does.

`test/integration.supabase.test.js` (45 cases) runs against the live project,
seeds rows tagged with a unique run id, and cleans up in `after()` even when
assertions fail. It skips itself cleanly when no keys are configured.
