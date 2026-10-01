-- READ-ONLY. Writes nothing.
--
-- Sweeps EVERY tracked artist for a half-published Spotify day: one streaming
-- day written as two dated rows, because a fetch ran while Spotify was still
-- publishing. It happened to BLACKPINK on 2026-09-23 and — in the same fetch
-- run, minutes apart — to all four members, who then carried it for four days
-- because only the artist that had been reported was looked at.
--
-- That is the whole point of this file: it takes no list of artists. It reads
-- tracked_artists, so a new artist is covered the day it is added and nobody
-- has to remember to include it.
--
-- The test:
--   A real pair of days moves nearly every track TWICE — once each day.
--   One publish split in half moves each track exactly ONCE across the pair.
-- So a pair where both days saw movement but almost no track moved on both is
-- one publish wearing two dates.
--
-- Exits non-zero when it finds one, so a scheduled run goes red and says so
-- rather than printing into a log nobody reads.
--
-- NOTE on the predicate: an earlier version of this sweep (query 3 of
-- checks/diagnose_member_sep23_split.sql) counted moved_d2 with a join that
-- already required the track to have moved on BOTH days, making moved_d2 and
-- moved_both the same number. Its filter then asked for moved_d2 > 5 AND
-- moved_both <= a tenth of that — never satisfiable, so it returned zero rows
-- on every input, including the split it was pointed at. The three counts are
-- computed separately here for exactly that reason.

\set ON_ERROR_STOP on
\pset pager off

\set window_days 60

create temporary table _pairs as
with per_day as (
  select t.artist_id, d.date, d.track_ref
  from track_daily_stats d
  join artist_tracks t on t.id = d.track_ref
  where d.date >= current_date - :window_days
    and coalesce(d.daily_delta, 0) > 0
),
-- how many tracks moved on each single day
by_day as (
  select artist_id, date, count(distinct track_ref) as n_moved
  from per_day group by artist_id, date
),
-- how many moved on a day AND the day after it
both_days as (
  select a.artist_id, a.date as d1, count(distinct a.track_ref) as moved_both
  from per_day a
  join per_day b
    on b.artist_id = a.artist_id and b.date = a.date + 1 and b.track_ref = a.track_ref
  group by a.artist_id, a.date
),
-- a day we already know was caught mid-publish is not a finding: the fix marks
-- it and reuses its date, which is the behaviour we want
open_days as (
  select artist_id, date from artist_daily_stats where provisional
)
select x.artist_id,
       x.date                        as d1,
       x.date + 1                    as d2,
       x.n_moved                     as moved_d1,
       y.n_moved                     as moved_d2,
       coalesce(b.moved_both, 0)     as moved_both
from by_day x
join by_day y on y.artist_id = x.artist_id and y.date = x.date + 1
left join both_days b on b.artist_id = x.artist_id and b.d1 = x.date
where not exists (select 1 from open_days o
                   where o.artist_id = x.artist_id and o.date in (x.date, x.date + 1));

\echo '=== what was swept ==='
select (select count(*) from tracked_artists)                  as artists_tracked,
       (select count(distinct artist_id) from _pairs)          as artists_with_data,
       (select count(*) from _pairs)                           as day_pairs_examined,
       (select min(d1) from _pairs)                            as from_date,
       (select max(d2) from _pairs)                            as to_date;

\echo ''
\echo '=== the test, proven to discriminate: a normal pair looks like this ==='
-- If this does not show moved_both close to moved_d1/moved_d2, the test is not
-- measuring what it claims and nothing below should be believed.
select coalesce(t.name, p.artist_id) as artist,
       round(avg(100.0 * p.moved_both / nullif(least(p.moved_d1, p.moved_d2), 0)), 1) as avg_pct_moved_both,
       count(*) as pairs
from _pairs p
left join tracked_artists t on t.spotify_artist_id = p.artist_id
where p.moved_d1 > 5 and p.moved_d2 > 5
group by 1 order by 1;

\echo ''
\echo '=== findings: day pairs that look like ONE publish written twice ==='
select coalesce(t.name, p.artist_id) as artist,
       p.d1, p.d2, p.moved_d1, p.moved_d2, p.moved_both,
       round(100.0 * p.moved_both / nullif(least(p.moved_d1, p.moved_d2), 0), 1) as pct_both
from _pairs p
left join tracked_artists t on t.spotify_artist_id = p.artist_id
where p.moved_d1 > 5 and p.moved_d2 > 5
  and p.moved_both <= greatest(1, least(p.moved_d1, p.moved_d2) / 10)
order by p.d1, artist;

do $$
declare
  n int; r record; msg text := '';
  thin int;
begin
  select count(*) into n from _pairs
   where moved_d1 > 5 and moved_d2 > 5
     and moved_both <= greatest(1, least(moved_d1, moved_d2) / 10);

  -- An artist with too few tracks can never trip the test; say so rather than
  -- letting it pass as "clean".
  select count(distinct artist_id) into thin from _pairs
   where artist_id not in (select artist_id from _pairs where moved_d1 > 5 and moved_d2 > 5);
  if thin > 0 then
    raise notice '% artist(s) have too few moving tracks for this test to apply — not covered.', thin;
  end if;

  if n = 0 then
    raise notice 'clean: no split publish in the last % days, across every tracked artist.', 60;
  else
    for r in
      select coalesce(t.name, p.artist_id) as artist, p.d1, p.d2, p.moved_d1, p.moved_d2, p.moved_both
      from _pairs p
      left join tracked_artists t on t.spotify_artist_id = p.artist_id
      where p.moved_d1 > 5 and p.moved_d2 > 5
        and p.moved_both <= greatest(1, least(p.moved_d1, p.moved_d2) / 10)
      order by p.d1, 1
    loop
      msg := msg || format(E'\n  %s: %s + %s — %s and %s tracks moved, but only %s on both',
                           r.artist, r.d1, r.d2, r.moved_d1, r.moved_d2, r.moved_both);
    end loop;
    raise exception E'% day pair(s) look like one publish written as two days:%\n\nFold them before the dates drift further — see supabase/migrations/repair_members_sep23_split_publish.sql for the shape of the repair. Check EVERY artist listed, not just the one that was noticed.', n, msg;
  end if;
end $$;

-- ── Stall check ─────────────────────────────────────────────────────────────
-- The fetch now HOLDS a half-published day rather than writing it provisionally
-- (fetch_artist_streams.py / fetch_group_streams.py). That removes the "+376
-- day" class of bug, but it introduces the opposite one: if a publish somehow
-- never looks finished, the fetch waits forever and days go missing quietly —
-- which reads as a quiet week rather than as a fault.
--
-- So assert the thing holding could break. 3 days is far outside anything
-- observed: across 58 days x 5 artists no recorded day has ever been more than
-- 1 day after the one before it, and the normal lag behind "yesterday" is 1 day
-- (checks/can_we_hold_unfinished_days.sql).
do $$
declare
  stale_after int := 3;
  n int;
  msg text := '';
  r record;
begin
  select count(*) into n
  from (
    select a.artist_id, max(a.date) as last_day
    from artist_daily_stats a
    join tracked_artists t on t.spotify_artist_id = a.artist_id
    group by a.artist_id
  ) x
  where (current_date - 1) - x.last_day > stale_after;

  if n = 0 then
    raise notice 'no stall: every tracked artist has a day recorded within % days of yesterday.', stale_after;
  else
    for r in
      select coalesce(t.name, x.artist_id) as artist, x.last_day,
             (current_date - 1) - x.last_day as days_behind
      from (
        select a.artist_id, max(a.date) as last_day
        from artist_daily_stats a
        join tracked_artists t2 on t2.spotify_artist_id = a.artist_id
        group by a.artist_id
      ) x
      left join tracked_artists t on t.spotify_artist_id = x.artist_id
      where (current_date - 1) - x.last_day > stale_after
      order by days_behind desc, 1
    loop
      msg := msg || format(E'\n  %s: last recorded %s — %s days behind yesterday',
                           r.artist, r.last_day, r.days_behind);
    end loop;
    raise exception E'% artist(s) have stopped recording days:%\n\nThe fetch holds a day it judges half-published, so a stuck publish-completeness check looks exactly like this. Read a fetch-catalog run log for the "still publishing: N/M tracks unchanged" line and check whether UNCHANGED_LIMIT is being tripped by something that is not actually a partial day.', n, msg;
  end if;
end $$;
