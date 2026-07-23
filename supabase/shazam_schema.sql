-- Real Shazam data for BLACKPINK + members: total Shazam count per song, and
-- BLACKPINK/member entries on Shazam's own official world/country charts.
-- Source: Shazam's public web endpoints (www.shazam.com/services/...) -- the
-- same ones the reverse-engineered ShazamIO Python library uses, fetched via
-- a Vercel serverless function. (Like the official Spotify artist charts,
-- these are blocked from GitHub Actions' IP ranges, so this runs on Vercel
-- instead -- see api/proxy-image.js ?shazam=fetch.)
-- Run this once in the Supabase SQL editor.

-- Cache the resolved Shazam track key on the existing canonical song catalog
-- (artist_tracks) rather than keeping a separate title list -- one canonical
-- song per artist already exists there. checked_at is set even on a failed
-- resolution so we don't keep re-searching for songs Shazam has no match for.
alter table public.artist_tracks add column if not exists shazam_track_id text;
alter table public.artist_tracks add column if not exists shazam_checked_at timestamptz;

create table if not exists shazam_track_counts (
  track_ref   bigint not null references artist_tracks(id),
  tracking_date date not null,
  count       bigint not null,
  daily_delta bigint,
  created_at  timestamptz not null default now(),
  primary key (track_ref, tracking_date)
);

create index if not exists idx_shazam_track_counts_track_date
  on shazam_track_counts (track_ref, tracking_date desc);

-- BLACKPINK/member entries on Shazam's own official charts (world + per
-- country) -- rank only, since Shazam's charts API (unlike Spotify's) doesn't
-- expose peak/streak; movement is computed from our own history, same as
-- chart_positions.
create table if not exists shazam_chart_positions (
  id                bigserial primary key,
  shazam_track_id   text not null,
  track_name        text not null,
  artist_name       text not null,
  country           text not null, -- 'GLOBAL' or ISO 3166-1 alpha-2
  tracking_date     date not null,
  position          int not null,
  previous_position int,
  position_change   int,
  entry_status      text, -- NEW / RE-ENTRY / MOVED_UP / MOVED_DOWN / NO_CHANGE
  created_at        timestamptz not null default now(),
  unique (shazam_track_id, country, tracking_date)
);

create index if not exists idx_shazam_chart_positions_country_date
  on shazam_chart_positions (country, tracking_date desc, position);

grant select, insert, update on public.shazam_track_counts    to service_role;
grant select, insert, update on public.shazam_chart_positions to service_role;
grant usage, select on all sequences in schema public to service_role;
