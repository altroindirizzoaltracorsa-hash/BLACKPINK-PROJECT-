-- The beta sign-up list: `beta_testers`.
--
-- Written from the live definition (dump-schema.yml, 21 Oct). 236 rows, read and
-- written by api/beta.js, and it existed only in the Supabase editor until now.
--
-- The unique index is on lower(lfm_username), not on the column: Last.fm names
-- are case-insensitive, so "Rosie" and "rosie" are one person and a plain
-- unique constraint would have let them sign up twice.
--
-- Apply once in the Supabase SQL editor, or through apply-sql.yml. Safe to
-- re-run.

create table if not exists public.beta_testers (
  id             bigserial primary key,
  lfm_username   text not null,
  twitter_handle text,
  created_at     timestamptz not null default now()
);

create unique index if not exists beta_testers_lfm_lower
  on public.beta_testers (lower(lfm_username));

alter table public.beta_testers enable row level security;

-- RLS is on with no policies, so anon and authenticated see nothing even if a
-- grant appeared; the list is handled through api/beta.js. Supabase stopped
-- auto-granting Data API access to new public tables on 2026-10-30, so the
-- server's access is written down here.
-- `references, trigger, truncate` are in production too — Supabase's old
-- auto-grant handed the service role everything — and they are reproduced
-- rather than trimmed. A migration's job is to rebuild the database as it IS:
-- a narrower grant here would mean the first code that truncates a table, or
-- adds a foreign key pointing at one, works in production and fails in a
-- rebuilt project, which is the hardest kind of difference to find.
grant all privileges on table public.beta_testers to service_role;
