-- READ-ONLY. Writes nothing.
--
-- "Days from release to 1B" is only as good as the release date it counts from.
-- Our projection used artist_tracks.album_release_date, which is the ALBUM's date.
-- If JUMP first came out as a single before that album, every JUMP figure is too
-- small by the gap — and the gap is exactly the size that would reconcile our 746
-- with the graphic's 1,000.
--
-- So: every JUMP-ish row we hold, what album and date each carries, and how far
-- back our own per-track history actually goes.

\pset pager off

\echo '=== every BLACKPINK track whose name looks like JUMP ==='
select t.id, t.name, t.album, t.album_release_date, t.track_number,
       t.source_track_ids,
       min(d.date) as first_daily_row,
       max(d.date) as last_daily_row,
       max(d.streams) as latest_streams
from artist_tracks t
left join track_daily_stats d on d.track_ref = t.id
where t.artist_id = '41MozSoPIsD1dJM0CLPjZF'
  and (t.name ilike '%jump%' or t.name ilike '%뛰어%')
group by t.id, t.name, t.album, t.album_release_date, t.track_number, t.source_track_ids
order by t.album_release_date nulls last;

\echo ''
\echo '=== for contrast: the album dates we hold for the other listed songs ==='
select t.name, t.album, t.album_release_date
from artist_tracks t
where t.artist_id = '41MozSoPIsD1dJM0CLPjZF'
  and t.name in ('Shut Down','Pink Venom','How You Like That','Kill This Love')
order by t.album_release_date;
