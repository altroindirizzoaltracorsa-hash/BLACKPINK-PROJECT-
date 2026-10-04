-- READ-ONLY. Does every song on the Road to 1B board have a row for the newest
-- recorded group day, or is the board a day behind the daily log?
--
-- The two halves of the girl-group page come from different places: the daily
-- log reads the committed data/group_streams/history.csv, the 1B board reads
-- group_track_daily_stats in Supabase. They are written by the same job but
-- down different code paths (the committed-file write, then push_per_track at
-- the very end of main(), each group wrapped in its own try/except). So "the
-- log shows a day the board does not" is a real possible state, and this is how
-- to tell it from a browser serving a stale page.
--
-- Prints three things:
--   1. the newest date in the table, and how many tracks reached it
--   2. every racing track (>= the 400M floor, under 1B) with its newest date,
--      so a track stuck behind the rest shows up by name
--   3. the per-day deltas for the last 4 days of the leaders

\echo ''
\echo '=== newest day in group_track_daily_stats'
select date,
       count(*)                                  as track_rows,
       count(*) filter (where streams >= 360000000) as at_or_near_floor,
       count(*) filter (where stale)             as stale_rows,
       count(*) filter (where not counted)       as watchlist_rows
  from group_track_daily_stats s
  join group_tracks t on t.id = s.track_ref
 where date >= (select max(date) - 3 from group_track_daily_stats)
 group by date
 order by date desc;

\echo ''
\echo '=== every racing track: is it on the newest day?'
with newest as (select max(date) as d from group_track_daily_stats),
     last_row as (
       select distinct on (s.track_ref)
              s.track_ref, s.date, s.streams, s.daily_delta, s.stale
         from group_track_daily_stats s
        order by s.track_ref, s.date desc
     )
select t.name,
       l.date                                        as newest_row,
       case when l.date = (select d from newest) then 'current'
            else 'BEHIND by ' || ((select d from newest) - l.date) || 'd' end as status,
       to_char(l.streams, 'FM999,999,999')           as streams,
       to_char(l.daily_delta, 'FM999,999,999')       as delta,
       l.stale
  from last_row l
  join group_tracks t on t.id = l.track_ref
 where t.counted
   and l.streams >= 400000000
   and l.streams < 1000000000
 order by (l.date = (select d from newest)), l.streams desc;

\echo ''
\echo '=== last 4 days for the leaders — the per-track series the board plots'
select t.name, s.date,
       to_char(s.streams, 'FM999,999,999')     as streams,
       to_char(s.daily_delta, 'FM999,999,999') as delta,
       s.merged_with, s.stale
  from group_track_daily_stats s
  join group_tracks t on t.id = s.track_ref
 where t.track_id in (
         '1aKvZDoLGkNMxoRYgkckZG',  -- ILLIT   — Magnetic
         '5H1sKFMzDeMtXwND3V6hRY',  -- BLACKPINK — JUMP
         '6tCd8bPvYnceDG7W9M1RMk'   -- BLACKPINK — Shut Down
       )
   and s.date >= (select max(date) - 3 from group_track_daily_stats)
 order by t.name, s.date;
