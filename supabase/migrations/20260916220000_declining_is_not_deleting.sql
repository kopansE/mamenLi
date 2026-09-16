-- ===========================================================================
-- Declining a sponsor must release their money, not destroy the record of it.
--
-- The studio's decline button deleted the spot outright. `bids.spot_id` is
-- `on delete cascade`, so that delete took every bid on the rectangle with it
-- - and `stripe_payment_intent` lives on the bid row. The hold on the
-- sponsor's card then could not be cancelled by anyone, ever, because nothing
-- was left that knew its id. The page said "Declined. Their card is released."
-- while the authorisation sat on their statement until Stripe expired it a
-- week later.
--
-- So a decline is a state, not a deletion. The row stays, the server cancels
-- the intents, and both sides keep a record of what was asked and answered.
-- ===========================================================================

alter table spots add column if not exists declined boolean not null default false;
alter table spots add column if not exists declined_at timestamptz;

comment on column spots.declined is
  'The wearer said no to this rectangle. The row is kept rather than deleted so the authorisations behind it can still be cancelled and both sides keep the record.';

-- A declined rectangle stops blocking the fabric it sits on: somebody else may
-- draw there. The overlap check reads live spots only, so this index is what
-- keeps that lookup from scanning every rectangle ever refused on the garment.
create index if not exists spots_live_idx on spots (listing_id, side) where not declined;

-- ---------------------------------------------------------------------------
-- RLS is deliberately untouched again. "owner edits spots" from the first
-- migration is a table-wide `for update` scoped to the parent listing's owner
-- with no column list, so a wearer can already set `declined` through
-- PostgREST. But the browser must NOT be the thing that declines: cancelling
-- the Stripe authorisation needs the secret key, so the studio calls
-- POST /api/decline/:spotId and the server writes this column after the money
-- is actually released. A wearer who sets the column directly only hides the
-- rectangle from her own page; the guard that matters is that nothing is ever
-- captured for a spot that is not approved, which settlement now enforces.
-- ---------------------------------------------------------------------------
