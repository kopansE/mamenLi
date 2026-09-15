-- Square Inch on Supabase.
--
-- Why Supabase: the free tier gives Postgres + Auth + Realtime + Storage, and Row
-- Level Security means the browser can talk to the database directly. There is no
-- backend to deploy for the marketplace itself; only Stripe needs a server, and that
-- fits in one Edge Function because it is the only thing holding a secret key.
--
-- Run this in the Supabase SQL editor, then put the project URL and anon key in .env.

-- ---------------------------------------------------------------- people
create table if not exists profiles (
  id          uuid primary key references auth.users on delete cascade,
  role        text not null check (role in ('client','brand')),
  display_name text not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- listings
create table if not exists listings (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references profiles(id) on delete cascade,
  names       text not null,
  garment     text not null default 'gown' check (garment in ('gown','suit')),
  city        text,
  event_date  date,
  venue       text,
  venue_type  text,
  invited     int  not null default 0,
  confirmed   int  not null default 0,
  shooters    text,
  gallery     text,
  livestream  boolean not null default false,
  reach       int  not null default 0,
  hashtag     text,
  press       text,
  floor_rate  numeric(10,2) not null default 12,
  min_area    int  not null default 20,
  closes_at   timestamptz,
  is_open     boolean not null default true,
  photo_url   text,
  created_at  timestamptz not null default now()
);
create index if not exists listings_open_idx on listings (is_open, closes_at);

-- ---------------------------------------------------------------- the market
-- One row per accepted claim. cells is the set of grid indices held, so the
-- bite rule stays exactly as it is in the client.
create table if not exists claims (
  id          uuid primary key default gen_random_uuid(),
  listing_id  uuid not null references listings(id) on delete cascade,
  bidder      uuid not null references profiles(id) on delete cascade,
  brand       text not null,
  cells       int[] not null,
  rate        numeric(10,2) not null,
  committed   numeric(12,2) not null,
  paid        boolean not null default false,
  stripe_session text,
  created_at  timestamptz not null default now()
);
create index if not exists claims_listing_idx on claims (listing_id);

create table if not exists bids (
  id          uuid primary key default gen_random_uuid(),
  listing_id  uuid not null references listings(id) on delete cascade,
  bidder      uuid not null references profiles(id) on delete cascade,
  brand       text not null,
  area        numeric(10,2) not null,
  rate        numeric(10,2) not null,
  amount      numeric(12,2) not null,
  taken_from  text[],
  created_at  timestamptz not null default now()
);
create index if not exists bids_listing_idx on bids (listing_id, created_at desc);

-- ---------------------------------------------------------------- chat
create table if not exists messages (
  id          uuid primary key default gen_random_uuid(),
  listing_id  uuid not null references listings(id) on delete cascade,
  author      uuid not null references profiles(id) on delete cascade,
  display_name text not null,
  role        text not null check (role in ('client','brand')),
  body        text not null check (char_length(body) between 1 and 400),
  created_at  timestamptz not null default now()
);
create index if not exists messages_listing_idx on messages (listing_id, created_at);

-- ---------------------------------------------------------------- photos
-- Create a public bucket called 'garments' in Storage, then:
--   insert: authenticated, and only into a folder named after your own user id
--   select: public, so brands can see what they are bidding on

-- ================================================================ RLS
alter table profiles enable row level security;
alter table listings enable row level security;
alter table claims   enable row level security;
alter table bids     enable row level security;
alter table messages enable row level security;

-- profiles: everyone reads, you write your own
create policy "profiles readable" on profiles for select using (true);
create policy "own profile write" on profiles for insert with check (auth.uid() = id);
create policy "own profile update" on profiles for update using (auth.uid() = id);

-- listings: open ones are public, only the owner edits
create policy "listings readable" on listings for select using (true);
create policy "owner inserts listing" on listings for insert with check (auth.uid() = owner);
create policy "owner edits listing" on listings for update using (auth.uid() = owner);
create policy "owner deletes listing" on listings for delete using (auth.uid() = owner);

-- claims and bids: public to read (the market is meant to be visible),
-- only signed-in brands write, and nobody can edit someone else's
create policy "claims readable" on claims for select using (true);
create policy "brand inserts claim" on claims for insert with check (auth.uid() = bidder);
create policy "bids readable" on bids for select using (true);
create policy "brand inserts bid" on bids for insert with check (auth.uid() = bidder);

-- chat: readable by anyone who can see the listing, written as yourself
create policy "messages readable" on messages for select using (true);
create policy "author inserts message" on messages for insert with check (auth.uid() = author);

-- ================================================================ realtime
-- This is what makes bidding and chat live without polling.
alter publication supabase_realtime add table bids;
alter publication supabase_realtime add table claims;
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table listings;

-- ================================================================ notes
-- Money: never trust the client for an amount. Keep the Stripe call in an Edge
-- Function that recomputes committed = area x rate from the listing's own
-- floor_rate and min_area, exactly as server/index.js does today.
