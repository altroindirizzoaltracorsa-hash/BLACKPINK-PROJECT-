-- READ-ONLY. Writes nothing.
--
-- What the release-date resolver actually stored, and which rows to distrust.
--
-- The resolver takes the EARLIEST release carrying a track of the same title,
-- which fixes a single later folded into an album (JUMP read as DEADLINE's
-- 2026-02-27 instead of its own 2025-07-11). The weakness is structural: a
-- WRONG early match beats a right later one by construction, and the live board
-- showed one — "Sour Candy (with BLACKPINK)" dated to ~1989, which put its 1B
-- arrival in 2057.
--
-- So list every date with its precision and its age, newest query first, and
-- make the implausible ones impossible to miss.

\pset pager off

\echo '=== 1. how the 58 dates were arrived at ==='
select coalesce(release_precision, '(null)') as precision,
       count(*) as tracks,
       min(release_date) as earliest,
       max(release_date) as latest
from group_tracks
where release_date is not null
group by 1
order by 2 desc;

\echo ''
\echo '=== 2. implausible dates — before any of these groups existed ==='
-- BLACKPINK debuted in 2016 and is the oldest of the seven. Anything before
-- 2015 is a title collision with some unrelated song, not a release of theirs.
select t.name, t.release_date, t.release_precision, t.track_id,
       (current_date - t.release_date) as days_old
from group_tracks t
where t.release_date is not null
  and t.release_date < date '2015-01-01'
order by t.release_date;

\echo ''
\echo '=== 3. every dated track, oldest first — eyeball the top of this list ==='
select t.name,
       t.release_date,
       t.release_precision as how,
       (select max(d.streams) from group_track_daily_stats d where d.track_ref = t.id) as streams
from group_tracks t
where t.release_date is not null
order by t.release_date
limit 25;
