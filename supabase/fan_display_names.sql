-- Auto display names that match the fandom the person says they are.
--
-- blink_display_names.sql gave every new signup a "blinkN" name. That was right
-- while everyone here was a BLINK. A vote trade brings other fandoms to the same
-- sign-up form — a BLOOM, someone from Pauljjak — and naming them "blink41" is
-- wrong in the one place it is most visible: the collab board, which exists to
-- show each fandom turning up.
--
-- So the prefix follows the fandom: bloom1, bloom2, pauljjak1, … and blink keeps
-- its own unbroken numbering.
--
-- Three entry points, deliberately separate because they answer different
-- questions:
--
--   assign_fan_name(fandom)   — a BRAND-NEW signup. Carries the same 15-minute
--                               guard as before: an established fan who never
--                               chose a name keeps their handle.
--   reissue_fan_name(fandom)  — someone already named who now says which fandom
--                               they are. Only ever replaces an AUTO name, never
--                               one a person chose for themselves.
--   mint_fan_name(prefix)     — the counter itself, for the server (service_role)
--                               when the answer arrives through the extension and
--                               there is no browser session to speak for.
--
-- Apply once in the Supabase SQL editor. Safe to re-run.

-- One row per prefix rather than one sequence per fandom: a new fandom joining a
-- trade must not need a migration. `on conflict do update … returning` is just as
-- atomic as nextval, so two concurrent signups still cannot land on one number.
create table if not exists public.fan_name_counters (
  prefix text primary key,
  n bigint not null default 0
);

-- Nobody reaches this table directly; the functions below are security definer.
--
-- no grants on fan_name_counters: nothing outside Postgres may touch it. The
-- three functions below are security definer, so they reach it on their own
-- authority, and anybody able to reach it through the Data API could advance a
-- counter — minting display names at will and skipping the new-signup guard
-- that is the whole point of assign_fan_name. Supabase stopped auto-granting
-- Data API access to new public tables on 2026-10-30, which for this one table
-- is the behaviour we wanted anyway. RLS is on with no policies as the second
-- lock.
alter table public.fan_name_counters enable row level security;

-- Enforced, not just stated. This table was created while Supabase was still
-- auto-granting, so the platform handed anon and authenticated privileges on it
-- the moment it existed — references, trigger and truncate, though not select.
-- No Data API verb reaches any of those three, so nothing was exposed, but the
-- file said "nobody" and the database said otherwise. Revoking is a no-op where
-- the privilege was never granted, which is the case on any project created
-- after 2026-10-30.
revoke all on public.fan_name_counters from anon, authenticated;

-- ── the counter ─────────────────────────────────────────────────────────────
-- Returns a free "<prefix><n>", skipping any number already held as a display
-- name (auto or hand-picked). No caller check: the grants below decide who may
-- ask, and both wrappers check first.
create or replace function public.mint_fan_name(p_prefix text)
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_prefix text;
  v_name text;
  v_n bigint;
  v_guard int := 0;
begin
  v_prefix := lower(coalesce(nullif(trim(p_prefix), ''), 'blink'));
  -- A prefix becomes the start of a display name, so it is bounded to the same
  -- shape the collab board validates a fandom key against. Anything else falls
  -- back to blink rather than failing a signup over a label.
  if v_prefix !~ '^[a-z][a-z0-9]{1,20}$' then
    v_prefix := 'blink';
  end if;

  loop
    if v_prefix = 'blink' then
      -- The original sequence, so blink numbering continues where it left off
      -- instead of restarting at 1 beside names that already exist.
      v_n := nextval('public.blink_number_seq');
    else
      insert into public.fan_name_counters as c (prefix, n) values (v_prefix, 1)
        on conflict (prefix) do update set n = c.n + 1
        returning c.n into v_n;
    end if;
    v_name := v_prefix || v_n;
    exit when not exists (
      select 1 from auth.users
      where lower(raw_user_meta_data->>'display_name') = lower(v_name)
    );
    v_guard := v_guard + 1;
    if v_guard > 10000 then
      raise exception 'mint_fan_name: could not find a free number for %', v_prefix;
    end if;
  end loop;
  return v_name;
end
$$;

revoke all on function public.mint_fan_name(text) from public;
-- The server only. It names someone whose answer arrived through the extension,
-- where there is no browser session for auth.uid() to read.
grant execute on function public.mint_fan_name(text) to service_role;

-- ── a brand-new signup ──────────────────────────────────────────────────────
create or replace function public.assign_fan_name(p_fandom text default 'blink')
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_created timestamptz;
begin
  -- Unchanged from assign_blink_name: ONLY a brand-new signup may be auto-named.
  -- This is the authoritative check — a stale client running the old "assign on
  -- every sign-in" code still gets NULL here.
  select created_at into v_created from auth.users where id = auth.uid();
  if v_created is null or v_created < now() - interval '15 minutes' then
    return null;
  end if;
  return public.mint_fan_name(p_fandom);
end
$$;

grant execute on function public.assign_fan_name(text) to authenticated;

-- ── someone who says which fandom they are after the fact ───────────────────
-- The answer usually arrives later than the account: the fandom question is in
-- the counter, and the counter is installed after signing up. Renaming then is
-- only safe for a name nobody chose.
create or replace function public.reissue_fan_name(p_fandom text)
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_md jsonb;
  v_name text;
  v_prefix text;
begin
  select raw_user_meta_data into v_md from auth.users where id = auth.uid();
  if v_md is null then
    return null;
  end if;
  v_name := trim(coalesce(v_md->>'display_name', ''));
  if v_name = '' then
    return null;
  end if;
  -- Auto-named is a FLAG the client writes with the name, not a guess from its
  -- shape: "bloom12" is a plausible thing for a person to pick by hand, and
  -- replacing a name somebody chose would be the one unforgivable version of
  -- this feature. The ^blink\d+$ fallback covers the accounts named before the
  -- flag existed — that namespace was never choosable, so it is auto by
  -- construction.
  if coalesce(v_md->>'display_name_auto', '') <> 'true'
     and v_name !~* '^blink[0-9]+$' then
    return null;
  end if;
  v_prefix := lower(coalesce(nullif(trim(p_fandom), ''), 'blink'));
  if v_prefix !~ '^[a-z][a-z0-9]{1,20}$' then
    return null;
  end if;
  -- Already right: say so by returning the name unchanged rather than burning a
  -- number every time the site loads.
  if v_name ~* ('^' || v_prefix || '[0-9]+$') then
    return v_name;
  end if;
  return public.mint_fan_name(v_prefix);
end
$$;

grant execute on function public.reissue_fan_name(text) to authenticated;

-- ── the original name, kept working ─────────────────────────────────────────
-- A browser holding a cached copy of the old page still calls this. It must keep
-- naming people rather than erroring, so it is now a wrapper.
create or replace function public.assign_blink_name()
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  return public.assign_fan_name('blink');
end
$$;

grant execute on function public.assign_blink_name() to authenticated;
