-- READ-ONLY. Writes nothing.
--
-- A JISOO fan tracker posted per-track totals on X. Those are the same numbers
-- we store per track, so they date the post against our rows to the stream —
-- which settles, independently of any reasoning about publish times, whether
-- our date labels are a day ahead of everyone else's.
--
-- The figures, as posted (screenshot, posts timestamped "22h" at 01:01 Rome on
-- 2026-09-28, so published around 03:00 Rome on 2026-09-27):
--
--   #CLICK                   19,205,875  (+475,390)
--   EYES CLOSED with ZAYN   182,629,563  (+178,670)
--   earthquake              201,819,452  (+149,754)
--   Your Love                87,520,402  (+109,251)
--   Hugs & Kisses            48,907,325   (+56,971)
--   TEARS                    35,441,281   (+40,508)
--   FLOWER                  638,449,020  (+122,355)
--   All Eyes on Me          191,383,256   (+49,701)
--
-- If every one of them lands on the SAME date in our table, that date is the
-- streaming day the tracker published on 2026-09-27 — and if that date is
-- 2026-09-27 our labels are right, while 2026-09-26 means we are a day ahead,
-- exactly as LISA's tracker already showed.

\pset pager off

\echo '=== 1. where each posted figure lands in our per-track rows ==='
with probe(label, streams, delta) as (
  values ('#CLICK',                  19205875::bigint, 475390::bigint),
         ('EYES CLOSED with ZAYN',  182629563,         178670),
         ('earthquake',             201819452,         149754),
         ('Your Love',               87520402,         109251),
         ('Hugs & Kisses',           48907325,          56971),
         ('TEARS',                   35441281,          40508),
         ('FLOWER',                 638449020,         122355),
         ('All Eyes on Me',         191383256,          49701)
)
select p.label,
       p.streams                as posted,
       t.name                   as our_track,
       d.date                   as our_date,
       d.streams                as our_streams,
       d.streams - p.streams    as diff,
       d.daily_delta            as our_delta,
       p.delta                  as posted_delta
from probe p
join artist_tracks t        on t.artist_id = '6UZ0ba50XreR4TM8u322gs'
join track_daily_stats d    on d.track_ref = t.id
where d.date >= date '2026-09-21'
  and d.streams = p.streams
order by p.label, d.date;

\echo ''
\echo '=== 2. nearest row per posted figure, in case none matches exactly ==='
-- A scope difference (a remix or a feature we count and they do not) would show
-- as a small constant offset rather than an exact hit. This finds the closest
-- row on each date so the offset is visible instead of the query just coming
-- back empty.
with probe(label, streams) as (
  values ('#CLICK',                  19205875::bigint),
         ('EYES CLOSED with ZAYN',  182629563),
         ('earthquake',             201819452),
         ('Your Love',               87520402),
         ('Hugs & Kisses',           48907325),
         ('TEARS',                   35441281),
         ('FLOWER',                 638449020),
         ('All Eyes on Me',         191383256)
)
select p.label, p.streams as posted, x.name as our_track, x.date, x.streams, x.streams - p.streams as diff
from probe p
cross join lateral (
  select t.name, d.date, d.streams
  from artist_tracks t
  join track_daily_stats d on d.track_ref = t.id
  where t.artist_id = '6UZ0ba50XreR4TM8u322gs'
    and d.date >= date '2026-09-21'
  order by abs(d.streams - p.streams), d.date
  limit 3
) x
order by p.label, abs(x.streams - p.streams);

\echo ''
\echo '=== 3. our full per-track series for JISOO, for reference ==='
select t.name, d.date, d.streams, d.daily_delta
from artist_tracks t
join track_daily_stats d on d.track_ref = t.id
where t.artist_id = '6UZ0ba50XreR4TM8u322gs'
  and d.date >= date '2026-09-21'
order by t.name, d.date;

\echo ''
\echo '=== 4. what the posted tracks sum to, per date ==='
-- The posted set is 8 tracks; we track 13. Their sum on the right date must sit
-- just under our artist total, and their combined daily must sit just under our
-- artist daily. A date where the posted daily EXCEEDS our artist daily cannot be
-- the right date.
with posted(streams) as (
  values (19205875::bigint), (182629563), (201819452), (87520402),
         (48907325), (35441281), (638449020), (191383256)
),
ours as (
  select d.date, sum(d.streams) as track_sum, sum(coalesce(d.daily_delta,0)) as track_delta, count(*) as n
  from artist_tracks t
  join track_daily_stats d on d.track_ref = t.id
  where t.artist_id = '6UZ0ba50XreR4TM8u322gs' and d.date >= date '2026-09-21'
  group by d.date
)
select o.date,
       o.n                                   as our_tracks,
       o.track_sum                           as our_track_sum,
       a.total_streams                       as our_artist_total,
       a.daily_delta                         as our_artist_delta,
       (select sum(streams) from posted)     as posted_sum_8,
       a.total_streams - (select sum(streams) from posted) as untracked_remainder,
       1182600                               as posted_delta_8,
       a.daily_delta - 1182600               as remainder_delta
from ours o
join artist_daily_stats a
  on a.artist_id = '6UZ0ba50XreR4TM8u322gs' and a.date = o.date
order by o.date;
