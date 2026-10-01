-- READ-ONLY. Writes nothing.
--
-- Before changing the fetch to HOLD a half-published day instead of writing it
-- provisionally, establish the one thing that makes holding unsafe: could a real,
-- complete day ever look unfinished and stall us forever?
--
-- `publish_unfinished` calls a day unfinished when >= UNCHANGED_LIMIT (20%) of an
-- artist's comparable tracks have not moved since the previous recorded day. So
-- the question is empirical: across real history, what share of tracks move on a
-- normal day, and has any complete day ever sat near 20%?
--
-- Also: how far behind does the series normally run? That bounds any "we are
-- stalled, write it anyway" guard, so the number comes from the data rather than
-- from me picking one.

\pset pager off

\echo '=== 1. per artist-day: share of tracks that did NOT move ==='
-- Computed the same way publish_unfinished does: only tracks with a previous
-- value are comparable. A clean day should be ~0% unchanged.
with per_day as (
  select t.artist_id,
         d.date,
         count(*)                                                  as comparable,
         count(*) filter (where coalesce(d.daily_delta, 0) = 0)    as unchanged
  from track_daily_stats d
  join artist_tracks t on t.id = d.track_ref
  where d.date >= date '2026-08-01'
    and d.daily_delta is not null          -- excludes first-ever rows
  group by t.artist_id, d.date
),
scored as (
  select p.*, round(100.0 * p.unchanged / nullif(p.comparable, 0), 1) as pct_unchanged
  from per_day p
  where p.comparable >= 12                 -- MIN_COMPARABLE
)
select coalesce(t.name, s.artist_id) as artist,
       count(*)                                        as days,
       round(avg(s.pct_unchanged), 2)                  as avg_pct_unchanged,
       max(s.pct_unchanged)                            as worst_pct_unchanged,
       count(*) filter (where s.pct_unchanged >= 20)   as days_over_the_20pct_line,
       count(*) filter (where s.pct_unchanged between 5 and 20) as days_in_5_to_20
from scored s
left join tracked_artists t on t.spotify_artist_id = s.artist_id
group by 1
order by 1;

\echo ''
\echo '=== 2. the days that DID cross 20% — were they provisional/known-bad? ==='
with per_day as (
  select t.artist_id, d.date,
         count(*)                                               as comparable,
         count(*) filter (where coalesce(d.daily_delta, 0) = 0) as unchanged
  from track_daily_stats d
  join artist_tracks t on t.id = d.track_ref
  where d.date >= date '2026-08-01' and d.daily_delta is not null
  group by t.artist_id, d.date
)
select coalesce(t.name, p.artist_id) as artist,
       p.date,
       p.unchanged || '/' || p.comparable as unchanged_of_comparable,
       round(100.0 * p.unchanged / p.comparable, 1) as pct_unchanged,
       a.daily_delta,
       a.provisional
from per_day p
left join tracked_artists t on t.spotify_artist_id = p.artist_id
left join artist_daily_stats a on a.artist_id = p.artist_id and a.date = p.date
where p.comparable >= 12
  and (100.0 * p.unchanged / p.comparable) >= 20
order by pct_unchanged desc, artist, p.date
limit 40;

\echo ''
\echo '=== 3. how far behind does each artist normally run, and worst gap? ==='
-- Bounds any stall guard: if days are never more than N apart in practice, a gap
-- beyond N is a genuine stall rather than Spotify being slow.
with d as (
  select artist_id, date,
         date - lag(date) over (partition by artist_id order by date) as gap_days
  from artist_daily_stats
  where date >= date '2026-08-01'
)
select coalesce(t.name, d.artist_id) as artist,
       count(*) filter (where gap_days is not null)       as transitions,
       max(gap_days)                                      as worst_gap_days,
       count(*) filter (where gap_days > 1)               as gaps_over_1_day,
       max(date)                                          as last_recorded
from d
left join tracked_artists t on t.spotify_artist_id = d.artist_id
group by 1
order by 1;

\echo ''
\echo '=== 4. current state — what is sitting unwritten right now ==='
select coalesce(t.name, a.artist_id) as artist,
       max(a.date) as last_day,
       (array_agg(a.provisional order by a.date desc))[1] as last_is_provisional,
       (current_date - 1) - max(a.date) as days_behind_yesterday
from artist_daily_stats a
left join tracked_artists t on t.spotify_artist_id = a.artist_id
group by 1
order by 1;
