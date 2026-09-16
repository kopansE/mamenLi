-- ===========================================================================
-- Fix: sign-up was failing outright.
--
-- The previous migration computed role_locked as `wanted in ('client','brand')`.
-- When `wanted` is NULL - which is every OAuth arrival, and the exact case that
-- migration was written for - SQL's three-valued logic makes that expression
-- NULL rather than false. role_locked is NOT NULL, so the insert raised, the
-- AFTER trigger on auth.users aborted, and every new account failed with
-- "Database error creating new user".
--
-- NULL is not false. Say which one you mean.
-- ===========================================================================

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
    coalesce(wanted in ('client', 'brand'), false)
  )
  on conflict (id) do nothing;
  return new;
end $$;
