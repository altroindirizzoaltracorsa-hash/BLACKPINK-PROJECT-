-- Read-only verification that fan_display_names.sql is really applied, and
-- applied the way it was meant to be.
--
--   Apply SQL  (apply-sql.yml)
--     file: supabase/checks/verify_fan_display_names.sql
--
-- Nothing here writes, and nothing here MINTS: calling mint_fan_name would burn
-- a number and push the first real BLOOM to bloom2. The two wrappers are called
-- instead, with no session — auth.uid() is null, so each takes its refusal path
-- and returns null. That is deliberately the useful call: PL/pgSQL compiles a
-- function's queries on first execution, so a successful null here proves the
-- bodies actually compile against the live auth schema (auth.users,
-- raw_user_meta_data), which is the one thing a local test with a stubbed auth
-- schema cannot prove.
--
-- The grant on mint_fan_name is a SECURITY property, not a detail: it takes a
-- prefix and skips the new-signup guard, so a signed-in person able to call it
-- could rename themselves at will and burn numbers. It must be the server's
-- alone.

\set ON_ERROR_STOP on

do $$
declare
  v_missing text[] := '{}';
  v_name text;
  v_fn text;
begin
  -- Every function the site and the server call by name.
  foreach v_fn in array array['mint_fan_name', 'assign_fan_name', 'reissue_fan_name', 'assign_blink_name']
  loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_fn
    ) then
      v_missing := v_missing || v_fn;
    end if;
  end loop;
  if array_length(v_missing, 1) > 0 then
    raise exception 'NOT APPLIED — missing: %', array_to_string(v_missing, ', ');
  end if;
  raise notice 'ok   all four functions exist';

  if not exists (select 1 from pg_class where relname = 'fan_name_counters' and relkind = 'r') then
    raise exception 'NOT APPLIED — fan_name_counters is missing';
  end if;
  raise notice 'ok   the per-prefix counter table exists';

  -- Who may call what.
  if not has_function_privilege('authenticated', 'public.assign_fan_name(text)', 'execute') then
    raise exception 'a signup cannot name itself — authenticated lacks execute on assign_fan_name';
  end if;
  if not has_function_privilege('authenticated', 'public.reissue_fan_name(text)', 'execute') then
    raise exception 'a later answer cannot rename — authenticated lacks execute on reissue_fan_name';
  end if;
  if not has_function_privilege('authenticated', 'public.assign_blink_name()', 'execute') then
    raise exception 'a cached page cannot name anybody — authenticated lacks execute on assign_blink_name';
  end if;
  raise notice 'ok   the browser can call the two it is meant to, and the old one still works';

  if has_function_privilege('authenticated', 'public.mint_fan_name(text)', 'execute') then
    raise exception 'mint_fan_name is callable by a signed-in user — it skips the new-signup guard';
  end if;
  if not has_function_privilege('service_role', 'public.mint_fan_name(text)', 'execute') then
    raise exception 'the server cannot mint — service_role lacks execute on mint_fan_name';
  end if;
  raise notice 'ok   the counter itself is the server''s alone';

  -- Bodies compile and run against the real auth schema. No session, so both
  -- refuse and nothing is minted.
  v_name := public.assign_fan_name('bloom');
  if v_name is not null then
    raise exception 'assign_fan_name named somebody with no session: %', v_name;
  end if;
  v_name := public.reissue_fan_name('bloom');
  if v_name is not null then
    raise exception 'reissue_fan_name renamed somebody with no session: %', v_name;
  end if;
  raise notice 'ok   both run against the live auth schema, and refuse without a session';
end $$;

-- What the counters stand at. Empty on a fresh apply; one row per fandom that
-- has named somebody. blink is not here on purpose — it keeps the original
-- sequence so its numbering continues unbroken.
select prefix, n from public.fan_name_counters order by prefix;
select last_value as blink_sequence_at from public.blink_number_seq;

-- Who is named what, in shape only — no names printed. This is the number the
-- feature exists to move: auto-named accounts whose prefix says "blink" while
-- they have told us they are something else should fall to zero as people vote.
select coalesce(raw_user_meta_data->>'fandom', '(unsaid)') as says_they_are,
       case
         when coalesce(raw_user_meta_data->>'display_name', '') = '' then 'no name'
         when raw_user_meta_data->>'display_name_auto' = 'true'
           or raw_user_meta_data->>'display_name' ~* '^blink[0-9]+$' then 'auto'
         else 'chose their own'
       end as name_kind,
       count(*)
from auth.users
group by 1, 2
order by 1, 2;
