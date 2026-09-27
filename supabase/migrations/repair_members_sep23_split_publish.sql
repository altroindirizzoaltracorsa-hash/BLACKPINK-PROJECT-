-- One-off repair: the four members got the same half-published Spotify day
-- BLACKPINK got on 2026-09-23, and nobody folded theirs.
--
-- Two separate faults, both from the code as it stood before 2026-09-25:
--
--   1. One streaming day was written as TWO dated rows (the 23rd and the 24th).
--      Evidence, from supabase/checks/diagnose_member_sep23_split.sql:
--        * NOT ONE track moved on both days, for any of the four — 0 of 13, 0
--          of 43, 0 of 32, 0 of 19. On the known-normal 20th→21st pair EVERY
--          track moved on both (13/13, 43/43, 32/32, 19/19), so the test
--          discriminates rather than firing on everything;
--        * each pair sums to an ordinary day: LISA 4,164,256 against 4,242,322
--          and 4,104,051 either side; JENNIE 7,712,877 against 7,697,307 and
--          7,668,629;
--        * two independent fan trackers agree — LISA's 23rd reads 4,164,232
--          daily and JENNIE's 7,714,281, against our pair sums above.
--
--   2. Because the split was never folded, every date AFTER it is a day late.
--      The same trackers settle this exactly:
--        our 2026-09-25 total 5,577,828,916 = LISA tracker's 24th, to the stream
--        our 2026-09-26 total 5,581,859,101 = LISA tracker's 25th, to the stream
--      and it is why the members carry one more row than BLACKPINK, whose own
--      dates were never shifted (its 24th was the newest row when it was
--      repaired, so there was nothing after it to drag along).
--
-- So: fold the 24th into the 23rd, then shift the 25th→24th and the 26th→25th.
-- Afterwards each member ends on 2026-09-25, level with BLACKPINK, and tonight's
-- fetch writes a 26th as it should.
--
-- Deltas need no recomputation in step 2: each is a difference from the row
-- before it, and no VALUE changes there — only the label on it.
--
-- Safety:
--   * one transaction; any failed guard rolls the whole thing back;
--   * every affected row is copied into *_backup_sep23repair first, so this is
--     reversible even after it commits;
--   * it refuses to run unless the tables still look exactly as diagnosed —
--     if tonight's fetch has landed, it aborts and asks for a re-diagnosis
--     rather than shifting a date it has not looked at;
--   * BLACKPINK is untouched: its id is not in the list.

\set ON_ERROR_STOP on
\pset pager off

begin;

-- ── who ──────────────────────────────────────────────────────────────────────
create temporary table _members(artist_id text primary key, who text) on commit drop;
insert into _members values
  ('6UZ0ba50XreR4TM8u322gs', 'JISOO'),
  ('250b0Wlc5Vk0CoUsaCY84M', 'JENNIE'),
  ('3eVa5w3URK5duf6eyVDbu9', 'ROSÉ'),
  ('5L1lO4eRHmJ7a0Q6csE5cT', 'LISA');

-- ── preconditions ────────────────────────────────────────────────────────────
do $$
declare
  m record;
  n_both int;
  newest date;
  d22 bigint; d23 bigint; d24 bigint;
begin
  for m in select * from _members loop
    select max(date) into newest from artist_daily_stats where artist_id = m.artist_id;
    if newest is null then
      raise exception '% has no rows at all', m.who;
    end if;
    if newest <> date '2026-09-26' then
      raise exception '% newest row is % — expected 2026-09-26. A fetch has run since this was diagnosed; re-run supabase/checks/diagnose_member_sep23_split.sql before repairing.', m.who, newest;
    end if;

    if not exists (select 1 from artist_daily_stats where artist_id = m.artist_id and date = date '2026-09-22')
    or not exists (select 1 from artist_daily_stats where artist_id = m.artist_id and date = date '2026-09-23')
    or not exists (select 1 from artist_daily_stats where artist_id = m.artist_id and date = date '2026-09-24')
    or not exists (select 1 from artist_daily_stats where artist_id = m.artist_id and date = date '2026-09-25')
    or not exists (select 1 from artist_daily_stats where artist_id = m.artist_id and date = date '2026-09-26') then
      raise exception '% is missing one of the 22nd–26th — not the situation this repairs', m.who;
    end if;

    -- The signature. This is the whole basis of the repair, so it is re-checked
    -- here rather than trusted from the diagnostic run.
    select count(*) into n_both from (
      select d.track_ref
      from track_daily_stats d
      join artist_tracks t on t.id = d.track_ref
      where t.artist_id = m.artist_id
        and d.date in (date '2026-09-23', date '2026-09-24')
        and coalesce(d.daily_delta, 0) > 0
      group by d.track_ref having count(*) > 1
    ) x;
    if n_both > 0 then
      raise exception '% — % track(s) moved on BOTH the 23rd and 24th. Those are two real days, not one publish. Refusing.', m.who, n_both;
    end if;

    select daily_delta into d22 from artist_daily_stats where artist_id = m.artist_id and date = date '2026-09-22';
    select daily_delta into d23 from artist_daily_stats where artist_id = m.artist_id and date = date '2026-09-23';
    select daily_delta into d24 from artist_daily_stats where artist_id = m.artist_id and date = date '2026-09-24';
    raise notice 'before  %: 22nd +%  23rd +%  24th +%  (pair %)', m.who, d22, d23, d24, d23 + d24;
  end loop;
end $$;

-- ── backup, before anything is touched ───────────────────────────────────────
create table if not exists artist_daily_stats_backup_sep23repair
  (like artist_daily_stats including all);
create table if not exists track_daily_stats_backup_sep23repair
  (like track_daily_stats including all);

do $$
begin
  if exists (select 1 from artist_daily_stats_backup_sep23repair) then
    raise exception 'a backup from a previous run already exists — this repair has been applied before. Inspect artist_daily_stats_backup_sep23repair first.';
  end if;
end $$;

insert into artist_daily_stats_backup_sep23repair
select a.* from artist_daily_stats a join _members m on m.artist_id = a.artist_id
where a.date between date '2026-09-22' and date '2026-09-26';

insert into track_daily_stats_backup_sep23repair
select d.* from track_daily_stats d
join artist_tracks t on t.id = d.track_ref
join _members m on m.artist_id = t.artist_id
where d.date between date '2026-09-22' and date '2026-09-26';

-- ── 1. fold the 24th into the 23rd ───────────────────────────────────────────
-- per track: the 23rd takes the 24th's value, measured against the 22nd
update track_daily_stats d
set streams     = s.v24,
    daily_delta = s.v24 - s.v22
from (
  select d24.track_ref, d24.streams as v24, d22.streams as v22
  from track_daily_stats d24
  join artist_tracks t   on t.id = d24.track_ref
  join _members m        on m.artist_id = t.artist_id
  join track_daily_stats d22
    on d22.track_ref = d24.track_ref and d22.date = date '2026-09-22'
  where d24.date = date '2026-09-24'
) s
where d.track_ref = s.track_ref and d.date = date '2026-09-23';

delete from track_daily_stats d
using artist_tracks t, _members m
where t.id = d.track_ref and m.artist_id = t.artist_id
  and d.date = date '2026-09-24';

-- the artist row: the 24th's figures, dated the 23rd, delta against the 22nd
update artist_daily_stats a
set total_streams           = n.total_streams,
    daily_delta             = n.total_streams - p.total_streams,
    followers               = n.followers,
    followers_delta         = n.followers - p.followers,
    monthly_listeners       = n.monthly_listeners,
    monthly_listeners_delta = n.monthly_listeners - p.monthly_listeners,
    world_rank              = n.world_rank,
    world_rank_delta        = n.world_rank - p.world_rank,
    track_count             = n.track_count,
    provisional             = false
from artist_daily_stats n, artist_daily_stats p, _members m
where a.artist_id = m.artist_id and a.date = date '2026-09-23'
  and n.artist_id = a.artist_id and n.date = date '2026-09-24'
  and p.artist_id = a.artist_id and p.date = date '2026-09-22';

delete from artist_daily_stats a
using _members m
where a.artist_id = m.artist_id and a.date = date '2026-09-24';

-- ── 2. shift the days after it back by one ───────────────────────────────────
-- Ascending order, one statement each: the 24th is free (just deleted) so
-- 25→24 lands, which frees the 25th for 26→25. Doing both in one UPDATE would
-- risk a transient primary-key collision depending on row order.
update track_daily_stats d set date = date '2026-09-24'
from artist_tracks t, _members m
where t.id = d.track_ref and m.artist_id = t.artist_id and d.date = date '2026-09-25';
update artist_daily_stats a set date = date '2026-09-24'
from _members m where m.artist_id = a.artist_id and a.date = date '2026-09-25';

update track_daily_stats d set date = date '2026-09-25'
from artist_tracks t, _members m
where t.id = d.track_ref and m.artist_id = t.artist_id and d.date = date '2026-09-26';
update artist_daily_stats a set date = date '2026-09-25'
from _members m where m.artist_id = a.artist_id and a.date = date '2026-09-26';

-- ── 3. prove it ──────────────────────────────────────────────────────────────
do $$
declare
  m record; r record; newest date; n int; v bigint;
begin
  for m in select * from _members loop
    select max(date) into newest from artist_daily_stats where artist_id = m.artist_id;
    if newest <> date '2026-09-25' then
      raise exception '% now ends on % — expected 2026-09-25', m.who, newest;
    end if;

    select count(*) into n from artist_daily_stats
     where artist_id = m.artist_id and date = date '2026-09-26';
    if n <> 0 then raise exception '% still has a 26th', m.who; end if;

    for r in
      select date, total_streams, daily_delta from artist_daily_stats
       where artist_id = m.artist_id and date between date '2026-09-23' and date '2026-09-25'
       order by date
    loop
      if r.daily_delta is null or r.daily_delta <= 0 then
        raise exception '% % has a non-positive delta %', m.who, r.date, r.daily_delta;
      end if;
      raise notice 'after   % %: total % (+%)', m.who, r.date, r.total_streams, r.daily_delta;
    end loop;
  end loop;

  -- The two figures a third party can check us against, to the stream.
  select total_streams into v from artist_daily_stats
   where artist_id = '5L1lO4eRHmJ7a0Q6csE5cT' and date = date '2026-09-24';
  if v <> 5577828916 then
    raise exception 'LISA 24th is % — expected 5,577,828,916 (her tracker''s 24th)', v;
  end if;
  select total_streams into v from artist_daily_stats
   where artist_id = '5L1lO4eRHmJ7a0Q6csE5cT' and date = date '2026-09-25';
  if v <> 5581859101 then
    raise exception 'LISA 25th is % — expected 5,581,859,101 (her tracker''s 25th)', v;
  end if;
  raise notice 'LISA lines up with her tracker on both the 24th and the 25th, to the stream.';
end $$;

commit;

\echo ''
\echo '=== the repaired series ==='
select coalesce(t.name, a.artist_id) as artist, a.date, a.total_streams, a.daily_delta, a.track_count
from artist_daily_stats a
left join tracked_artists t on t.spotify_artist_id = a.artist_id
where a.artist_id in ('6UZ0ba50XreR4TM8u322gs','250b0Wlc5Vk0CoUsaCY84M',
                      '3eVa5w3URK5duf6eyVDbu9','5L1lO4eRHmJ7a0Q6csE5cT',
                      '41MozSoPIsD1dJM0CLPjZF')
  and a.date >= date '2026-09-20'
order by artist, a.date;

\echo ''
\echo '=== to undo, if it ever has to be undone ==='
\echo 'The original rows are in artist_daily_stats_backup_sep23repair and'
\echo 'track_daily_stats_backup_sep23repair — delete 2026-09-22..26 for these'
\echo 'four artists and re-insert from those tables.'
