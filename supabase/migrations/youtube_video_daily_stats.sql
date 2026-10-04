-- Daily YouTube view counts per video, for the milestone board.
--
-- /api/youtube-catalog answers "where is everything right now". It cannot
-- answer "how fast", because a single reading has no past to compare against —
-- and the board sorts by SOONEST, which is a rate question. So the readings
-- have to be kept.
--
-- DELIBERATELY SEPARATE from the Spotify tables, for the same reason
-- group_track_daily_stats is separate from track_daily_stats: those carry
-- site-visible meaning and widening them is how a wrong row ends up on a page.
-- A YouTube video is not a Spotify track and shares no key with one.
--
--
-- THE DAY LABEL HERE IS NOT THE SPOTIFY DAY LABEL. Read this before copying
-- anything from fetch_group_streams.py.
--
-- Spotify publishes finalised days in batches, late and out of step with the
-- calendar, which is why that pipeline labels a reading "the next UNRECORDED
-- day" and catches up one day per run. YouTube does none of that: the view
-- count is a live counter that moves continuously, so a reading is simply the
-- state at the moment it was taken. The label is therefore the UTC date of the
-- reading, full stop. A run that finds nothing new is not "waiting for a
-- publish", it is a run that failed.
--
--
-- captured_at is load-bearing, not bookkeeping. Two readings 20 hours apart and
-- two 28 hours apart both look like "one day" to a date column, and a rate
-- computed from the date alone is wrong by up to 40% on a delayed run — and
-- GitHub delays scheduled runs on this repo by hours. With the timestamp the
-- rate is (views gained) / (hours elapsed), which is immune to that.
--
-- Run once. Safe to re-run.

create table if not exists youtube_videos (
  id           bigserial primary key,
  video_id     text        not null unique,   -- the YouTube id, the natural key
  title        text,
  channel      text,
  channel_id   text,

  -- mv / performance / live / audio / lyric / short / variety / behind / other.
  -- DERIVED on every run from the title and duration, never declared, so
  -- re-classifying only changes what the board shows and never what is stored:
  -- the snapshot records everything above the floor regardless of kind, and the
  -- filtering happens at read time. A video reclassified next month still has
  -- its whole history.
  kind         text,
  duration_sec int,
  published_at timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists youtube_videos_kind_idx    on youtube_videos (kind);
create index if not exists youtube_videos_channel_idx on youtube_videos (channel_id);

create table if not exists youtube_video_daily_stats (
  video_ref   bigint      not null references youtube_videos(id) on delete cascade,
  date        date        not null,
  views       bigint      not null,

  -- Against the previous row for this video, whenever that was. NULL on the
  -- first reading.
  --
  -- MAY BE NEGATIVE, and that is not corruption. YouTube recounts continuously
  -- and takes totals back down; api/youtube-stats.js already handles a
  -- milestone being crossed more than once for exactly this reason. Anything
  -- reading this column must cope with a negative, and must not "fix" it.
  daily_delta bigint,

  -- Hours since the previous reading, so a rate is delta/hours rather than
  -- delta/"a day". NULL on the first reading.
  hours_since numeric(8,3),

  captured_at timestamptz not null default now(),

  primary key (video_ref, date)
);

create index if not exists youtube_video_daily_date_idx on youtube_video_daily_stats (date);

-- A per-video rate, over a SPAN rather than an average of daily deltas.
--
-- This is the Magnetic lesson, and it is worse here. Averaging the deltas gives
-- every reading equal weight however far apart they are, so one delayed run
-- (common: GitHub has delayed crons on this repo by 2-5 hours) drags the mean
-- in whichever direction the gap fell. Views gained between two readings,
-- divided by the hours actually elapsed, cannot be fooled that way — and
-- because view counts are cumulative, a missing day inside the span costs
-- nothing at all.
create or replace view youtube_video_rates as
with bounds as (
  select video_ref,
         min(captured_at) as first_at,
         max(captured_at) as last_at,
         count(*)         as readings
    from youtube_video_daily_stats
   group by video_ref
)
select v.id            as video_ref,
       v.video_id,
       v.title,
       v.channel,
       v.kind,
       b.readings,
       f.views         as first_views,
       l.views         as latest_views,
       b.first_at,
       b.last_at,
       extract(epoch from (b.last_at - b.first_at)) / 86400.0 as span_days,
       case
         when b.readings < 2 then null
         when b.last_at <= b.first_at then null
         else (l.views - f.views)
              / (extract(epoch from (b.last_at - b.first_at)) / 86400.0)
       end             as views_per_day
  from youtube_videos v
  join bounds b                   on b.video_ref = v.id
  join youtube_video_daily_stats f on f.video_ref = v.id and f.captured_at = b.first_at
  join youtube_video_daily_stats l on l.video_ref = v.id and l.captured_at = b.last_at;

-- Written only by snapshot_youtube.py (service_role). RLS on with no policies is
-- what locks anon/authenticated out: Supabase grants those roles on every NEW
-- table in schema public by default, so withholding a grant is not enough.
alter table youtube_videos            enable row level security;
alter table youtube_video_daily_stats enable row level security;
grant all privileges on table youtube_videos            to service_role;
grant all privileges on table youtube_video_daily_stats to service_role;
grant usage, select on sequence youtube_videos_id_seq   to service_role;
grant select on youtube_video_rates to service_role;

do $$
declare n_v int; n_s int;
begin
  select count(*) into n_v from youtube_videos;
  select count(*) into n_s from youtube_video_daily_stats;
  raise notice 'youtube_videos: % video(s), % reading(s).', n_v, n_s;
end $$;
