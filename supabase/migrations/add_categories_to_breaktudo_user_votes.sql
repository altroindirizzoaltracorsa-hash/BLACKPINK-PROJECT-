-- Per-category BreakTudo vote detail.
--
-- breaktudo_user_votes.sql said this would come: "Single `votes` tally for now.
-- If we later confirm (from the vote request) that BreakTudo exposes per-category
-- detail, add category columns alongside `votes` without breaking the total — the
-- tally is authoritative for ranking." It does expose it — the vote POST's referer
-- is /vote/<slug>/ — so this adds it.
--
-- A jsonb map rather than the bp/lisa-style columns the VMA table uses. There are
-- eight BreakTudo categories against the VMAs' two, they are BreakTudo's own
-- Portuguese slugs, and next year's set will differ — eight columns would mean a
-- migration every time the award changes its categories. Shape:
--   {"grupo-feminino-internacional": 12, "artista-asiatico": 5}
--
-- `votes` stays the authoritative TOTAL used for ranking and is NOT derived from
-- this map. Rows written before this migration keep their totals with cats = {},
-- i.e. counted but unattributed — the same way pre-split VMA rows kept bp = lisa = 0.
-- So sum(cats) <= votes by design, and the UI must never present the map as if it
-- accounted for everything.
--
-- Run once in the Supabase SQL editor. Safe to re-run (idempotent).

alter table breaktudo_user_votes
  add column if not exists cats jsonb not null default '{}'::jsonb;

-- Guard the shape at the database rather than trusting every writer: a flat object
-- of non-negative numbers. Without this a bad client could store nested junk that
-- the aggregation below would then fail on.
--
-- The test lives in a function because Postgres rejects a subquery inside a CHECK
-- constraint ("cannot use subquery in check constraint") and walking the object
-- needs jsonb_each. A plain call to an IMMUTABLE function is allowed there.
create or replace function breaktudo_cats_valid(c jsonb)
returns boolean
language sql
immutable
as $$
  select jsonb_typeof(c) = 'object'
     and not exists (
       select 1 from jsonb_each(c) e
       where jsonb_typeof(e.value) <> 'number' or (e.value)::numeric < 0
     );
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'breaktudo_user_votes_cats_shape'
  ) then
    alter table breaktudo_user_votes
      add constraint breaktudo_user_votes_cats_shape check (breaktudo_cats_valid(cats));
  end if;
end $$;

-- Community totals gain a per-category breakdown (all-time and today, Brasília).
-- `total`/`today` keep their existing meaning so nothing reading them breaks.
create or replace function breaktudo_vote_totals()
returns json
language sql
stable
as $$
  with today_bounds as (
    select (now() at time zone 'America/Sao_Paulo')::date as d
  ),
  cat_all as (
    select e.key as k, sum((e.value)::numeric)::bigint as v
    from breaktudo_user_votes b, jsonb_each(b.cats) e
    group by e.key
  ),
  cat_today as (
    select e.key as k, sum((e.value)::numeric)::bigint as v
    from breaktudo_user_votes b, today_bounds t, jsonb_each(b.cats) e
    where b.day = t.d
    group by e.key
  )
  select json_build_object(
    'total',       coalesce((select sum(votes) from breaktudo_user_votes), 0),
    'today',       coalesce((select sum(votes) from breaktudo_user_votes b, today_bounds t where b.day = t.d), 0),
    'blinksTotal', (select count(distinct app_user_id) from breaktudo_user_votes),
    'blinksToday', (select count(distinct app_user_id) from breaktudo_user_votes b, today_bounds t where b.day = t.d),
    'byCat',       coalesce((select jsonb_object_agg(k, v) from cat_all),   '{}'::jsonb),
    'byCatToday',  coalesce((select jsonb_object_agg(k, v) from cat_today), '{}'::jsonb)
  );
$$;

grant execute on function breaktudo_vote_totals() to service_role;

-- breaktudo_vote_board() is deliberately NOT changed. Ranking stays by the
-- combined `votes` total, and the board stays one row per blink: eight categories
-- x four periods is 32 numbers per person, which no leaderboard can show and no
-- one would read. Per-category detail belongs to the voter's own card and to the
-- community totals above, both of which this migration covers.
