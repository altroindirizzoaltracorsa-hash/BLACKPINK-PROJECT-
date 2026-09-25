-- READ-ONLY check: does the live breaktudo_vote_board() carry the per-category
-- maps the leaderboard renders from?
--
-- Run through apply-sql.yml (file =
-- supabase/checks/verify_breaktudo_board_cats.sql). It only SELECTs — no DDL, no
-- writes — so it is safe to run against production at any time, and the answers
-- land in the workflow log.
--
-- Written because the alternative was inferring from a successful migration run
-- that the function it replaced now returns the right shape. It does not follow:
-- the migration could succeed and still leave a board whose rows the page reads
-- nothing from. This asks the database directly.

\echo '=== 1. the function exists and returns the four cats_* keys per row ==='
-- Cast to jsonb: the RPC is declared `returns json`, and `?` / jsonb_object_keys
-- are jsonb operators (`operator does not exist: json ? unknown` otherwise).
with row1 as (
  select coalesce(
           (breaktudo_vote_board()::jsonb->'ranked'->0),
           (breaktudo_vote_board()::jsonb->'unranked'->0)
         ) as r
)
select
  case when r is null then 'NO ROWS YET — shape cannot be confirmed from data'
       when (r ? 'cats_today') and (r ? 'cats_week')
        and (r ? 'cats_month') and (r ? 'cats_total') then 'OK — all four cats_* keys present'
       else 'MISSING — board is still the pre-migration shape: ' || (select string_agg(k, ', ') from jsonb_object_keys(r) k)
  end as keys_check
from row1;

\echo ''
\echo '=== 2. every rows total >= the sum of its category split ==='
-- The invariant the page depends on: the maps explain PART of the total, never
-- more. A row failing this would render a negative remainder.
with rows as (
  select jsonb_array_elements(breaktudo_vote_board()::jsonb->'ranked') as r
  union all
  select jsonb_array_elements(breaktudo_vote_board()::jsonb->'unranked') as r
),
sums as (
  select
    r->>'name' as name,
    p.period,
    (r->>p.period)::bigint as total,
    coalesce((select sum((e.value)::numeric)
              from jsonb_each(r->('cats_' || p.period)) e), 0)::bigint as attributed
  from rows, (values ('today'),('week'),('month'),('total')) as p(period)
)
select
  case when count(*) filter (where attributed > total) = 0
       then 'OK — no row over-attributes in any period (' || count(*) || ' row/period pairs checked)'
       else 'BROKEN — ' || count(*) filter (where attributed > total) || ' pair(s) claim more than their total'
  end as invariant_check
from sums;

\echo ''
\echo '=== 3. what the board actually returns right now ==='
-- Names included: this is the same data the public leaderboard shows, so the log
-- reveals nothing the page does not.
select jsonb_pretty(breaktudo_vote_board()::jsonb) as board;

\echo ''
\echo '=== 4. community per-category totals (breaktudo_vote_totals) ==='
select jsonb_pretty(breaktudo_vote_totals()::jsonb) as totals;

\echo ''
\echo '=== 5. hard assertion — fails the workflow rather than only printing ==='
-- Sections 1 and 2 print their verdict, which only helps someone who reads the
-- log. This raises, so a wrong shape or a broken invariant turns the run red and
-- cannot be mistaken for a pass. It writes nothing.
do $$
declare
  r jsonb;
  bad int;
begin
  r := coalesce(breaktudo_vote_board()::jsonb->'ranked'->0,
                breaktudo_vote_board()::jsonb->'unranked'->0);
  if r is null then
    raise notice 'board is empty — shape cannot be asserted from data, not treating that as a failure';
  elsif not (r ? 'cats_today' and r ? 'cats_week' and r ? 'cats_month' and r ? 'cats_total') then
    raise exception 'breaktudo_vote_board() is missing the cats_* maps the leaderboard renders from';
  else
    raise notice 'shape assertion passed';
  end if;

  -- `brow`, not `r`: inside a DO block a column aliased `r` collides with the
  -- declared variable of the same name ("column reference r is ambiguous").
  with rows as (
    select jsonb_array_elements(breaktudo_vote_board()::jsonb->'ranked') as brow
    union all
    select jsonb_array_elements(breaktudo_vote_board()::jsonb->'unranked') as brow
  )
  select count(*) into bad
  from rows, (values ('today'),('week'),('month'),('total')) as p(period)
  where coalesce((select sum((e.value)::numeric) from jsonb_each(brow->('cats_' || p.period)) e), 0)
        > coalesce((brow->>p.period)::numeric, 0);

  if bad > 0 then
    raise exception '% row/period pair(s) attribute more votes than their total', bad;
  end if;
  raise notice 'invariant assertion passed';
end $$;
