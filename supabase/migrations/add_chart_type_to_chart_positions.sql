-- Adds weekly chart support to chart_positions (originally daily-only).
-- Run this once in the Supabase SQL editor after chart_positions_schema.sql.

alter table public.chart_positions add column if not exists chart_type text not null default 'daily';

-- Drop the old (track, country, date) uniqueness and replace it with one that
-- also includes chart_type, since a track can hold different positions on
-- the same day's daily chart vs. that week's weekly chart.
alter table public.chart_positions drop constraint if exists chart_positions_spotify_track_id_country_tracking_date_key;
alter table public.chart_positions add constraint chart_positions_track_country_date_type_key
  unique (spotify_track_id, country, tracking_date, chart_type);

create index if not exists idx_chart_positions_type_country_date
  on chart_positions (chart_type, country, tracking_date desc, position);
