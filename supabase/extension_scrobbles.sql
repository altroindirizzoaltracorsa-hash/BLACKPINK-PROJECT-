-- Direct-ingest scrobbles from the SessionBox Multi-Account Scrobbler extension.
-- Used by api/ingest-scrobble.js. Self-reported (no Last.fm verification), so
-- the token is the only trust boundary — keep tokens secret and per-profile.

-- One secret token per blinksunited profile. The extension carries this token;
-- every Spotify account in that browser install funnels to this profile.
create table if not exists scrobble_tokens (
  token text primary key,
  app_user_id uuid not null references auth.users(id) on delete cascade,
  label text,
  created_at timestamptz not null default now()
);
create index if not exists scrobble_tokens_app_user_id_idx on scrobble_tokens(app_user_id);

-- Raw ingested plays. The leaderboard aggregation counts rows per app_user_id
-- and track_id within the current day/week window.
create table if not exists extension_scrobbles (
  id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null references auth.users(id) on delete cascade,
  track_id text not null,
  artist text,
  title text,
  spotify_account text,
  listened_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists extension_scrobbles_user_listen_idx
  on extension_scrobbles(app_user_id, listened_at);
create index if not exists extension_scrobbles_track_idx
  on extension_scrobbles(app_user_id, track_id, listened_at);

-- Writes happen only via the service-role key in api/ingest-scrobble.js, so RLS
-- stays on with no public policies (service role bypasses RLS). A profile owner
-- may read their own rows if you later expose them client-side.
alter table scrobble_tokens enable row level security;
alter table extension_scrobbles enable row level security;

create policy "read own tokens" on scrobble_tokens
  for select using (auth.uid() = app_user_id);
create policy "read own extension scrobbles" on extension_scrobbles
  for select using (auth.uid() = app_user_id);
