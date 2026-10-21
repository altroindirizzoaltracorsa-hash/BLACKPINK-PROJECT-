-- The leaderboard chat: `chat_messages` and `chat_claims`.
--
-- Written from the live definitions (dump-schema.yml, 21 Oct). Both are read and
-- written by api/leaderboard.js and both existed only in the Supabase editor
-- until now.
--
-- `chat_claims` is how a username is held: one row per name, with a secret the
-- claimant proves themselves by. The PRIMARY KEY is the username itself, which
-- is what makes a claim exclusive — a rebuild that keyed on anything else would
-- let two people hold the same name and would look fine until they did.
--
-- RLS is OFF on both, as in production. That is safe only because no public
-- role has select on them (see the grants): the chat is served through
-- api/leaderboard.js, never read from the browser. If a grant is ever added
-- here, RLS and a policy have to come with it — a secret column with RLS off
-- and a select grant would be readable by anybody holding the anon key.
--
-- Apply once in the Supabase SQL editor, or through apply-sql.yml. Safe to
-- re-run.

create table if not exists public.chat_claims (
  username   text primary key,
  secret     text not null,
  claimed_at timestamptz not null default now()
);

create table if not exists public.chat_messages (
  id         bigint generated always as identity primary key,
  username   text not null,
  avatar     text,
  message    text not null,
  created_at timestamptz not null default now()
);

-- The server only, and that is what keeps the secrets in chat_claims private
-- while RLS is off. Supabase stopped auto-granting Data API access to new
-- public tables on 2026-10-30, so a rebuild needs these written down; the
-- service role bypasses RLS but NOT table grants.
--
-- Exactly what production holds, which is less than "all": nothing deletes a
-- claim, and nothing updates a message.
-- `references, trigger, truncate` are in production too — Supabase's old
-- auto-grant handed the service role everything — and they are reproduced
-- rather than trimmed. A migration's job is to rebuild the database as it IS:
-- a narrower grant here would mean the first code that truncates a table, or
-- adds a foreign key pointing at one, works in production and fails in a
-- rebuilt project, which is the hardest kind of difference to find.
-- Exactly what production holds, which is less than everything: no DELETE on a
-- claim, and no UPDATE on a message. Both read as decisions rather than
-- oversights — a name is not released, and a posted message is not edited.
grant select, insert, update, references, trigger, truncate
  on table public.chat_claims   to service_role;
grant select, insert, delete, references, trigger, truncate
  on table public.chat_messages to service_role;
