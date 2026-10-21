-- Runs blink_display_names.sql + fan_display_names.sql against a throwaway
-- Postgres and checks what they actually do.
--
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/fan_display_names_test.sql
--
-- (test-sql.yml runs this in CI on a postgres:16 service; locally it needs an
-- empty database and nothing else.)
--
-- These functions are applied by hand in the Supabase SQL editor, which means
-- nothing else in this repo would ever have told us they were wrong. The two
-- failures worth the most here are silent: a name minted twice (two people
-- collide on one leaderboard key, one row overwrites the other), and a reissue
-- replacing a name somebody CHOSE for themselves.
--
-- Enough of Supabase is stubbed to run the real files unmodified: the auth
-- schema, auth.users, auth.uid(), and the two roles the grants name.

\set ON_ERROR_STOP on
\set QUIET on

create schema if not exists auth;

create table auth.users (
  id uuid primary key,
  created_at timestamptz not null default now(),
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

-- Supabase derives this from the request JWT. Here it is whatever the test says,
-- so one session can act as several people.
create or replace function auth.uid() returns uuid
language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

-- All three Data API roles, because the migration now revokes from anon as
-- well as granting to the other two — and a revoke names a role that has to
-- exist. Supabase projects have all three.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I', r);
    end if;
  end loop;
end $$;

\i supabase/blink_display_names.sql
\i supabase/fan_display_names.sql

-- ── helpers ─────────────────────────────────────────────────────────────────
create or replace function test_signup(p_id uuid, p_age interval default '0 seconds',
                                       p_name text default null, p_auto boolean default null)
returns void language plpgsql as $$
declare v_md jsonb := '{}'::jsonb;
begin
  if p_name is not null then v_md := jsonb_build_object('display_name', p_name); end if;
  if p_auto is not null then v_md := v_md || jsonb_build_object('display_name_auto', p_auto); end if;
  insert into auth.users (id, created_at, raw_user_meta_data)
  values (p_id, now() - p_age, v_md);
end $$;

create or replace function test_be(p_id uuid) returns void language sql as $$
  select set_config('test.uid', p_id::text, false); $$;

-- Writing the name back is the client's job in production (updateUser). Here it
-- is a helper, because the next assertion depends on it having happened.
create or replace function test_save(p_id uuid, p_name text) returns void language sql as $$
  update auth.users
     set raw_user_meta_data = raw_user_meta_data
         || jsonb_build_object('display_name', p_name, 'display_name_auto', true)
   where id = p_id; $$;

create or replace function ck(p_ok boolean, p_what text, p_detail text default null)
returns void language plpgsql as $$
begin
  if p_ok then
    raise notice '  ok   %', p_what || coalesce(' (' || p_detail || ')', '');
  else
    raise exception '  FAIL %', p_what || coalesce(' (' || p_detail || ')', '');
  end if;
end $$;

\set QUIET off
\echo '--- a brand-new signup is named for the fandom it says it is'
do $$
declare a uuid := gen_random_uuid(); b uuid := gen_random_uuid();
        c uuid := gen_random_uuid(); n1 text; n2 text; n3 text;
begin
  perform test_signup(a); perform test_be(a);
  n1 := public.assign_fan_name('bloom');
  perform ck(n1 = 'bloom1', 'a BLOOM is a bloom, not a blink', n1);
  perform test_save(a, n1);

  perform test_signup(b); perform test_be(b);
  n2 := public.assign_fan_name('pauljjak');
  perform ck(n2 = 'pauljjak1', 'and the second fandom gets its own numbering', n2);
  perform test_save(b, n2);

  perform test_signup(c); perform test_be(c);
  n3 := public.assign_fan_name('bloom');
  perform ck(n3 = 'bloom2', 'the next BLOOM is the next number', n3);
  perform ck(n1 <> n3, 'and never the same name twice');
end $$;

\echo '--- blink numbering continues where it was, and is still the default'
do $$
declare a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); n text; m text;
begin
  -- blink7 exists already, as it would in production.
  perform test_signup(gen_random_uuid(), '400 days', 'blink7', true);
  perform setval('public.blink_number_seq', 7);
  perform test_signup(a); perform test_be(a);
  n := public.assign_fan_name('blink');
  perform ck(n = 'blink8', 'a BLINK carries on from the existing sequence', n);

  perform test_signup(b); perform test_be(b);
  m := public.assign_fan_name();
  perform ck(m = 'blink9', 'and no answer at all still means blink', m);
end $$;

\echo '--- a number already taken by hand is skipped, not collided with'
do $$
declare a uuid := gen_random_uuid(); n text;
begin
  -- Somebody picked "bloom3" by hand before the namespace was reserved.
  perform test_signup(gen_random_uuid(), '400 days', 'BLOOM3', false);
  perform test_signup(a); perform test_be(a);
  n := public.assign_fan_name('bloom');
  perform ck(n = 'bloom4', 'the taken number is stepped over, case-insensitively', n);
end $$;

\echo '--- an established fan is never auto-named'
do $$
declare a uuid := gen_random_uuid(); n text;
begin
  perform test_signup(a, '3 days'); perform test_be(a);
  n := public.assign_fan_name('bloom');
  perform ck(n is null, 'an account older than the signup window gets nothing', coalesce(n, 'null'));
end $$;

\echo '--- the old function still works for a browser holding a cached page'
do $$
declare a uuid := gen_random_uuid(); n text;
begin
  perform test_signup(a); perform test_be(a);
  n := public.assign_blink_name();
  perform ck(n ~ '^blink[0-9]+$', 'assign_blink_name() still names a blink', n);
end $$;

\echo '--- saying which fandom you are AFTER signing up'
do $$
declare a uuid := gen_random_uuid(); b uuid := gen_random_uuid();
        c uuid := gen_random_uuid(); d uuid := gen_random_uuid(); n text;
begin
  -- The realistic case: named at signup, installs the counter days later, and
  -- only then is asked which fandom they are.
  perform test_signup(a, '9 days', 'blink40', true); perform test_be(a);
  n := public.reissue_fan_name('bloom');
  perform ck(n ~ '^bloom[0-9]+$', 'an auto name follows the answer', n);

  -- The one that must never happen.
  perform test_signup(b, '9 days', 'ROSÉ4ever', false); perform test_be(b);
  n := public.reissue_fan_name('bloom');
  perform ck(n is null, 'a name they chose themselves is left alone', coalesce(n, 'null'));

  -- Named before the flag existed. That namespace was never choosable, so it is
  -- auto by construction.
  perform test_signup(c, '400 days', 'blink12'); perform test_be(c);
  n := public.reissue_fan_name('bloom');
  perform ck(n ~ '^bloom[0-9]+$', 'a legacy blinkN is auto even without the flag', n);

  -- Idempotent: the site asks on every load, and each ask must not burn a number.
  perform test_signup(d, '9 days', 'bloom99', true); perform test_be(d);
  n := public.reissue_fan_name('bloom');
  perform ck(n = 'bloom99', 'an answer that already matches returns the same name', n);
  n := public.reissue_fan_name('bloom');
  perform ck(n = 'bloom99', 'and asking again still does not rename them', n);
end $$;

\echo '--- a junk prefix cannot become a display name'
do $$
declare a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); n text;
begin
  perform test_signup(a); perform test_be(a);
  n := public.assign_fan_name('Robert''); drop table auth.users;--');
  perform ck(n ~ '^blink[0-9]+$', 'a nonsense fandom falls back to blink rather than failing a signup', n);

  perform test_signup(b, '9 days', 'blink77', true); perform test_be(b);
  n := public.reissue_fan_name('../../etc');
  perform ck(n is null, 'and a rename on a nonsense fandom is refused outright', coalesce(n, 'null'));
end $$;

\echo '--- the counter is atomic under concurrency'
-- Not a race in one session, but it proves the increment reads and writes in one
-- statement: 200 mints with no gaps and no repeats.
do $$
declare i int; n text; seen text[] := '{}';
begin
  for i in 1..200 loop
    n := public.mint_fan_name('bloom');
    if n = any(seen) then raise exception 'mint_fan_name repeated %', n; end if;
    seen := seen || n;
  end loop;
  perform ck(array_length(seen, 1) = 200, '200 mints, 200 distinct names');
end $$;

\echo ''
\echo 'All checks passed.'
