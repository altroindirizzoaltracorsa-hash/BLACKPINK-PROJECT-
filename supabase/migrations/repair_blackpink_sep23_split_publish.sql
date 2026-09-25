-- One-off repair: fold BLACKPINK's 2026-09-24 row back into 2026-09-23.
--
-- Spotify published one streaming day in two stages and our fetch wrote each
-- stage as its own day (fixed going forward by artist_daily_stats.provisional
-- and the reworked collapse_merged/snapshot_date_for). This cleans up the two
-- rows those runs left behind.
--
-- Evidence the two rows are one day:
--   * of 113 tracks, 62 moved only on the 23rd and 51 only on the 24th, and NOT
--     ONE moved on both — a real pair of days moves nearly every track twice;
--   * together they add +4,270,043, against +4,179,683 and +4,278,284 for the
--     clean days either side;
--   * kworb reads 17,826,374,976 across 109 tracks, which is our 22nd exactly.
-- Because every track moved exactly once across the pair, the COMBINED day is
-- complete — this repair loses nothing.
--
-- After it: one row dated 2026-09-23 carrying each track's latest value, its
-- delta measured against the 22nd, and no 2026-09-24 row at all.
--
-- Transactional and guarded: it refuses to run unless the table still looks
-- exactly as diagnosed, so a later fetch writing a real 2026-09-24 cannot be
-- silently swallowed. Re-running after success is a no-op (the guard sees no
-- 24th) rather than an error.

\set aid '41MozSoPIsD1dJM0CLPjZF'

begin;

-- ── preconditions ────────────────────────────────────────────────────────────
do $$
declare
  a23 record; a24 record; a22 record;
  moved_both int;
  newest date;
begin
  select * into a22 from artist_daily_stats
   where artist_id = '41MozSoPIsD1dJM0CLPjZF' and date = date '2026-09-22';
  select * into a23 from artist_daily_stats
   where artist_id = '41MozSoPIsD1dJM0CLPjZF' and date = date '2026-09-23';
  select * into a24 from artist_daily_stats
   where artist_id = '41MozSoPIsD1dJM0CLPjZF' and date = date '2026-09-24';

  if a24 is null then
    raise exception 'nothing to repair: no 2026-09-24 row (already done?)';
  end if;
  if a22 is null or a23 is null then
    raise exception 'the 22nd or 23rd is missing — not the situation this repairs';
  end if;

  select max(date) into newest from artist_daily_stats
   where artist_id = '41MozSoPIsD1dJM0CLPjZF';
  if newest <> date '2026-09-24' then
    raise exception 'a newer day (%) exists — a real fetch has run since; re-diagnose first', newest;
  end if;

  -- The signature: no track moved on both days.
  select count(*) into moved_both from (
    select d.track_ref
    from track_daily_stats d
    join artist_tracks t on t.id = d.track_ref
    where t.artist_id = '41MozSoPIsD1dJM0CLPjZF'
      and d.date in (date '2026-09-23', date '2026-09-24')
      and coalesce(d.daily_delta, 0) > 0
    group by d.track_ref having count(*) > 1
  ) x;
  if moved_both > 0 then
    raise exception '% track(s) moved on BOTH days — these are two real days, not one publish', moved_both;
  end if;

  raise notice 'before: 22nd=%  23rd=% (delta %)  24th=% (delta %)',
    a22.total_streams, a23.total_streams, a23.daily_delta, a24.total_streams, a24.daily_delta;
end $$;

-- ── 1. per-track: the 23rd takes the latest value, measured against the 22nd ──
update track_daily_stats d
set streams     = s.v24,
    daily_delta = s.v24 - s.v22
from (
  select d24.track_ref,
         d24.streams as v24,
         d22.streams as v22
  from track_daily_stats d24
  join artist_tracks t  on t.id = d24.track_ref
  join track_daily_stats d22
    on d22.track_ref = d24.track_ref and d22.date = date '2026-09-22'
  where t.artist_id = '41MozSoPIsD1dJM0CLPjZF' and d24.date = date '2026-09-24'
) s
where d.track_ref = s.track_ref and d.date = date '2026-09-23';

-- ── 2. drop the 24th's per-track rows ────────────────────────────────────────
delete from track_daily_stats d
using artist_tracks t
where t.id = d.track_ref
  and t.artist_id = '41MozSoPIsD1dJM0CLPjZF'
  and d.date = date '2026-09-24';

-- ── 3. the artist row: the 24th's totals, dated the 23rd ─────────────────────
-- track_count comes from the 24th (109 — the day collapse_merged got right),
-- not the 23rd's 111, which counted two merged versions twice.
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
    estimated               = false,
    provisional             = false
from artist_daily_stats n, artist_daily_stats p
where a.artist_id = '41MozSoPIsD1dJM0CLPjZF' and a.date = date '2026-09-23'
  and n.artist_id = a.artist_id and n.date = date '2026-09-24'
  and p.artist_id = a.artist_id and p.date = date '2026-09-22';

delete from artist_daily_stats
where artist_id = '41MozSoPIsD1dJM0CLPjZF' and date = date '2026-09-24';

-- ── 4. prove it ──────────────────────────────────────────────────────────────
do $$
declare r record; n int;
begin
  select count(*) into n from artist_daily_stats
   where artist_id = '41MozSoPIsD1dJM0CLPjZF' and date = date '2026-09-24';
  if n <> 0 then raise exception 'the 24th is still there'; end if;

  select * into r from artist_daily_stats
   where artist_id = '41MozSoPIsD1dJM0CLPjZF' and date = date '2026-09-23';
  raise notice 'after:  23rd=% (delta %, % tracks)', r.total_streams, r.daily_delta, r.track_count;

  if r.daily_delta <= 0 or r.daily_delta > 20000000 then
    raise exception 'repaired delta % is not a plausible single day', r.daily_delta;
  end if;
  if r.track_count <> 109 then
    raise exception 'expected 109 counted tracks, got %', r.track_count;
  end if;
end $$;

commit;

\echo ''
\echo '=== the days around the repair ==='
select date, total_streams, daily_delta, track_count, provisional
from artist_daily_stats
where artist_id = :'aid' and date >= date '2026-09-19'
order by date desc;
