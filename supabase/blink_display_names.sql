-- Auto display names: a fan who signs up without choosing a display name is given
-- a clean, anonymous "blinkN" (blink1, blink2, …) instead of showing their raw
-- Last.fm handle or OAuth real name.
--
-- The number MUST be unique: the leaderboard keys rows by lowercased display name,
-- so two people sharing a "blinkN" would collide on one key and one row would
-- overwrite the other. A sequence makes the numbering atomic (no two concurrent
-- signups can ever get the same number), and the function also skips any number
-- already taken by an existing profile — so it's collision-proof even against a
-- manually-chosen name. (The client additionally reserves the ^blink\d+$ namespace
-- so nobody can grab one by hand going forward.)
--
-- Apply once in the Supabase SQL editor.

create sequence if not exists public.blink_number_seq;

create or replace function public.assign_blink_name()
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_name text;
  v_guard int := 0;
  v_created timestamptz;
begin
  -- Server-side new-account guard: ONLY a brand-new signup may be auto-named. An
  -- established fan who never chose a display name keeps their handle. This is the
  -- authoritative check — a stale/cached client (running the old "assign on every
  -- sign-in" code) still gets NULL here and so never overwrites an existing name.
  select created_at into v_created from auth.users where id = auth.uid();
  if v_created is null or v_created < now() - interval '15 minutes' then
    return null;
  end if;

  loop
    v_name := 'blink' || nextval('public.blink_number_seq');
    -- Skip a number already used as someone's display name (manual or prior auto).
    exit when not exists (
      select 1 from auth.users
      where lower(raw_user_meta_data->>'display_name') = lower(v_name)
    );
    v_guard := v_guard + 1;
    if v_guard > 10000 then
      raise exception 'assign_blink_name: could not find a free number';
    end if;
  end loop;
  return v_name;
end
$$;

-- Callable by any signed-in user assigning their own name at sign-up. The function
-- is SECURITY DEFINER, so it can read auth.users and advance the sequence without
-- the caller holding direct privileges on either.
grant execute on function public.assign_blink_name() to authenticated;
