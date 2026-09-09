-- Real per-country/global Spotify "Top Artists" chart positions (official
-- charts.spotify.com data -- rank, peak, streak, entry status), fetched via
-- a Vercel serverless function (not GitHub Actions -- Spotify's anti-bot layer
-- blocks GitHub Actions' IP ranges but not Vercel's). See api/proxy-image.js
-- ?charts=fetch-artists.
-- Run this once in the Supabase SQL editor.

create table if not exists artist_chart_positions (
  id                bigserial primary key,
  artist_spotify_id text not null references tracked_artists(spotify_artist_id),
  artist_name       text not null,
  country           text not null,
  chart_type        text not null, -- 'daily' or 'weekly'
  tracking_date     date not null,
  current_rank      int not null,
  previous_rank     int,
  peak_rank         int,
  streak            int, -- appearancesOnChart from the official API
  entry_status      text, -- NO_CHANGE / MOVED_UP / MOVED_DOWN / NEW / RE_ENTRY, as returned by Spotify
  entry_date        date,
  peak_date         date,
  image_url         text,
  created_at        timestamptz not null default now(),
  unique (artist_spotify_id, country, chart_type, tracking_date)
);

create index if not exists idx_artist_chart_positions_country_date
  on artist_chart_positions (chart_type, country, tracking_date desc, current_rank);

grant select, insert, update on public.artist_chart_positions to service_role;
grant usage, select on all sequences in schema public to service_role;
