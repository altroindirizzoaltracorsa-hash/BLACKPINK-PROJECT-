\echo '=== any leftover Sep 24 rows for BLACKPINK? ==='
select 'artist_daily_stats' as tbl, count(*) from artist_daily_stats
 where artist_id = '41MozSoPIsD1dJM0CLPjZF' and date = date '2026-09-24'
union all
select 'track_daily_stats', count(*) from track_daily_stats d
 join artist_tracks t on t.id = d.track_ref
 where t.artist_id = '41MozSoPIsD1dJM0CLPjZF' and d.date = date '2026-09-24';

\echo ''
\echo '=== the repaired day, per track (top movers) ==='
select t.name, d.streams, d.daily_delta
from track_daily_stats d join artist_tracks t on t.id = d.track_ref
where t.artist_id = '41MozSoPIsD1dJM0CLPjZF' and d.date = date '2026-09-23'
order by d.daily_delta desc nulls last limit 8;

\echo ''
\echo '=== every track has exactly one row for the 23rd, and all moved ==='
select count(*) as tracks,
       count(*) filter (where daily_delta > 0)  as moved,
       count(*) filter (where daily_delta = 0)  as unchanged,
       count(*) filter (where daily_delta < 0)  as fell,
       sum(daily_delta)                         as summed_delta
from track_daily_stats d join artist_tracks t on t.id = d.track_ref
where t.artist_id = '41MozSoPIsD1dJM0CLPjZF' and d.date = date '2026-09-23';
