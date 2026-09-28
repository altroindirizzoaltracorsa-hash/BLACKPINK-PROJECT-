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
--        * three independent fan trackers agree — LISA's 23rd reads 4,164,232
--          daily and JENNIE's 7,714,281, against our pair sums above, and
--          ROSÉ's two consecutive snapshots differ by 4,102,517 against our
--          pair sum of 4,107,723 (0.13%, the same scope offset her clean days
--          carry).
--
--   2. Because the split was never folded, every date AFTER it is a day late.
--      LISA's tracker settles this exactly:
--        our 2026-09-25 total 5,577,828,916 = her tracker's 24th, to the stream
--        our 2026-09-26 total 5,581,859,101 = her tracker's 25th, to the stream
--        our 2026-09-27 total 5,585,692,782 = her tracker's 26th, to the stream
--      and it is why the members carry one more row than BLACKPINK, whose own
--      dates were never shifted (its 24th was the newest row when it was
--      repaired, so there was nothing after it to drag along).
--
-- So: fold the 24th into the 23rd, then shift every later day back by one.
-- Afterwards each member ends one day earlier, level with BLACKPINK, and the
-- next fetch appends the correct date.
--
-- Deltas need no recomputation in step 2: each is a difference from the row
-- before it, and no VALUE changes there — only the label on it.
--
-- The shift is deliberately NOT written as a fixed list of dates. A fetch runs
-- nightly and again in the small hours, so the number of days trailing the
-- split changes while this is being reviewed. It shifts whatever is there.
--
-- Safety:
--   * one transaction; any failed guard rolls the whole thing back;
--   * every affected row is copied into *_backup_sep23repair first, so this is
--     reversible even after it commits;
--   * it refuses unless the data still reads exactly as diagnosed — pinned on
--     LISA's own totals rather than on the newest date, so a fetch landing
--     mid-review does not block the repair but a CHANGED READING does;
--   * the split signature and the known-normal control pair are both re-checked
--     here rather than trusted from the diagnostic run;
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

-- how far the shift reaches and what it should look like afterwards, recorded
-- before anything moves
create temporary table _plan(
  artist_id text primary key, who text,
  newest_before date, rows_before int
) on commit drop;

-- ── preconditions ────────────────────────────────────────────────────────────
do $$
declare
  m record;
  n_both int; n_either int; n_control int;
  newest date; n_days int; n_rows int;
  d22 bigint; d23 bigint; d24 bigint;
  v bigint;
begin
  -- The anchor. LISA's totals are the figures a third party publishes and we
  -- match to the stream, so they identify the exact rows this was diagnosed
  -- against — and unlike "the newest row is the 27th", they stay true when
  -- another night's fetch appends a day.
  select total_streams into v from artist_daily_stats
   where artist_id = '5L1lO4eRHmJ7a0Q6csE5cT' and date = date '2026-09-25';
  if v is distinct from 5569560609 + 1134584 + 3029672 + 4104051 then  -- 5,577,828,916
    raise exception 'LISA 2026-09-25 total is % — expected 5,577,828,916. The data is not what supabase/checks/diagnose_member_sep23_split.sql looked at; re-run it before repairing.', v;
  end if;
  select total_streams into v from artist_daily_stats
   where artist_id = '5L1lO4eRHmJ7a0Q6csE5cT' and date = date '2026-09-23';
  if v is distinct from 5570695193 then
    raise exception 'LISA 2026-09-23 total is % — expected 5,570,695,193 (the first half of the split). Refusing.', v;
  end if;
  select total_streams into v from artist_daily_stats
   where artist_id = '5L1lO4eRHmJ7a0Q6csE5cT' and date = date '2026-09-24';
  if v is distinct from 5573724865 then
    raise exception 'LISA 2026-09-24 total is % — expected 5,573,724,865 (the second half of the split). Refusing.', v;
  end if;

  for m in select * from _members loop
    select max(date), count(*) into newest, n_rows
      from artist_daily_stats where artist_id = m.artist_id;
    if newest is null then
      raise exception '% has no rows at all', m.who;
    end if;
    if newest < date '2026-09-26' then
      raise exception '% ends on % — nothing after the split to un-shift. Not the situation this repairs.', m.who, newest;
    end if;

    -- the shape: the split pair, the day before it, and an unbroken run of
    -- days after it. A gap would mean the shift is walking over something this
    -- was not diagnosed against.
    select count(*) into n_days from artist_daily_stats
     where artist_id = m.artist_id and date between date '2026-09-22' and newest;
    if n_days <> (newest - date '2026-09-22') + 1 then
      raise exception '% has % rows between the 22nd and % — expected % (a gap in the run). Refusing.',
        m.who, n_days, newest, (newest - date '2026-09-22') + 1;
    end if;

    -- The signature. This is the whole basis of the repair.
    select count(*) into n_both from (
      select d.track_ref
      from track_daily_stats d
      join artist_tracks t on t.id = d.track_ref
      where t.artist_id = m.artist_id
        and d.date in (date '2026-09-23', date '2026-09-24')
        and coalesce(d.daily_delta, 0) > 0
      group by d.track_ref having count(*) > 1
    ) x;
    select count(distinct d.track_ref) into n_either
      from track_daily_stats d
      join artist_tracks t on t.id = d.track_ref
      where t.artist_id = m.artist_id
        and d.date in (date '2026-09-23', date '2026-09-24')
        and coalesce(d.daily_delta, 0) > 0;
    if n_both > 0 then
      raise exception '% — % track(s) moved on BOTH the 23rd and 24th. Those are two real days, not one publish. Refusing.', m.who, n_both;
    end if;
    if n_either < 5 then
      raise exception '% — only % track(s) moved across the 23rd/24th at all. Too little to read a signature from. Refusing.', m.who, n_either;
    end if;

    -- The control: on a pair nobody has flagged, nearly every track must move
    -- on both days. If it does not, the test above proves nothing and must not
    -- be acted on.
    select count(*) into n_control from (
      select d.track_ref
      from track_daily_stats d
      join artist_tracks t on t.id = d.track_ref
      where t.artist_id = m.artist_id
        and d.date in (date '2026-09-20', date '2026-09-21')
        and coalesce(d.daily_delta, 0) > 0
      group by d.track_ref having count(*) > 1
    ) x;
    if n_control < n_either / 2 then
      raise exception '% — the known-normal 20th/21st pair shows only % track(s) moving on both, against % across the split pair. The test does not discriminate here; refusing.', m.who, n_control, n_either;
    end if;

    insert into _plan values (m.artist_id, m.who, newest, n_rows);

    select daily_delta into d22 from artist_daily_stats where artist_id = m.artist_id and date = date '2026-09-22';
    select daily_delta into d23 from artist_daily_stats where artist_id = m.artist_id and date = date '2026-09-23';
    select daily_delta into d24 from artist_daily_stats where artist_id = m.artist_id and date = date '2026-09-24';
    raise notice 'before  %: 22nd +%  23rd +%  24th +%  (pair %)  ·  split 0/% moved both, control %/% · newest %',
      m.who, d22, d23, d24, d23 + d24, n_either, n_control, n_either, newest;
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
select a.* from artist_daily_stats a join _plan p on p.artist_id = a.artist_id
where a.date >= date '2026-09-22';

insert into track_daily_stats_backup_sep23repair
select d.* from track_daily_stats d
join artist_tracks t on t.id = d.track_ref
join _plan p on p.artist_id = t.artist_id
where d.date >= date '2026-09-22';

-- ── 1. fold the 24th into the 23rd ───────────────────────────────────────────
-- per track: the 23rd takes the 24th's value, measured against the 22nd
update track_daily_stats d
set streams     = s.v24,
    daily_delta = s.v24 - s.v22
from (
  select d24.track_ref, d24.streams as v24, d22.streams as v22
  from track_daily_stats d24
  join artist_tracks t   on t.id = d24.track_ref
  join _plan p           on p.artist_id = t.artist_id
  join track_daily_stats d22
    on d22.track_ref = d24.track_ref and d22.date = date '2026-09-22'
  where d24.date = date '2026-09-24'
) s
where d.track_ref = s.track_ref and d.date = date '2026-09-23';

delete from track_daily_stats d
using artist_tracks t, _plan p
where t.id = d.track_ref and p.artist_id = t.artist_id
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
from artist_daily_stats n, artist_daily_stats p, _plan pl
where a.artist_id = pl.artist_id and a.date = date '2026-09-23'
  and n.artist_id = a.artist_id and n.date = date '2026-09-24'
  and p.artist_id = a.artist_id and p.date = date '2026-09-22';

delete from artist_daily_stats a
using _plan p
where p.artist_id = a.artist_id and a.date = date '2026-09-24';

-- ── 2. shift every day after it back by one ──────────────────────────────────
-- One date at a time, ascending: the 24th is free (just deleted), so the 25th
-- lands on it, which frees the 25th for the 26th, and so on. Doing the whole
-- range in one UPDATE would risk a transient primary-key collision depending on
-- row order, and doing it as a fixed list of dates would go stale every time a
-- fetch appends a day.
do $$
declare dd date;
begin
  for dd in
    select distinct a.date from artist_daily_stats a join _plan p on p.artist_id = a.artist_id
     where a.date >= date '2026-09-25'
    union
    select distinct d.date from track_daily_stats d
      join artist_tracks t on t.id = d.track_ref
      join _plan p on p.artist_id = t.artist_id
     where d.date >= date '2026-09-25'
    order by 1
  loop
    update track_daily_stats d set date = dd - 1
    from artist_tracks t, _plan p
    where t.id = d.track_ref and p.artist_id = t.artist_id and d.date = dd;

    update artist_daily_stats a set date = dd - 1
    from _plan p where p.artist_id = a.artist_id and a.date = dd;

    raise notice 'shifted % → %', dd, dd - 1;
  end loop;
end $$;

-- ── 3. prove it ──────────────────────────────────────────────────────────────
do $$
declare
  p record; r record; newest date; n int; v bigint; prev bigint;
begin
  for p in select * from _plan order by who loop
    select max(date), count(*) into newest, n
      from artist_daily_stats where artist_id = p.artist_id;

    if newest <> p.newest_before - 1 then
      raise exception '% now ends on % — expected % (one day earlier than before)',
        p.who, newest, p.newest_before - 1;
    end if;
    if n <> p.rows_before - 1 then
      raise exception '% has % rows — expected % (exactly one fewer: two halves became one day)',
        p.who, n, p.rows_before - 1;
    end if;
    if exists (select 1 from artist_daily_stats
                where artist_id = p.artist_id and date = p.newest_before) then
      raise exception '% still has a row on %', p.who, p.newest_before;
    end if;

    -- every day from the folded one onwards must still be a real, rising day
    prev := null;
    for r in
      select date, total_streams, daily_delta from artist_daily_stats
       where artist_id = p.artist_id and date between date '2026-09-23' and newest
       order by date
    loop
      if r.daily_delta is null or r.daily_delta <= 0 then
        raise exception '% % has a non-positive delta %', p.who, r.date, r.daily_delta;
      end if;
      if prev is not null and r.total_streams <= prev then
        raise exception '% % total % is not above the day before (%)', p.who, r.date, r.total_streams, prev;
      end if;
      prev := r.total_streams;
      raise notice 'after   % %: total % (+%)', p.who, r.date, r.total_streams, r.daily_delta;
    end loop;
  end loop;

  -- The figures a third party can check us against, to the stream.
  select total_streams into v from artist_daily_stats
   where artist_id = '5L1lO4eRHmJ7a0Q6csE5cT' and date = date '2026-09-24';
  if v is distinct from 5577828916 then
    raise exception 'LISA 24th is % — expected 5,577,828,916 (her tracker''s 24th)', v;
  end if;
  select total_streams into v from artist_daily_stats
   where artist_id = '5L1lO4eRHmJ7a0Q6csE5cT' and date = date '2026-09-25';
  if v is distinct from 5581859101 then
    raise exception 'LISA 25th is % — expected 5,581,859,101 (her tracker''s 25th)', v;
  end if;
  raise notice 'LISA lines up with her tracker on both the 24th and the 25th, to the stream.';

  -- BLACKPINK was repaired separately and must not have moved.
  select count(*) into n from artist_daily_stats
   where artist_id = '41MozSoPIsD1dJM0CLPjZF' and date = date '2026-09-23'
     and total_streams = 17830645019 and daily_delta = 4270043;
  if n <> 1 then
    raise exception 'BLACKPINK 23rd no longer reads 17,830,645,019 (+4,270,043) — it should not have been touched';
  end if;
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
\echo 'track_daily_stats_backup_sep23repair — delete from 2026-09-22 onwards for'
\echo 'these four artists and re-insert from those tables.'
