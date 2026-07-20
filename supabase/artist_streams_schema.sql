-- Artist streams tracker (BLACKPINK first, more artists later).
-- Run this once in the Supabase SQL editor before the fetch job or API
-- endpoint are used.

create table if not exists tracked_artists (
  spotify_artist_id text primary key,
  name              text not null,
  avatar_url        text,
  active            boolean not null default true,
  created_at        timestamptz not null default now()
);

-- One row per artist per day. followers/monthly_listeners are artist-level
-- metadata that also changes daily, so they live here rather than on
-- tracked_artists.
create table if not exists artist_daily_stats (
  artist_id         text not null references tracked_artists(spotify_artist_id),
  date              date not null,
  total_streams     bigint not null,
  daily_delta       bigint,
  followers         bigint,
  monthly_listeners bigint,
  track_count       int,
  created_at        timestamptz not null default now(),
  primary key (artist_id, date)
);

create index if not exists idx_artist_daily_stats_artist_date
  on artist_daily_stats (artist_id, date desc);

-- One row per *canonical* song per artist -- this is where the dedup from
-- the fetch job lands. source_track_ids keeps every raw Spotify track ID
-- that got merged into this song (single release, album track, explicit/
-- clean edition, ...) for traceability if a total ever needs re-checking.
create table if not exists artist_tracks (
  id               bigserial primary key,
  artist_id        text not null references tracked_artists(spotify_artist_id),
  name             text not null,
  source_track_ids text[] not null,
  created_at       timestamptz not null default now(),
  unique (artist_id, name)
);

-- One row per canonical track per day.
create table if not exists track_daily_stats (
  track_ref   bigint not null references artist_tracks(id),
  date        date not null,
  streams     bigint not null,
  daily_delta bigint,
  created_at  timestamptz not null default now(),
  primary key (track_ref, date)
);

create index if not exists idx_track_daily_stats_track_date
  on track_daily_stats (track_ref, date desc);

-- Seed BLACKPINK as the first tracked artist.
insert into tracked_artists (spotify_artist_id, name, avatar_url)
values ('41MozSoPIsD1dJM0CLPjZF', 'BLACKPINK', null)
on conflict (spotify_artist_id) do nothing;

-- The 4 members, added later. IDs verified via test-spotifyscraper.py
-- against their actual Spotify artist pages before insertion.
insert into tracked_artists (spotify_artist_id, name, avatar_url) values
  ('6UZ0ba50XreR4TM8u322gs', 'JISOO',  null),
  ('250b0Wlc5Vk0CoUsaCY84M', 'JENNIE', null),
  ('3eVa5w3URK5duf6eyVDbu9', 'ROSÉ',   null),
  ('5L1lO4eRHmJ7a0Q6csE5cT', 'LISA',   null)
on conflict (spotify_artist_id) do nothing;

-- Tables created via the SQL editor don't automatically get the privilege
-- grants the Table Editor UI sets up for you -- service_role needs these
-- explicitly or every request 403s with "permission denied for table ...".
grant select, insert, update on public.tracked_artists     to service_role;
grant select, insert, update on public.artist_daily_stats  to service_role;
grant select, insert, update on public.artist_tracks       to service_role;
grant select, insert, update on public.track_daily_stats   to service_role;
grant usage, select on all sequences in schema public to service_role;

-- delete needed for one-off cleanup migrations (e.g. removing rows written
-- under a bug-mislabeled date) -- not used by the daily fetch itself.
grant delete on public.artist_daily_stats to service_role;
grant delete on public.track_daily_stats  to service_role;

-- Album metadata, so the streams page/CSV can group tracks by album.
-- Populated by fetch_artist_streams.py going forward and backfilled once
-- for existing rows by backfill_track_albums.py. release_date/track_number
-- are nullable since a few tracks (e.g. from search-only lookups) may not
-- carry them.
alter table public.artist_tracks add column if not exists album text;
alter table public.artist_tracks add column if not exists album_release_date date;
alter table public.artist_tracks add column if not exists track_number int;
