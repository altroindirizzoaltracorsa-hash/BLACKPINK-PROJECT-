-- READ-ONLY. Writes nothing.
--
-- Checking a draft graphic: "fastest girl-group songs to 1 BILLION Spotify
-- streams, by days". The entries that already passed 1B are historical fact and
-- unchanged between versions. The two marked * are PROJECTIONS — JUMP and Shut
-- Down are still short of 1B — and those are the ones that moved:
--
--             17 Jun 26 post      new draft
--   JUMP        ~851*               ~1000*
--   Shut Down   ~1,843*             ~1,916*
--
-- A projection is: days already elapsed since release, plus the streams still
-- needed divided by the rate they are actually running at. We have both halves —
-- track_daily_stats carries a per-track daily_delta — so this computes it at
-- several windows rather than trusting one.

\pset pager off

with t as (
  select id, name, album_release_date
  from artist_tracks
  where artist_id = '41MozSoPIsD1dJM0CLPjZF'
    and (name ilike 'JUMP' or name ilike 'Shut Down')
),
latest as (
  select distinct on (d.track_ref) d.track_ref, d.date, d.streams
  from track_daily_stats d join t on t.id = d.track_ref
  order by d.track_ref, d.date desc
),
rate as (
  select d.track_ref,
         avg(d.daily_delta) filter (where d.date >= current_date - 7)  as per_day_7,
         avg(d.daily_delta) filter (where d.date >= current_date - 14) as per_day_14,
         avg(d.daily_delta) filter (where d.date >= current_date - 30) as per_day_30,
         avg(d.daily_delta) filter (where d.date >= current_date - 90) as per_day_90
  from track_daily_stats d join t on t.id = d.track_ref
  where d.daily_delta is not null and d.daily_delta > 0
  group by d.track_ref
)
select t.name,
       t.album_release_date                              as released,
       l.date                                            as as_of,
       l.streams                                         as streams_now,
       (1000000000 - l.streams)                          as still_needed,
       (l.date - t.album_release_date)                   as days_elapsed,
       round(r.per_day_7)                                as per_day_7d,
       round(r.per_day_30)                               as per_day_30d,
       round(r.per_day_90)                               as per_day_90d,
       -- total days from release to 1B, at each rate
       (l.date - t.album_release_date) + ceil((1000000000 - l.streams) / nullif(r.per_day_7, 0))  as days_to_1b_at_7d,
       (l.date - t.album_release_date) + ceil((1000000000 - l.streams) / nullif(r.per_day_30, 0)) as days_to_1b_at_30d,
       (l.date - t.album_release_date) + ceil((1000000000 - l.streams) / nullif(r.per_day_90, 0)) as days_to_1b_at_90d
from t
join latest l on l.track_ref = t.id
join rate   r on r.track_ref = t.id
order by t.name;

\echo ''
\echo '=== is the rate steady or falling? (weekly averages) ==='
-- A projection from a 7-day window is only as good as the trend behind it.
select t.name,
       date_trunc('week', d.date)::date as week,
       round(avg(d.daily_delta))        as avg_per_day,
       count(*)                         as days
from track_daily_stats d
join artist_tracks t on t.id = d.track_ref
where t.artist_id = '41MozSoPIsD1dJM0CLPjZF'
  and (t.name ilike 'JUMP' or t.name ilike 'Shut Down')
  and d.daily_delta is not null and d.daily_delta > 0
  and d.date >= current_date - 70
group by t.name, 2
order by t.name, 2;
