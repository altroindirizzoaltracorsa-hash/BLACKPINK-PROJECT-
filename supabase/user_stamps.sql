-- The daily stamp card: `user_stamps`.
--
-- Written from the live definition (dump-schema.yml, 21 Oct). The biggest of the
-- tables that had no migration — 3,603 rows — read and written by
-- api/stamps.js, api/leaderboard.js and api/cron-scrobbles.js, and it existed
-- only in the Supabase editor until now.
--
-- Keyed by (lfm_username, day_key) rather than by an account id, which dates
-- from before accounts: the stamp card belongs to a scrobbler handle. The
-- UNIQUE on that pair is what makes a day's stamps an upsert instead of a
-- growing pile of rows for the same day.
--
-- `stamps` is jsonb with a '{}' default, so a row can exist with nothing
-- stamped yet — which is what a visit before the first play looks like.
--
-- Apply once in the Supabase SQL editor, or through apply-sql.yml. Safe to
-- re-run.

create table if not exists public.user_stamps (
  id           bigserial primary key,
  lfm_username text not null,
  day_key      text not null,
  stamps       jsonb not null default '{}'::jsonb,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_stamps_lfm_username_day_key_key') then
    alter table public.user_stamps add constraint user_stamps_lfm_username_day_key_key unique (lfm_username, day_key);
  end if;
end $$;

alter table public.user_stamps enable row level security;

-- RLS on with no policies, and the server's access stated: Supabase stopped
-- auto-granting Data API access to new public tables on 2026-10-30, and the
-- service role bypasses RLS but NOT table grants.
-- `references, trigger, truncate` are in production too — Supabase's old
-- auto-grant handed the service role everything — and they are reproduced
-- rather than trimmed. A migration's job is to rebuild the database as it IS:
-- a narrower grant here would mean the first code that truncates a table, or
-- adds a foreign key pointing at one, works in production and fails in a
-- rebuilt project, which is the hardest kind of difference to find.
grant all privileges on table public.user_stamps to service_role;
