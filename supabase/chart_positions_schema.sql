-- Real per-country Spotify chart positions for BLACKPINK + members.
-- Source: kworb.net's daily Top 200 mirror per country (kworb.net/spotify/country/{code}_daily.html),
-- which mirrors Spotify's own official charts -- NOT our own tracked-catalog streams-gained ranking.
-- Run this once in the Supabase SQL editor before the fetch job or API endpoint are used.

create table if not exists chart_positions (
  id                      bigserial primary key,
  spotify_track_id        text not null,
  track_name              text not null,
  primary_artist_id       text not null references tracked_artists(spotify_artist_id),
  primary_artist_name     text not null,
  featured_artists        text[],
  country                 text not null,
  chart_type              text not null default 'daily', -- 'daily' or 'weekly'
  tracking_date           date not null,
  position                int not null,
  peak_position           int,
  days_on_chart           int, -- days on chart for 'daily' rows, WEEKS on chart for 'weekly' rows
  streams                 bigint,
  total_streams           bigint,
  previous_position       int,
  position_change         int,
  entry_status            text,
  created_at              timestamptz not null default now(),
  unique (spotify_track_id, country, tracking_date, chart_type)
);

create index if not exists idx_chart_positions_country_date
  on chart_positions (chart_type, country, tracking_date desc, position);

create index if not exists idx_chart_positions_track_country
  on chart_positions (spotify_track_id, country, tracking_date desc);

grant select, insert, update on public.chart_positions to service_role;
grant usage, select on all sequences in schema public to service_role;

-- delete needed for one-off cleanup migrations (e.g. removing rows written
-- under a wrong tracking_date) -- not used by the daily fetch itself.
grant delete on public.chart_positions to service_role;
