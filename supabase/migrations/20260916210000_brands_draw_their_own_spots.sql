-- ===========================================================================
-- The brand draws the spot, and the area sets the price.
--
-- Until now the publisher drew the numbered rectangles and put a floor under
-- each one, and a brand could only bid on what it was offered. That got the
-- market backwards. The publisher has no idea which twelve square inches a
-- brand wants, and every listing opened with a guess that a brand then had to
-- live with - or walk away from.
--
-- So the drawing moves to the other side of the table. A brand drags out the
-- rectangle it wants, anywhere on the front or the back photograph, and the
-- floor under it follows from how much of the photograph it covers:
--
--     areaPercent = w * h / 100          -- w and h are each a % of the photo
--     sideFactor  = front ? front_multiplier : 1
--     floor       = ceil(areaPercent * rate_per_percent * sideFactor)
--
-- A 27% x 10% box on the front of a default listing is 2.7% of the image, so
-- 2.7 x 250 x 1.6 = 1080. The arithmetic itself lives in
-- public/assets/js/market.js, which the browser and the server both load, so
-- the price the page quotes while the finger is still moving is the price the
-- server arrives at on its own. These two columns are the only inputs the
-- publisher controls.
-- ===========================================================================

-- --------------------------------------------------- what a percent costs
-- The publisher's whole price list is now two numbers. Every listing that
-- predates this migration gets the defaults, which is what its spots were
-- already roughly priced at by hand.
alter table listings add column if not exists rate_per_percent numeric(10,2) not null default 250;
alter table listings add column if not exists front_multiplier numeric(4,2)  not null default 1.6;

-- Postgres has no `add constraint if not exists`, so add it and forgive the
-- second run, the way this schema already adds a table to the realtime
-- publication twice.
do $$
begin
  alter table listings add constraint listings_rate_per_percent_check check (rate_per_percent >= 0);
exception when duplicate_object then null; end $$;

-- Strictly positive, not just non-negative: a zero multiplier would price the
-- entire front of a garment - the side the camera is pointed at all evening -
-- at nothing at all, and it would do it silently.
do $$
begin
  alter table listings add constraint listings_front_multiplier_check check (front_multiplier > 0);
exception when duplicate_object then null; end $$;

comment on column listings.rate_per_percent is
  'What one percent of the photograph costs. A drawn box is priced at area x this, so the publisher sets a rate rather than a price per spot.';
comment on column listings.front_multiplier is
  'The front is worth more than the back, because that is where the cameras are. Multiplies the rate for a box drawn on the front only.';

-- ------------------------------------------------------- who drew the box
-- Null for every spot that predates this migration: those were drawn by the
-- publisher themselves, and there is no brand to name.
alter table spots add column if not exists proposed_by uuid references profiles(id) on delete set null;

-- `on delete set null` rather than the default, which is `no action`: profiles
-- cascade from auth.users, so an account deletion would otherwise be refused
-- by a rectangle that account once drew on a stranger's dress. The spot has to
-- outlive the brand - somebody may still be holding it.

comment on column spots.proposed_by is
  'The brand that drew this rectangle. Null for spots laid out by the publisher before brands drew their own.';

-- ------------------------------------------------------- approved by whom
-- The default reads backwards until you know what it is for. Every spot that
-- ALREADY EXISTS was drawn by the publisher on their own garment, so every one
-- of them is approved by definition - there is nobody left to ask. A default
-- of false would silently un-approve the entire live market at the moment this
-- migration ran, and take every spot off every page.
--
-- A brand-drawn spot is a different thing: it is a request to print on
-- somebody's wedding clothes, and it is written with `approved = false`
-- explicitly by the server. So the default is true because of the rows that
-- are already here, and the interesting value is passed in by the only writer
-- that is allowed to create these at all.
alter table spots add column if not exists approved boolean not null default true;

comment on column spots.approved is
  'False while a brand-drawn rectangle is waiting on the publisher. True for everything the publisher drew themselves, which is why the column defaults to true.';

-- ===========================================================================
-- Row Level Security: deliberately unchanged on the insert side.
--
-- There is NO insert policy for brands on `spots`, and there must not be one.
-- A drawn box decides a price, so it is exactly the kind of write `bids` is
-- already sealed against: the server creates these rows with the service-role
-- key after it has re-read the listing, re-read that side's spots, and
-- re-validated the rectangle with the shared engine. A brand holding the anon
-- key - which the page publishes, by design - could otherwise insert a spot
-- with a floor of 1 over the best position on the garment.
--
-- The update side needs nothing either. "owner edits spots" from the first
-- migration is a table-wide `for update` scoped to the owner of the parent
-- listing, with no column list, so it already covers setting `approved` - a
-- publisher can accept or decline a brand's rectangle through PostgREST with
-- no server involvement. Nothing is added here on purpose; a second, narrower
-- policy would only be another way in.
-- ===========================================================================

-- The publisher's queue is "what is waiting on me", which is a scan of one
-- listing's unapproved rows. The existing (listing_id, side, n) index does not
-- answer that, and this page is loaded on every visit to the studio.
create index if not exists spots_pending_idx on spots (listing_id, approved);
