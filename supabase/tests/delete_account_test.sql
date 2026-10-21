-- What delete_account() does, against a real Postgres.
--
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/delete_account_test.sql
--
-- A function that deletes accounts is worth more than a careful read. The two
-- failures that matter are both quiet: taking somebody ELSE down with the
-- caller, and leaving a deleted person's name on a public board after telling
-- them it would no longer be linked to any account.
--
-- Enough of Supabase is stubbed to run the real file unmodified.

\set ON_ERROR_STOP on
\set QUIET on

create schema if not exists auth;
create table auth.users (
  id uuid primary key,
  created_at timestamptz not null default now(),
  raw_user_meta_data jsonb not null default '{}'::jsonb
);
create or replace function auth.uid() returns uuid
language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I', r);
    end if;
  end loop;
end $$;

-- The tables the function touches, in the shapes that matter to it.
create table public.collab_user_votes (
  collab_id text, app_user_id uuid, day date, votes int, display_name text
);
create table public.kca_user_votes (app_user_id uuid, day date, votes int, display_name text);
create table public.linked_accounts (id uuid default gen_random_uuid(), app_user_id uuid, source text);
create table public.scrobble_tokens (token text, app_user_id uuid);
-- vma_user_votes and breaktudo_user_votes are deliberately NOT created: the
-- function has to cope with a table that is not there.

\i supabase/delete_account.sql

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
\echo '--- a person deletes their own account'
do $$
declare
  me    uuid := '11111111-1111-1111-1111-111111111111';
  other uuid := '22222222-2222-2222-2222-222222222222';
begin
  insert into auth.users (id) values (me), (other);
  insert into public.collab_user_votes values
    ('bvp-kca-2026', me, current_date, 4, 'TESTBLOOM'),
    ('bvp-kca-2026', other, current_date, 40, 'rllyanav');
  insert into public.kca_user_votes values (me, current_date, 3, 'TESTBLOOM');
  insert into public.linked_accounts (app_user_id, source) values (me, 'lastfm'), (other, 'lastfm');
  insert into public.scrobble_tokens values ('tok-me', me), ('tok-other', other);

  perform set_config('test.uid', me::text, false);
  perform public.delete_account();

  perform ck(not exists (select 1 from auth.users where id = me), 'the account is gone');
  perform ck(exists (select 1 from auth.users where id = other), 'and the other account is not');

  -- The promise on the button: data stays, no longer linked to any account.
  perform ck(exists (select 1 from public.collab_user_votes where app_user_id = me),
             'their votes stay, because they are the campaign''s totals');
  perform ck((select display_name from public.collab_user_votes where app_user_id = me) is null,
             'but their NAME does not — a deleted account is not listed by name');
  perform ck((select display_name from public.kca_user_votes where app_user_id = me) is null,
             'on every board, not just the one');
  perform ck((select display_name from public.collab_user_votes where app_user_id = other) = 'rllyanav',
             'and nobody else is touched');

  perform ck(not exists (select 1 from public.linked_accounts where app_user_id = me),
             'their scrobbler link goes with the account');
  perform ck(not exists (select 1 from public.scrobble_tokens where app_user_id = me),
             'and so does the token that could still post votes');
  perform ck(exists (select 1 from public.scrobble_tokens where app_user_id = other),
             'while the other account keeps its own');
end $$;

\echo '--- it cannot be used on anybody else'
do $$
declare n int;
begin
  -- No session: auth.uid() is null, and there is no argument to aim it with.
  perform set_config('test.uid', '', false);
  begin
    perform public.delete_account();
    raise exception 'it ran with no session';
  exception when others then
    if sqlerrm = 'it ran with no session' then raise; end if;
    perform ck(sqlerrm = 'not signed in', 'with no session it refuses', sqlerrm);
  end;
  select count(*) into n from auth.users;
  perform ck(n = 1, 'and the remaining account is still there', n::text);

  perform ck((select count(*) from pg_proc p
              where p.proname = 'delete_account' and p.pronargs = 0) = 1,
             'it takes no arguments, so there is nothing to point at somebody else');
  perform ck(not has_function_privilege('anon', 'public.delete_account()', 'execute'),
             'and a signed-out caller cannot reach it at all');
  perform ck(has_function_privilege('authenticated', 'public.delete_account()', 'execute'),
             'while a signed-in one can');
end $$;

\echo ''
\echo 'All checks passed.'
