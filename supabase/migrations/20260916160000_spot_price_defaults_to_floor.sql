-- ===========================================================================
-- A spot's price is never null.
--
-- `spots.price` carries the settled price the page draws from, and the server
-- writes it after every bid. Until the first bid there has been no write, so a
-- spot created after migration 2 sat at null. The front end coped - it falls
-- back to the floor - but anything reading the column directly saw a null, and
-- "the price is null until someone bids" is a rule nobody should have to know.
--
-- An unbid spot is worth its floor. Say so in the database.
-- ===========================================================================

create or replace function public.spot_price_defaults_to_floor()
returns trigger language plpgsql as $$
begin
  if new.price is null then
    new.price := new.floor;
  end if;
  -- Raising the floor above the standing price on an unsold spot should move
  -- the price with it; once somebody holds it, the floor no longer decides.
  if tg_op = 'UPDATE' and new.holder is null and new.floor is distinct from old.floor then
    new.price := new.floor;
  end if;
  return new;
end $$;

drop trigger if exists spots_price_floor on public.spots;
create trigger spots_price_floor
  before insert or update on public.spots
  for each row execute function public.spot_price_defaults_to_floor();

-- Anything already in the table.
update public.spots set price = floor where price is null;
