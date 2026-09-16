-- ===========================================================================
-- Which side of the table you are on: chosen once, then frozen.
--
-- Migration 1 froze `role` outright, which is right for email+password - the
-- sign-up form asks, so the answer is known before the row exists. OAuth has
-- no such moment: the user is redirected to Google before they can be asked,
-- so their profile is created with the default and then locked to it forever.
--
-- So the freeze now begins at the first deliberate choice rather than at row
-- creation. The anti-shill property is unchanged: once chosen you cannot flip
-- sides, list a garment and bid it up yourself.
-- ===========================================================================

alter table profiles add column if not exists role_locked boolean not null default false;

comment on column profiles.role_locked is
  'False only between an OAuth sign-up and the moment that user picks a side. Once true, role can never change again.';

-- Anyone who signed up before this migration chose their role on the form.
update profiles set role_locked = true where role_locked = false;

-- --------------------------------------------------------------- sign-up
-- An explicit role in the sign-up metadata is a deliberate choice, so it locks
-- immediately. OAuth sends no metadata, so that user lands unlocked and is
-- asked on arrival.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  wanted text := new.raw_user_meta_data->>'role';
begin
  insert into public.profiles (id, role, display_name, brand, role_locked)
  values (
    new.id,
    case when wanted = 'client' then 'client' else 'brand' end,
    coalesce(
      nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
      nullif(trim(new.raw_user_meta_data->>'full_name'), ''),    -- Google sends this
      nullif(trim(new.raw_user_meta_data->>'name'), ''),
      split_part(new.email, '@', 1)),
    nullif(trim(new.raw_user_meta_data->>'brand'), ''),
    wanted in ('client', 'brand')
  )
  on conflict (id) do nothing;
  return new;
end $$;

-- ----------------------------------------------------------------- freeze
create or replace function public.freeze_profile_role()
returns trigger language plpgsql as $$
begin
  if new.role is distinct from old.role then
    if old.role_locked then
      raise exception 'role cannot be changed once it has been chosen';
    end if;
    -- first deliberate choice: allow it, and close the door behind it
    new.role_locked := true;
  end if;

  -- role_locked is one-way. Nothing may clear it to buy a second choice.
  if old.role_locked and not new.role_locked then
    raise exception 'role_locked cannot be cleared';
  end if;

  return new;
end $$;

drop trigger if exists profiles_role_is_immutable on public.profiles;
create trigger profiles_role_is_immutable
  before update on public.profiles
  for each row execute function public.freeze_profile_role();
