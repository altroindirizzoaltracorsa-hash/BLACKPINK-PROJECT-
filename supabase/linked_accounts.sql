-- One row per scrobble-tracking account a blink has linked to their app
-- profile. A (source, username) pair can only ever belong to one app
-- account, so the same Last.fm/ListenBrainz account can't get summed into
-- two different profiles (by mistake or otherwise).
create table if not exists linked_accounts (
  id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('lastfm', 'listenbrainz', 'librefm', 'musicat', 'statsfm')),
  source_username text not null,
  created_at timestamptz not null default now()
);

create index if not exists linked_accounts_app_user_id_idx on linked_accounts(app_user_id);
create unique index if not exists linked_accounts_source_username_uniq on linked_accounts(source, lower(source_username));

alter table linked_accounts enable row level security;

-- The owner, from the browser: the three policies below keep each blink to
-- their own rows.
grant select, insert, delete on linked_accounts to authenticated;

-- And the server, which this file never said. api/leaderboard.js,
-- api/cron-scrobbles.js, api/legacy-linked.js and api/vma-votes.js all read
-- this table with the service-role key — the leaderboard's verification pass is
-- built on it — and the service role bypasses RLS but NOT table grants. It
-- worked because Supabase auto-granted Data API access to new public tables
-- until 2026-10-30; this table keeps what it was given, so production is fine,
-- but a recreate of this schema (new project, preview branch, `supabase db
-- reset`) would have produced a leaderboard that silently verified nobody.
grant select, insert, update, delete on linked_accounts to service_role;

-- Re-runnable: `create policy` has no IF NOT EXISTS, so a second apply of this
-- file used to stop here with "policy already exists". One transaction, so a
-- blink reading their own linked accounts never hits the moment between the
-- drop and the create — RLS with no policy returns nothing, which is safe and
-- still looks to them like their accounts have vanished.
begin;

drop policy if exists "select own linked accounts" on linked_accounts;
create policy "select own linked accounts" on linked_accounts
  for select using (auth.uid() = app_user_id);

drop policy if exists "insert own linked accounts" on linked_accounts;
create policy "insert own linked accounts" on linked_accounts
  for insert with check (auth.uid() = app_user_id);

drop policy if exists "delete own linked accounts" on linked_accounts;
create policy "delete own linked accounts" on linked_accounts
  for delete using (auth.uid() = app_user_id);

commit;
