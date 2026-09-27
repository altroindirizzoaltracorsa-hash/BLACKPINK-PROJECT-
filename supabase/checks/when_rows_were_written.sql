-- READ-ONLY. Writes nothing.
--
-- Which fetch run wrote each dated row. BLACKPINK's dates were repaired and are
-- believed right; the members' are suspected to be one day ahead. Both are
-- fetched by the same job in the same run, so if a members' row and a BLACKPINK
-- row were written moments apart but carry DIFFERENT dates, that gap is the
-- shift, stated by our own write log rather than inferred from a tracker.

\pset pager off

select coalesce(t.name, a.artist_id) as artist,
       a.date,
       a.daily_delta,
       a.created_at,
       date_trunc('minute', a.created_at) as written_at_minute
from artist_daily_stats a
left join tracked_artists t on t.spotify_artist_id = a.artist_id
where a.artist_id in ('6UZ0ba50XreR4TM8u322gs','250b0Wlc5Vk0CoUsaCY84M',
                      '3eVa5w3URK5duf6eyVDbu9','5L1lO4eRHmJ7a0Q6csE5cT',
                      '41MozSoPIsD1dJM0CLPjZF')
  and a.date >= date '2026-09-21'
order by a.created_at, artist;
