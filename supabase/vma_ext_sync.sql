-- Opt-in cross-device sync for the VMA vote-counter extension.
--
-- When a blink turns on "sync across my devices" in the extension, each counted
-- vote also records — under their BU account — today's BLACKPINK/LISA split and the
-- voting account (email/login) it was cast with. Other devices with sync on read
-- this back so the panel's counts + "accounts used today" list merge across devices.
--
-- Privacy: written ONLY by /api/vma-votes (service_role) and returned ONLY to the
-- owning account (resolved from that device's link token). RLS on, no public
-- policies — nobody can read another blink's voting emails. Sync is OFF by default;
-- a device contributes/reads only after the user opts in.
--
-- Day boundary is US Eastern (midnight ET), same as the voting board.
--
-- Run once in the Supabase SQL editor.

create table if not exists vma_ext_sync (
  app_user_id uuid  not null references auth.users(id) on delete cascade,
  day         date  not null,
  bp          int   not null default 0,
  lisa        int   not null default 0,
  -- { "<email/login>": { "method": "email|google|…", "votes": <int> }, … }
  accounts    jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (app_user_id, day)
);

-- Add one counted submission: bumps today's split and folds the account into the
-- jsonb map (accumulating that account's votes). Idempotency matches the vote write
-- itself — the extension already de-dupes retried submissions by timestamp.
-- Drop the previous 7-arg overload so the new p_cat signature isn't ambiguous.
drop function if exists vma_ext_sync_add(uuid, date, int, int, text, text, int);

create or replace function vma_ext_sync_add(
  p_uid uuid, p_day date, p_bp int, p_lisa int,
  p_email text, p_method text, p_n int, p_cat text default null
) returns void
language sql
as $$
  insert into vma_ext_sync as v (app_user_id, day, bp, lisa, accounts, updated_at)
  values (
    p_uid, p_day, coalesce(p_bp, 0), coalesce(p_lisa, 0),
    case when coalesce(p_email, '') = '' then '{}'::jsonb
         else jsonb_build_object(p_email, jsonb_build_object(
                'method', coalesce(p_method, 'email'),
                'votes',  coalesce(p_n, 0),
                'cats',   case when coalesce(p_cat, '') = '' then '[]'::jsonb else jsonb_build_array(p_cat) end))
    end,
    now()
  )
  on conflict (app_user_id, day) do update set
    bp   = v.bp   + coalesce(p_bp, 0),
    lisa = v.lisa + coalesce(p_lisa, 0),
    accounts = case when coalesce(p_email, '') = '' then v.accounts
      else v.accounts || jsonb_build_object(
             p_email,
             jsonb_build_object(
               'method', coalesce(p_method, 'email'),
               'votes',  coalesce((v.accounts -> p_email ->> 'votes')::int, 0) + coalesce(p_n, 0),
               -- union of the categories this account has covered (distinct)
               'cats',   (
                 select coalesce(jsonb_agg(distinct c), '[]'::jsonb)
                 from (
                   select jsonb_array_elements_text(coalesce(v.accounts -> p_email -> 'cats', '[]'::jsonb)) as c
                   union
                   select p_cat where coalesce(p_cat, '') <> ''
                 ) s
               )
             )
           )
    end,
    updated_at = now();
$$;

-- ── Privileges ──────────────────────────────────────────────────────────────
-- Same lockdown as vma_user_votes: RLS on, no policies, service_role gets grants.
alter table vma_ext_sync enable row level security;
grant all privileges on table vma_ext_sync to service_role;
grant execute on function vma_ext_sync_add(uuid, date, int, int, text, text, int, text) to service_role;
