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

grant select, insert, delete on linked_accounts to authenticated;

create policy "select own linked accounts" on linked_accounts
  for select using (auth.uid() = app_user_id);

create policy "insert own linked accounts" on linked_accounts
  for insert with check (auth.uid() = app_user_id);

create policy "delete own linked accounts" on linked_accounts
  for delete using (auth.uid() = app_user_id);
