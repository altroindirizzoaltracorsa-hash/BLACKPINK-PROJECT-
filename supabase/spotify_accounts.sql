-- Spotify OAuth tokens for the legacy direct-ingest path: `spotify_accounts`.
--
-- Written from the live definition (dump-schema.yml, 21 Oct). One row in
-- production, and it holds an access token and a refresh token — so the grants
-- at the bottom matter more here than anywhere else in this folder.
--
-- Requires profiles.sql: user_id is a foreign key into it.
--
-- Apply once in the Supabase SQL editor, or through apply-sql.yml. Safe to
-- re-run.

create table if not exists public.spotify_accounts (
  id              uuid primary key default gen_random_uuid(),
  user_id         text not null references public.profiles(id) on delete cascade,
  spotify_user_id text not null,
  display_name    text,
  access_token    text not null,
  refresh_token   text not null,
  expires_at      timestamptz not null,
  last_cursor     bigint default 0,
  created_at      timestamptz default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'spotify_accounts_user_id_spotify_user_id_key') then
    alter table public.spotify_accounts add constraint spotify_accounts_user_id_spotify_user_id_key unique (user_id, spotify_user_id);
  end if;
end $$;

-- On, with NO policies, which is the right shape for a table of tokens: RLS
-- with no policy denies every row to anon and authenticated, and the service
-- role bypasses RLS. Nothing reads this from a browser and nothing should.
alter table public.spotify_accounts enable row level security;

-- The server only. Supabase stopped auto-granting Data API access to new public
-- tables on 2026-10-30, so a rebuild needs this written down — and here the
-- absence of an anon grant is the point, not an omission.
-- `references, trigger, truncate` are in production too — Supabase's old
-- auto-grant handed the service role everything — and they are reproduced
-- rather than trimmed. A migration's job is to rebuild the database as it IS:
-- a narrower grant here would mean the first code that truncates a table, or
-- adds a foreign key pointing at one, works in production and fails in a
-- rebuilt project, which is the hardest kind of difference to find.
grant all privileges on table public.spotify_accounts to service_role;
