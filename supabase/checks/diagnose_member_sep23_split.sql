-- READ-ONLY. Writes nothing, changes nothing, opens no transaction that could.
--
-- Question: did the four members get the same half-published Spotify day that
-- BLACKPINK got on 2026-09-23 — one streaming day written as two dated rows?
-- BLACKPINK's was repaired (migrations/repair_blackpink_sep23_split_publish.sql)
-- and the cause fixed going forward on the 25th (artist_daily_stats.provisional
-- plus the reworked collapse_merged/snapshot_date_for). The members were never
-- looked at, and /streams still shows JISOO at +336k on the 23rd against ~1.3M
-- on the days either side.
--
-- The test is the same one that justified the BLACKPINK repair, and it is the
-- only one that distinguishes a split publish from two genuinely quiet days:
--
--   A real pair of days moves nearly every track TWICE — once each day.
--   One publish split in half moves each track exactly ONCE across the pair.
--
-- So `moved_both` near zero means the two rows are one day. A high
-- `moved_both` means these are two real days and nothing should be touched.

\pset pager off

\echo '=== 1. the daily series per member, 19th → newest ==='
-- What the page draws. A split shows up as two adjacent low days whose sum is
-- one ordinary day.
select a.artist_id,
       coalesce(t.name, a.artist_id)          as artist,
       a.date,
       a.total_streams,
       a.daily_delta,
       a.track_count,
       a.provisional
from artist_daily_stats a
left join lateral (
  select name from tracked_artists where spotify_artist_id = a.artist_id limit 1
) t on true
where a.artist_id in (
        '6UZ0ba50XreR4TM8u322gs',  -- JISOO
        '250b0Wlc5Vk0CoUsaCY84M',  -- JENNIE
        '3eVa5w3URK5duf6eyVDbu9',  -- ROSÉ
        '5L1lO4eRHmJ7a0Q6csE5cT',  -- LISA
        '41MozSoPIsD1dJM0CLPjZF')  -- BLACKPINK, already repaired — the control
  and a.date >= date '2026-09-19'
order by a.artist_id, a.date;

\echo ''
\echo '=== 2. the signature: how many tracks moved on BOTH the 23rd and 24th ==='
-- moved_both = 0 (or near it) → one publish written as two days.
-- moved_both high            → two real days; leave them alone.
-- `pair_sum` is what the combined day would be; compare it with `before` and
-- `after`, the clean days either side.
with members(artist_id, who) as (
  values ('6UZ0ba50XreR4TM8u322gs', 'JISOO'),
         ('250b0Wlc5Vk0CoUsaCY84M', 'JENNIE'),
         ('3eVa5w3URK5duf6eyVDbu9', 'ROSÉ'),
         ('5L1lO4eRHmJ7a0Q6csE5cT', 'LISA')
),
moved as (
  select t.artist_id, d.track_ref, count(*) as days_moved
  from track_daily_stats d
  join artist_tracks t on t.id = d.track_ref
  where d.date in (date '2026-09-23', date '2026-09-24')
    and coalesce(d.daily_delta, 0) > 0
  group by t.artist_id, d.track_ref
)
select m.who,
       (select count(*) from moved x where x.artist_id = m.artist_id and x.days_moved > 1) as moved_both,
       (select count(*) from moved x where x.artist_id = m.artist_id)                      as moved_either,
       (select daily_delta from artist_daily_stats where artist_id = m.artist_id and date = date '2026-09-22') as before_22,
       (select daily_delta from artist_daily_stats where artist_id = m.artist_id and date = date '2026-09-23') as d23,
       (select daily_delta from artist_daily_stats where artist_id = m.artist_id and date = date '2026-09-24') as d24,
       (select daily_delta from artist_daily_stats where artist_id = m.artist_id and date = date '2026-09-23')
     + (select daily_delta from artist_daily_stats where artist_id = m.artist_id and date = date '2026-09-24') as pair_sum,
       (select daily_delta from artist_daily_stats where artist_id = m.artist_id and date = date '2026-09-25') as after_25
from members m
order by m.who;

\echo ''
\echo '=== 3. BROKEN — DO NOT READ. Use checks/sweep_split_publishes.sql ==='
-- This query cannot return a row, on any input. `b` is joined on
-- b.track_ref = a.track_ref, so moved_d2 counts only tracks that moved on BOTH
-- days — it is moved_both under another name. The filter then asks for
-- moved_d2 > 5 AND moved_both <= a tenth of that, i.e. moved_both > 5 and
-- moved_both <= 1. It printed "(0 rows)" for the 23rd/24th split it was aimed
-- at, and that empty result was reported as "no other occurrences".
--
-- Kept, not deleted, so the claim it produced can be traced back to it.
-- checks/sweep_split_publishes.sql computes the three counts separately, runs
-- over every tracked artist, and fails the run when it finds something.
with members(artist_id, who) as (
  values ('6UZ0ba50XreR4TM8u322gs', 'JISOO'),
         ('250b0Wlc5Vk0CoUsaCY84M', 'JENNIE'),
         ('3eVa5w3URK5duf6eyVDbu9', 'ROSÉ'),
         ('5L1lO4eRHmJ7a0Q6csE5cT', 'LISA'),
         ('41MozSoPIsD1dJM0CLPjZF', 'BLACKPINK')
),
per_day as (
  select t.artist_id, d.date, d.track_ref
  from track_daily_stats d
  join artist_tracks t on t.id = d.track_ref
  where d.date >= date '2026-08-01' and coalesce(d.daily_delta, 0) > 0
),
pairs as (
  select a.artist_id, a.date as d1, a.date + 1 as d2,
         count(distinct a.track_ref)                                      as moved_d1,
         count(distinct b.track_ref)                                      as moved_d2,
         count(distinct case when b.track_ref is not null then a.track_ref end) as moved_both
  from per_day a
  left join per_day b
    on b.artist_id = a.artist_id and b.date = a.date + 1 and b.track_ref = a.track_ref
  group by a.artist_id, a.date
)
select m.who, p.d1, p.d2, p.moved_d1, p.moved_d2, p.moved_both,
       round(100.0 * p.moved_both / nullif(least(p.moved_d1, p.moved_d2), 0), 1) as pct_both
from pairs p
join members m on m.artist_id = p.artist_id
where p.moved_d1 > 5 and p.moved_d2 > 5
  and p.moved_both <= greatest(1, least(p.moved_d1, p.moved_d2) / 10)
order by m.who, p.d1;

\echo ''
\echo '=== 4. sanity: what a NORMAL adjacent pair looks like, for contrast ==='
-- Same computation on the 20th→21st, which nobody has flagged. If this also
-- shows moved_both near zero then the test proves nothing and query 2 must not
-- be believed.
with members(artist_id, who) as (
  values ('6UZ0ba50XreR4TM8u322gs', 'JISOO'),
         ('250b0Wlc5Vk0CoUsaCY84M', 'JENNIE'),
         ('3eVa5w3URK5duf6eyVDbu9', 'ROSÉ'),
         ('5L1lO4eRHmJ7a0Q6csE5cT', 'LISA')
),
moved as (
  select t.artist_id, d.track_ref, count(*) as days_moved
  from track_daily_stats d
  join artist_tracks t on t.id = d.track_ref
  where d.date in (date '2026-09-20', date '2026-09-21')
    and coalesce(d.daily_delta, 0) > 0
  group by t.artist_id, d.track_ref
)
select m.who,
       (select count(*) from moved x where x.artist_id = m.artist_id and x.days_moved > 1) as moved_both_20_21,
       (select count(*) from moved x where x.artist_id = m.artist_id)                      as moved_either
from members m
order by m.who;
