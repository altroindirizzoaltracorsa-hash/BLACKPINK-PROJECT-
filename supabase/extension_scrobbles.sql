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

-- Re-runnable, which `create policy` is not: it has no IF NOT EXISTS, so a
-- second apply of this file used to stop here with "policy already exists" —
-- and the grants below it would never run. In one transaction, so a reader of
-- a live table sees the old policy or the new one and never the gap between
-- them (RLS with no policy denies everything, which is safe but is still an
-- outage). Dropping and recreating rather than skipping when present also
-- keeps this file the source of truth: an edited policy actually lands.
begin;
drop policy if exists "read own tokens" on scrobble_tokens;
create policy "read own tokens" on scrobble_tokens
  for select using (auth.uid() = app_user_id);
drop policy if exists "read own extension scrobbles" on extension_scrobbles;
create policy "read own extension scrobbles" on extension_scrobbles
  for select using (auth.uid() = app_user_id);
commit;

-- Grants, stated rather than inherited. Supabase auto-granted Data API access
-- to new public tables until 2026-10-30; these two tables predate that and keep
-- what they were given, so production is unaffected. A RECREATION of this
-- schema is not — a new project, a preview branch, a local `supabase db reset`
-- — and there the five server routes that use these tables would start
-- answering "permission denied" months after anyone touched them. The service
-- role bypasses RLS but NOT table grants.
--
-- `select` to authenticated is what the two policies above are for: without a
-- grant the policies are still there, still correct, and match nothing. It
-- exposes only the owner's own rows, which is exactly what production does
-- today — this reproduces that rather than quietly narrowing it. Nothing in the
-- site reads either table from the browser at the moment; if that stays true,
-- dropping these two lines is a safe tightening, and a deliberate one.
grant select, insert, update, delete on table scrobble_tokens     to service_role;
grant select, insert, update, delete on table extension_scrobbles to service_role;
grant select on table scrobble_tokens     to authenticated;
grant select on table extension_scrobbles to authenticated;
