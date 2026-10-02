-- Per-track daily streams for the seven girl groups.
--
-- fetch_group_streams.py already fetches every track individually — that is how
-- the group total is built — and then throws the detail away, keeping only the
-- sum. So a question like "how fast is ILLIT's Magnetic actually moving, and
-- when does it hit 1B" is unanswerable from our own data even though we fetch
-- the number every single day. This keeps it.
--
-- DELIBERATELY SEPARATE from artist_tracks / track_daily_stats rather than
-- reusing them with the group's artist_id. Those tables carry site-visible
-- meaning: /streams lists from tracked_artists, the split-publish sweep walks
-- "every tracked artist", the per-artist pages query them. Dropping seven more
-- artists' worth of rows in there makes every one of those queries quietly
-- wider, and the first symptom would be a girl group appearing on a BLACKPINK
-- page. Isolation costs one extra table and removes that whole class of
-- accident.
--
-- Run once. Safe to re-run.

create table if not exists group_tracks (
  id         bigserial primary key,
  artist_id  text        not null,
  track_id   text        not null unique,   -- Spotify track id, the natural key
  name       text,
  feature    boolean     not null default false,
  created_at timestamptz not null default now()
);

create index if not exists group_tracks_artist_idx on group_tracks (artist_id);

create table if not exists group_track_daily_stats (
  track_ref   bigint not null references group_tracks(id) on delete cascade,
  date        date   not null,
  streams     bigint not null,
  daily_delta bigint,

  -- How many OTHER track ids reported this EXACT figure on this day. Spotify
  -- sometimes serves several versions of a song as one merged count, and when it
  -- does, every id in the group returns the same number — so summing them double
  -- counts. The group TOTAL sums as-is on purpose (that is what reproduces
  -- kworb), but a per-track reading must be able to tell "Magnetic did 889.9M"
  -- from "Magnetic and four remixes all report 889.9M". 0 means the value is this
  -- track's alone.
  merged_with int not null default 0,

  -- True when the fetch failed for this track and the previous known value was
  -- carried forward. Unchanged by construction, so a delta of 0 here means "we
  -- did not see it", not "it did not move" — the distinction a rate calculation
  -- has to respect.
  stale boolean not null default false,

  primary key (track_ref, date)
);

create index if not exists group_track_daily_date_idx on group_track_daily_stats (date);

-- Written only by fetch_group_streams.py (service_role). RLS on with no policies
-- is what actually locks anon/authenticated out here: Supabase sets default
-- privileges on schema public that grant those roles on every NEW table, so
-- withholding a grant is not enough on its own. service_role carries BYPASSRLS
-- and is unaffected, but still needs the explicit grants below.
-- Verified on Postgres 16 with service_role given BYPASSRLS, as in Supabase:
-- service_role reads and writes both tables, anon is refused both.
alter table group_tracks             enable row level security;
alter table group_track_daily_stats  enable row level security;
grant all privileges on table group_tracks            to service_role;
grant all privileges on table group_track_daily_stats to service_role;
grant usage, select on sequence group_tracks_id_seq   to service_role;

do $$
begin
  raise notice 'group_tracks + group_track_daily_stats ready (% existing track rows).',
    (select count(*) from group_tracks);
end $$;
