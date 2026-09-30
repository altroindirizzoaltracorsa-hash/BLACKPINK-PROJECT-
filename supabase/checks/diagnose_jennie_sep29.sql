-- READ-ONLY. Writes nothing, changes nothing.
--
-- Reported from /streams: JENNIE shows 29/09/2026 at +376 — against ~7.3M on an
-- ordinary day — and she is the ONLY artist with a 29 Sep row at all; the other
-- four still end on the 28th.
--
-- Two very different things look like that, and the fix differs:
--
--   (a) A PROVISIONAL row: a fetch ran while Spotify was still publishing, caught
--       a couple of tracks that had ticked, and opened the day early. Self-heals —
--       the next run rewrites the same dated row as the rest of the catalogue
--       lands. Nothing to repair.
--
--   (b) A half-published day written as FINAL: the row is closed at +376 and the
--       real day's streams will land on the 30th, merging two days into one entry.
--       That is the split-publish failure, and it needs the same repair the
--       members got for 23 Sep.
--
-- What tells them apart is `provisional` plus HOW MANY tracks moved. A handful of
-- tracks moving is mid-publish; 43 of 43 moving by a few streams each is a real,
-- and impossibly small, day.

\pset pager off

\echo '=== 1. JENNIE, last 10 days — is the 29th flagged provisional? ==='
select a.date,
       a.total_streams,
       a.daily_delta,
       a.track_count,
       a.provisional,
       a.created_at,
       a.updated_at
from artist_daily_stats a
where a.artist_id = '250b0Wlc5Vk0CoUsaCY84M'
  and a.date >= date '2026-09-20'
order by a.date;

\echo ''
\echo '=== 2. where every artist ENDS — is JENNIE really a day ahead? ==='
select coalesce(t.name, a.artist_id) as artist,
       max(a.date)                   as last_day,
       (array_agg(a.daily_delta order by a.date desc))[1] as last_delta,
       (array_agg(a.provisional order by a.date desc))[1] as last_provisional
from artist_daily_stats a
left join tracked_artists t on t.spotify_artist_id = a.artist_id
where a.artist_id in ('6UZ0ba50XreR4TM8u322gs','250b0Wlc5Vk0CoUsaCY84M',
                      '3eVa5w3URK5duf6eyVDbu9','5L1lO4eRHmJ7a0Q6csE5cT',
                      '41MozSoPIsD1dJM0CLPjZF')
group by 1
order by 1;

\echo ''
\echo '=== 3. the decisive one: how many of JENNIE''s tracks moved on the 29th ==='
-- A few tracks moving = caught mid-publish (provisional, self-heals).
-- Nearly all 43 moving, by a few streams each = a genuinely tiny day (suspicious).
select d.date,
       count(*)                                        as tracks_with_a_row,
       count(*) filter (where coalesce(d.daily_delta,0) > 0) as tracks_that_moved,
       sum(coalesce(d.daily_delta,0))                  as summed_delta,
       max(d.daily_delta)                              as biggest_single_track
from track_daily_stats d
join artist_tracks t on t.id = d.track_ref
where t.artist_id = '250b0Wlc5Vk0CoUsaCY84M'
  and d.date >= date '2026-09-26'
group by d.date
order by d.date;

\echo ''
\echo '=== 4. which tracks moved on the 29th, and by how much ==='
select t.name, d.daily_delta
from track_daily_stats d
join artist_tracks t on t.id = d.track_ref
where t.artist_id = '250b0Wlc5Vk0CoUsaCY84M'
  and d.date = date '2026-09-29'
  and coalesce(d.daily_delta,0) > 0
order by d.daily_delta desc
limit 20;

\echo ''
\echo '=== 5. when each row was written, all five artists ==='
-- If JENNIE''s 29th was written by the same run that wrote everyone else''s 28th,
-- that is the members-ahead-of-group shift again rather than a quiet day.
select coalesce(t.name, a.artist_id) as artist,
       a.date,
       a.daily_delta,
       a.provisional,
       date_trunc('minute', a.created_at) as written_at
from artist_daily_stats a
left join tracked_artists t on t.spotify_artist_id = a.artist_id
where a.artist_id in ('6UZ0ba50XreR4TM8u322gs','250b0Wlc5Vk0CoUsaCY84M',
                      '3eVa5w3URK5duf6eyVDbu9','5L1lO4eRHmJ7a0Q6csE5cT',
                      '41MozSoPIsD1dJM0CLPjZF')
  and a.date >= date '2026-09-27'
order by a.created_at, artist;

\echo ''
\echo '=== 6. the split-publish test on the 28th/29th pair ==='
-- moved_both near zero  → the two rows are ONE publish written as two days.
-- moved_both high       → two real days; leave them alone.
with moved as (
  select d.track_ref, count(*) as days_moved
  from track_daily_stats d
  join artist_tracks t on t.id = d.track_ref
  where t.artist_id = '250b0Wlc5Vk0CoUsaCY84M'
    and d.date in (date '2026-09-28', date '2026-09-29')
    and coalesce(d.daily_delta, 0) > 0
  group by d.track_ref
)
select count(*) filter (where days_moved > 1) as moved_both,
       count(*)                               as moved_either
from moved;
