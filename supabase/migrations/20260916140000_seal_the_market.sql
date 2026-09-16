-- ===========================================================================
-- Seal the market.
--
-- The first migration left `bids` world-readable, which quietly broke the
-- promise the product is built on. `bids.max_amount` is a brand's secret
-- ceiling; with `using (true)` anyone holding the anon key - which the page
-- publishes, by design - could read every rival's maximum and bid one unit
-- over it. Proxy bidding only works if the ceiling is private.
--
-- The page still needs a price to draw, so the settled figures move onto
-- `spots`, written by the server after each bid. The browser reads those and
-- never needs anyone's maximum again.
-- ===========================================================================

-- ------------------------------------------------ what the page may know
alter table spots add column if not exists price        numeric(12,2);
alter table spots add column if not exists holder       uuid references profiles(id) on delete set null;
alter table spots add column if not exists holder_brand text;
alter table spots add column if not exists holder_logo  text;
alter table spots add column if not exists bid_count    int not null default 0;

comment on column spots.price is
  'The settled price, written by the server after every bid. Public. Never derived in the browser.';
comment on column spots.holder is
  'Who currently holds the spot. The amount they were willing to pay is not public.';

-- Back-fill so a spot with no bids reads as its floor rather than as null.
update spots set price = floor where price is null;

-- --------------------------------------------------------- bids, sealed
drop policy if exists "bids readable"     on bids;
drop policy if exists "own bids readable" on bids;

-- You see your own bids. A publisher sees the bids on their own garment,
-- because they are the one being paid. Nobody else sees anything: no
-- maximums, no Stripe identifiers, no bidder ids.
create policy "own bids readable" on bids for select using (
  auth.uid() = bidder
  or exists (select 1 from listings l where l.id = bids.listing_id and l.owner = auth.uid())
);

-- Still no insert/update/delete policy anywhere. With RLS on and no policy,
-- every write from a browser is refused; only the service role writes bids.

-- One live authorisation per bidder per spot. Raising your own maximum is
-- allowed, but the older row must be released first - two `held` rows for one
-- bidder meant settlement captured both and charged them twice.
create unique index if not exists bids_one_hold_per_bidder_per_spot
  on bids (spot_id, bidder) where status = 'held' and withdrawn = false;

-- ------------------------------------------------------ messages, honest
-- `display_name` and `role` were free text from the client, so a brand could
-- insert {display_name:'Maya', role:'client'} and impersonate the publisher.
-- They must now match the profile of whoever is writing.
drop policy if exists "author inserts message" on messages;
create policy "author inserts message" on messages for insert with check (
  auth.uid() = author
  and role = (select p.role from profiles p where p.id = auth.uid())
  and display_name = (select coalesce(p.brand, p.display_name) from profiles p where p.id = auth.uid())
);

-- ------------------------------------------------- listings, role-gated
-- Only a publisher account may open a listing. Without this the client/brand
-- split lived only in the UI, and any signed-in user could create listings
-- straight through PostgREST.
drop policy if exists "owner inserts listing" on listings;
create policy "owner inserts listing" on listings for insert with check (
  auth.uid() = owner
  and exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'client')
);

-- ---------------------------------------------------- storage, bounded
-- The upload policies checked the folder but not the contents, and the size
-- and type limits lived in the browser - which an attacker simply skips by
-- calling the storage API directly. Both buckets are public, so without this
-- an account is free hosting for anything at all on a *.supabase.co domain.
update storage.buckets
   set file_size_limit = 8388608,
       allowed_mime_types = array['image/jpeg','image/png','image/webp']
 where id = 'garments';

update storage.buckets
   set file_size_limit = 2097152,
       allowed_mime_types = array['image/jpeg','image/png','image/webp','image/svg+xml']
 where id = 'logos';

-- Tighten the filename too, so nothing that is not an image can be stored
-- even if a mime type is spoofed.
drop policy if exists "owner uploads garment" on storage.objects;
create policy "owner uploads garment" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'garments'
    and storage.extension(name) = any (array['jpg','jpeg','png','webp'])
    and exists (
      select 1 from listings l
      where l.owner = auth.uid() and l.id::text = (storage.foldername(name))[1])
  );

drop policy if exists "own logo write" on storage.objects;
create policy "own logo write" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'logos'
    and storage.extension(name) = any (array['jpg','jpeg','png','webp','svg'])
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- A brand replacing its own mark needs to be able to remove the old object.
drop policy if exists "own logo delete" on storage.objects;
create policy "own logo delete" on storage.objects for delete to authenticated
  using (bucket_id = 'logos' and auth.uid()::text = (storage.foldername(name))[1]);

-- --------------------------------------------------------------- realtime
-- The page now watches spots for price changes rather than watching bids,
-- which it can no longer read.
do $$
begin
  alter publication supabase_realtime add table spots;
exception when duplicate_object then null; end $$;
