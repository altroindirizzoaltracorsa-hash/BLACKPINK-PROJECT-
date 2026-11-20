-- READ-ONLY. How much YouTube history actually exists?
--
-- Asked before building a history view with daily / weekly / monthly / yearly
-- tabs on it. kworb has years; this table was created on 2026-10-14, so the
-- honest answer decides which of those tabs can exist at all rather than
-- showing an empty panel or, worse, a "year" computed from five weeks.
--
-- Nothing here writes. SELECTs only.

\echo ''
\echo '=== the whole span'
select min(date)                                   as first_day,
       max(date)                                   as last_day,
       (max(date) - min(date)) + 1                 as calendar_days,
       count(distinct date)                        as days_with_readings,
       count(*)                                    as rows,
       count(distinct video_ref)                   as videos
  from youtube_video_daily_stats;

\echo ''
\echo '=== readings per video — how many have enough for a weekly/monthly view'
select readings_bucket, count(*) as videos from (
  select video_ref,
         case when count(*) >= 60 then '60+'
              when count(*) >= 30 then '30-59'
              when count(*) >= 14 then '14-29'
              when count(*) >= 7  then '7-13'
              when count(*) >= 2  then '2-6'
              else '1' end as readings_bucket
    from youtube_video_daily_stats
   group by video_ref
) t group by readings_bucket order by readings_bucket desc;

\echo ''
\echo '=== gaps: a day with no reading at all breaks a naive day-over-day view'
select d::date as missing_day
  from generate_series(
         (select min(date) from youtube_video_daily_stats),
         (select max(date) from youtube_video_daily_stats),
         interval '1 day') d
 where d::date not in (select distinct date from youtube_video_daily_stats)
 order by 1;

\echo ''
\echo '=== how complete each day is, newest first (a partial day reads as a dip)'
select date,
       count(*)                                    as videos_read,
       count(*) filter (where daily_delta is null) as first_readings,
       round(avg(hours_since)::numeric, 1)         as avg_hours_since,
       min(captured_at)                            as captured
  from youtube_video_daily_stats
 group by date
 order by date desc
 limit 14;
