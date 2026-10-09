-- Exercise kca_vote_totals() / kca_vote_board() against known rows.
--
-- Run against a THROWAWAY database, not production — it inserts and rolls back:
--   psql -f supabase/migrations/kca_vote_board.sql
--   psql -f supabase/migrations/kca_vote_board_ranked.sql
--   psql -f supabase/checks/kca_vote_board_test.sql
--
-- Two things are worth pinning here.
--
-- The per-category rollup: `votes` is a plain sum and hard to get wrong, while
-- `cats` is a jsonb map summed per blink per period, and a wrong period filter
-- there shows up as a category tally that is right in one bucket and silently
-- wrong in another — the kind of thing a page renders without complaint.
--
-- And the ranked/unranked split, which kca_vote_board_ranked.sql added: the rule
-- across this board is "no stream = no rank", so a blink who votes and never
-- streams must come back under `unranked` and still carry their full totals. A
-- board that put them in the ranked table would look completely normal.
begin;

-- Fixed identities so the expectations can name them.
\set u1 '''11111111-1111-1111-1111-111111111111'''
\set u2 '''22222222-2222-2222-2222-222222222222'''

-- "Today" has to be computed the way the functions do, or a test run near the
-- KST boundary fails for the wrong reason.
create temporary view kst as select (now() at time zone 'Asia/Seoul')::date as d;

insert into kca_user_votes (app_user_id, day, votes, cats, display_name, ext_at) values
  -- blink 1, today: a full round (all three of ours) plus two more group-only rounds
  (:u1, (select d from kst), 5,
   '{"favorite-music-group-or-duo":3,"favorite-female-artist":1,"favorite-music-collaboration":1}',
   'alpha', now()),
  -- blink 1, yesterday: in this week, and in this month unless today is the 1st
  (:u1, (select d - 1 from kst), 2,
   '{"favorite-female-artist":2}', 'alpha', null),
  -- blink 1, 60 days ago: all-time only
  (:u1, (select d - 60 from kst), 10,
   '{"favorite-music-group-or-duo":10}', 'alpha', null),
  -- blink 2, today, hand-logged (no ext_at)
  (:u2, (select d from kst), 3,
   '{"favorite-music-group-or-duo":1,"favorite-female-artist":2}', 'beta', null);

-- Only blink 1 has ever streamed, so only blink 1 can be RANKED. Blink 2 votes
-- and does not stream, which is the case the split exists for: they must come
-- back under `unranked`, with their totals intact.
insert into user_daily_counts (app_user_id, day_key, jump) values
  (:u1, (select d::text from kst), 40);

\echo ''
\echo '=== community totals'
select
  (kca_vote_totals()->>'total')::int        as total,
  (kca_vote_totals()->>'today')::int        as today,
  (kca_vote_totals()->>'blinksTotal')::int  as blinks_total,
  (kca_vote_totals()->>'blinksToday')::int  as blinks_today;

\echo ''
\echo 'expected: total 20, today 8, blinksTotal 2, blinksToday 2'
select
  case when (kca_vote_totals()->>'total')::int = 20 then 'PASS' else 'FAIL' end as total_20,
  case when (kca_vote_totals()->>'today')::int = 8  then 'PASS' else 'FAIL' end as today_8,
  case when (kca_vote_totals()->>'blinksTotal')::int = 2 then 'PASS' else 'FAIL' end as blinks_2,
  case when (kca_vote_totals()->>'blinksToday')::int = 2 then 'PASS' else 'FAIL' end as today_blinks_2;

\echo ''
\echo '=== per-category, all time vs today'
\echo 'group all-time 14 (3+10+1), today 4 (3+1); female all-time 5 (1+2+2), today 3 (1+2)'
select
  case when (kca_vote_totals()->'byCat'->>'favorite-music-group-or-duo')::int = 14
       then 'PASS' else 'FAIL · ' || coalesce((kca_vote_totals()->'byCat'->>'favorite-music-group-or-duo'), 'null') end as group_all,
  case when (kca_vote_totals()->'byCatToday'->>'favorite-music-group-or-duo')::int = 4
       then 'PASS' else 'FAIL · ' || coalesce((kca_vote_totals()->'byCatToday'->>'favorite-music-group-or-duo'), 'null') end as group_today,
  case when (kca_vote_totals()->'byCat'->>'favorite-female-artist')::int = 5
       then 'PASS' else 'FAIL · ' || coalesce((kca_vote_totals()->'byCat'->>'favorite-female-artist'), 'null') end as female_all,
  case when (kca_vote_totals()->'byCatToday'->>'favorite-female-artist')::int = 3
       then 'PASS' else 'FAIL · ' || coalesce((kca_vote_totals()->'byCatToday'->>'favorite-female-artist'), 'null') end as female_today;

\echo ''
\echo '=== the board'
select
  which, b->>'name' as name,
  (b->>'total')::int          as total,
  (b->>'today')::int          as today,
  (b->>'streams')::int        as streams,
  (b->>'usedExtension')::bool as ext,
  b->'cats_total'->>'favorite-music-group-or-duo' as cats_group,
  b->'cats_today'->>'favorite-music-group-or-duo' as today_group
from (values ('ranked'), ('unranked')) as w(which),
     json_array_elements(kca_vote_board()->w.which) b;

\echo ''
\echo 'expected: alpha ranked (17 total / 5 today / 40 streams / ext true); beta unranked (3 / 3 / hand)'
select
  case when json_array_length(kca_vote_board()->'ranked')   = 1 then 'PASS' else 'FAIL · ' || json_array_length(kca_vote_board()->'ranked')::text end   as one_ranked,
  case when json_array_length(kca_vote_board()->'unranked') = 1 then 'PASS' else 'FAIL · ' || json_array_length(kca_vote_board()->'unranked')::text end as one_unranked,
  case when (kca_vote_board()->'ranked'->0->>'name') = 'alpha' then 'PASS' else 'FAIL' end as alpha_ranked,
  case when (kca_vote_board()->'ranked'->0->>'total')::int = 17 then 'PASS' else 'FAIL' end as alpha_17,
  case when (kca_vote_board()->'ranked'->0->>'today')::int = 5  then 'PASS' else 'FAIL' end as alpha_today_5,
  case when (kca_vote_board()->'ranked'->0->>'streams')::int = 40 then 'PASS' else 'FAIL' end as alpha_streams,
  case when (kca_vote_board()->'ranked'->0->>'usedExtension')::bool then 'PASS' else 'FAIL' end as alpha_ext,
  -- The point of the split: a blink who never streamed keeps their full total,
  -- they are simply not in the ranked table.
  case when (kca_vote_board()->'unranked'->0->>'name') = 'beta' then 'PASS' else 'FAIL' end as beta_unranked,
  case when (kca_vote_board()->'unranked'->0->>'total')::int = 3 then 'PASS' else 'FAIL' end as beta_3,
  case when not (kca_vote_board()->'unranked'->0->>'usedExtension')::bool then 'PASS' else 'FAIL' end as beta_hand;

\echo ''
\echo '=== the 60-day-old row is all-time only, not in today or week'
\echo 'alpha cats group: all-time 13, today 3 — the 10 must NOT leak into today'
select
  case when (kca_vote_board()->'ranked'->0->'cats_total'->>'favorite-music-group-or-duo')::int = 13
       then 'PASS' else 'FAIL · ' || coalesce((kca_vote_board()->'ranked'->0->'cats_total'->>'favorite-music-group-or-duo'),'null') end as alpha_group_all,
  case when (kca_vote_board()->'ranked'->0->'cats_today'->>'favorite-music-group-or-duo')::int = 3
       then 'PASS' else 'FAIL · ' || coalesce((kca_vote_board()->'ranked'->0->'cats_today'->>'favorite-music-group-or-duo'),'null') end as alpha_group_today,
  -- A category with no votes in a period must be ABSENT from that period's map,
  -- not present as 0 — the page keys off presence.
  -- `?` is a jsonb operator and the RPC returns json, hence the casts.
  case when ((kca_vote_board()->'ranked'->0->'cats_today')::jsonb ? 'favorite-music-collaboration')
        and not ((kca_vote_board()->'unranked'->0->'cats_today')::jsonb ? 'favorite-music-collaboration')
       then 'PASS' else 'FAIL' end as absent_not_zero;

rollback;
