-- 2026-11-20 — likes, comments and subscribers alongside the view counts.
--
-- COSTS NO EXTRA QUOTA. api/youtube-catalog.js already asks YouTube for
-- `part=statistics` on every video, which carries likeCount and commentCount
-- beside viewCount; both were parsed past and dropped. The channels call
-- already happens too and only needed `statistics` adding to its part list for
-- subscriberCount. Nothing new is requested — the data was arriving and being
-- thrown away, the same way daily_delta and hours_since were sitting unread
-- until the daily-gain work.
--
-- NULL IS NOT ZERO, in all three columns.
--   like_count    — null when the uploader hides likes.
--   comment_count — null when comments are turned off, which is common on a
--                   soundtrack upload and on anything a label locks down.
--   subscribers   — null when a channel hides its count.
-- A video with comments disabled has no comment count; it does not have zero
-- comments. Collapsing the two invents a fact, and the rate maths downstream
-- would then read a switch being flipped as every comment being deleted.
--
-- NO DISLIKES. YouTube stopped publishing the count in December 2021. There
-- is nothing to add and no third-party estimate belongs in a table that
-- otherwise holds measurements.
--
-- Idempotent; safe to re-run. Apply via the "Apply SQL" workflow with
--   file: supabase/migrations/youtube_likes_comments_subs.sql

alter table public.youtube_video_daily_stats
  add column if not exists like_count    bigint,
  add column if not exists comment_count bigint;

-- ── Channels, and their subscriber counts over time ────────────────────────
--
-- A SEPARATE TABLE, not a column on the video rows. Subscribers belong to a
-- channel, and there are ~170 videos across a handful of channels: writing the
-- same number onto every video of a channel every day would store it ~170
-- times and leave no single row to correct when one is wrong.
--
-- SUBSCRIBER COUNTS ARE ROUNDED BY YOUTUBE to three significant figures —
-- 95.8M, never 95,812,043 — and have been since 2019. So:
--   * the stored number is the rounded one; there is no finer one to be had,
--   * a day-over-day DELTA is mostly meaningless at this scale. The rounding
--     step on a 95.8M channel is 100,000, so a true gain of 20,000 a day shows
--     as five days of nothing and then a jump of 100,000. That is the rounding
--     being observed, not the fandom.
-- Hence no daily_delta column here, deliberately, unlike the video table. The
-- series is kept so the LEVEL can be charted over months, where the steps
-- average out; nothing downstream should divide one step by one day.
create table if not exists youtube_channels (
  id          bigserial   primary key,
  channel_id  text        not null unique,
  title       text,
  created_at  timestamptz not null default now()
);

create table if not exists youtube_channel_daily_stats (
  channel_ref bigint      not null references youtube_channels(id) on delete cascade,
  date        date        not null,
  subscribers bigint,                       -- null when the channel hides it
  captured_at timestamptz not null default now(),
  primary key (channel_ref, date)
);

create index if not exists youtube_channel_daily_date_idx
  on youtube_channel_daily_stats (date);

-- Written only by snapshot_youtube.py (service_role). RLS on with no policies
-- is what locks anon/authenticated out: Supabase grants those roles on every
-- NEW table in schema public by default, so withholding a grant is not enough.
alter table youtube_channels            enable row level security;
alter table youtube_channel_daily_stats enable row level security;
grant all privileges on table youtube_channels            to service_role;
grant all privileges on table youtube_channel_daily_stats to service_role;
grant usage, select on sequence youtube_channels_id_seq   to service_role;
