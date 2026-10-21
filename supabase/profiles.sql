-- The legacy account row: `profiles`.
--
-- Written from the LIVE definition (dump-schema.yml, 21 Oct) rather than from
-- memory. This table has 479 rows and predates the repo's supabase/ folder, so
-- it existed only inside the Supabase editor until now — there was no file to
-- rebuild it from, and `id` being TEXT rather than uuid is exactly the kind of
-- detail nobody would have guessed right.
--
-- It is not auth.users. The current account system is Supabase auth, and this
-- is the earlier one; `spotify_accounts` and `stream_counts` still point at it
-- by foreign key, which is why it has to be created before either of them.
--
-- Apply once in the Supabase SQL editor, or through apply-sql.yml. Safe to
-- re-run.

create table if not exists public.profiles (
  id         text primary key,
  username   text not null,
  avatar_url text,
  created_at timestamptz default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_username_key') then
    alter table public.profiles add constraint profiles_username_key unique (username);
  end if;
end $$;

alter table public.profiles enable row level security;

-- Re-runnable: `create policy` has no IF NOT EXISTS, and a second apply would
-- otherwise stop here — before the grants below. One transaction, so a reader
-- never meets the moment where RLS is on and the policy is gone.
begin;
drop policy if exists "Profiles are publicly readable" on public.profiles;
create policy "Profiles are publicly readable" on public.profiles
  for select using (true);
commit;

-- Grants, stated rather than inherited: Supabase stopped auto-granting Data API
-- access to new public tables on 2026-10-30, so a rebuild of this table needs
-- them written down. The service role bypasses RLS but NOT table grants.
--
-- Deliberately NOT granting select to anon or authenticated, even though the
-- policy above says "publicly readable". That policy is inert today — nothing
-- outside the server has ever had select on this table — and the page reads
-- profiles server-side. Adding the grant here to match the policy's wording
-- would open 479 rows to anybody holding the anon key, which ships in the page.
-- The policy is reproduced because it is part of the schema; the grant is not,
-- because the schema is what is, not what the wording implies.
-- `references, trigger, truncate` are in production too — Supabase's old
-- auto-grant handed the service role everything — and they are reproduced
-- rather than trimmed. A migration's job is to rebuild the database as it IS:
-- a narrower grant here would mean the first code that truncates a table, or
-- adds a foreign key pointing at one, works in production and fails in a
-- rebuilt project, which is the hardest kind of difference to find.
grant all privileges on table public.profiles to service_role;
