-- READ-ONLY. Did the first YouTube snapshot actually land, and is it shaped
-- the way the board needs?
--
-- The script reports what it believes it wrote. This asks the database.

\echo ''
\echo '=== readings per day'
select date,
       count(*)                                    as rows,
       count(*) filter (where daily_delta is null) as first_readings,
       count(*) filter (where daily_delta > 0)     as up,
       count(*) filter (where daily_delta < 0)     as down,
       min(captured_at)                            as captured
  from youtube_video_daily_stats
 group by date
 order by date desc
 limit 10;

\echo ''
\echo '=== what was recorded, by kind — the board shows only mv + performance,'
\echo '    the snapshot keeps everything so a later change of mind has history'
select v.kind, count(*) as videos, to_char(max(s.views), 'FM999,999,999,999') as biggest
  from youtube_video_daily_stats s
  join youtube_videos v on v.id = s.video_ref
 where s.date = (select max(date) from youtube_video_daily_stats)
 group by v.kind
 order by videos desc;

\echo ''
\echo '=== closest to a milestone among the kinds the board shows'
select v.title, v.channel, v.kind,
       to_char(s.views, 'FM999,999,999,999') as views,
       to_char((ceil((s.views + 1) / 100000000.0) * 100000000) - s.views,
               'FM999,999,999') as gap_to_next
  from youtube_video_daily_stats s
  join youtube_videos v on v.id = s.video_ref
 where s.date = (select max(date) from youtube_video_daily_stats)
   and v.kind in ('mv', 'performance')
 order by (ceil((s.views + 1) / 100000000.0) * 100000000) - s.views
 limit 8;

\echo ''
\echo '=== rates: still empty, and that is correct on one reading'
select count(*)                                          as videos_in_view,
       count(*) filter (where views_per_day is not null) as with_a_rate,
       max(readings)                                     as max_readings
  from youtube_video_rates;
