-- Finished leaderboards, kept: `leaderboard_archive`.
--
-- Written from the live definition (dump-schema.yml, 21 Oct). 207 rows, read and
-- written by api/leaderboard.js, api/leaderboard-archive.js and
-- api/cron-scrobbles.js — and it existed only in the Supabase editor until now.
--
-- One row per finished period, with the whole standing stored as jsonb in
-- `users` rather than as rows. That is deliberate and worth stating: an archive
-- is a photograph, not a live table. Re-deriving a past week from today's data
-- would quietly change history every time somebody's display name changed.
--
-- The UNIQUE (period, period_key) is what makes the cron idempotent: it can run
-- twice over the same week and upsert rather than archive it twice.
--
-- RLS is OFF, as in production, which is safe only because no public role has
-- select (see the grant): the archive is served through the API.
--
-- Apply once in the Supabase SQL editor, or through apply-sql.yml. Safe to
-- re-run.

create table if not exists public.leaderboard_archive (
  id          bigint generated always as identity primary key,
  period      text not null,
  period_key  text not null,
  label       text not null,
  users       jsonb not null,
  archived_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leaderboard_archive_period_period_key_key') then
    alter table public.leaderboard_archive add constraint leaderboard_archive_period_period_key_key unique (period, period_key);
  end if;
end $$;

-- The server only. Supabase stopped auto-granting Data API access to new public
-- tables on 2026-10-30. No delete, matching production: an archive is not
-- something this code removes.
-- `references, trigger, truncate` are in production too — Supabase's old
-- auto-grant handed the service role everything — and they are reproduced
-- rather than trimmed. A migration's job is to rebuild the database as it IS:
-- a narrower grant here would mean the first code that truncates a table, or
-- adds a foreign key pointing at one, works in production and fails in a
-- rebuilt project, which is the hardest kind of difference to find.
grant select, insert, update, references, trigger, truncate
  on table public.leaderboard_archive to service_role;
