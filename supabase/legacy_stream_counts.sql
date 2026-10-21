-- The pre-scrobbler streaming tallies: `stream_counts` and
-- `global_stream_snapshots`.
--
-- Written from the live definitions (dump-schema.yml, 21 Oct). Both predate the
-- repo's supabase/ folder and existed only in the Supabase editor.
--
-- `stream_counts` is per person per day for the three campaign tracks of the
-- time, with `total` a GENERATED column — a detail worth having in a file,
-- because a rebuild that made it an ordinary column would accept writes to it
-- and then disagree with its own parts. Requires profiles.sql for the foreign
-- key.
--
-- `global_stream_snapshots` is the site-wide daily figure, and unlike almost
-- everything else here it is read by URL rather than through the Supabase
-- client — api/proxy-image.js calls PostgREST directly as
-- sbFetch('/global_stream_snapshots?...'), which is also why the grants audit
-- had to learn that pattern to see it at all.
--
-- Apply once in the Supabase SQL editor, or through apply-sql.yml. Safe to
-- re-run.

create table if not exists public.stream_counts (
  id         uuid primary key default gen_random_uuid(),
  user_id    text not null references public.profiles(id) on delete cascade,
  date       date not null,
  jump       integer default 0,
  shutdown   integer default 0,
  ddududu    integer default 0,
  total      integer generated always as (jump + shutdown + ddududu) stored,
  updated_at timestamptz default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stream_counts_user_id_date_key') then
    alter table public.stream_counts add constraint stream_counts_user_id_date_key unique (user_id, date);
  end if;
end $$;

create table if not exists public.global_stream_snapshots (
  date            date primary key,
  jump_total      bigint not null,
  shutdown_total  bigint not null,
  ddududu_total   bigint not null,
  jump_daily      bigint,
  shutdown_daily  bigint,
  ddududu_daily   bigint,
  fetched_at      timestamptz default now()
);

alter table public.stream_counts            enable row level security;
alter table public.global_stream_snapshots  enable row level security;

-- Re-runnable, in one transaction: `create policy` has no IF NOT EXISTS, and a
-- second apply would otherwise stop before the grants below.
begin;
drop policy if exists "Stream counts are publicly readable" on public.stream_counts;
create policy "Stream counts are publicly readable" on public.stream_counts
  for select using (true);
drop policy if exists "Global stream snapshots are publicly readable" on public.global_stream_snapshots;
create policy "Global stream snapshots are publicly readable" on public.global_stream_snapshots
  for select using (true);
commit;

-- As above in profiles.sql: the policies say "publicly readable" and no public
-- role has ever had select here, so they match nothing. Reproduced because they
-- are part of the schema; NOT backed with an anon grant, because adding one
-- would newly expose these rows to anybody holding the key that ships in the
-- page. Both tables are read server-side.
-- `references, trigger, truncate` are in production too — Supabase's old
-- auto-grant handed the service role everything — and they are reproduced
-- rather than trimmed. A migration's job is to rebuild the database as it IS:
-- a narrower grant here would mean the first code that truncates a table, or
-- adds a foreign key pointing at one, works in production and fails in a
-- rebuilt project, which is the hardest kind of difference to find.
-- global_stream_snapshots has no DELETE in production, and that is left as it
-- is: nothing in the code removes a day.
grant all privileges on table public.stream_counts to service_role;
grant select, insert, update, references, trigger, truncate
  on table public.global_stream_snapshots to service_role;
