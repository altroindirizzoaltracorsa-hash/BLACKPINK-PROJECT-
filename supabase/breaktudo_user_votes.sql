-- BreakTudo Awards voting counter — the BreakTudo sibling of vma_user_votes.
--
-- DELIBERATELY a separate table (not an `award` column on vma_user_votes): the
-- VMA board is live during VMA voting, so BreakTudo is kept fully isolated —
-- nothing here touches the VMA path. Same shape and same rules as the VMA board
-- so the two read identically in one extension / one login, just counted apart.
--
-- Only a signed-in blink who has linked a scrobbler (>=1 row in linked_accounts)
-- may submit; enforced in /api/vma-votes (award='breaktudo'). Votes are
-- self-reported and uncapped (BreakTudo has no per-person cap).
--
-- Day boundary is BRASÍLIA (America/Sao_Paulo, UTC-3, no DST) — the award's own
-- timezone — used only for the "today" bucket; BreakTudo has no daily reset.
--
-- Single `votes` tally for now. If we later confirm (from the vote request) that
-- BreakTudo exposes per-category detail, add category columns alongside `votes`
-- without breaking the total — the tally is authoritative for ranking.
--
-- Run once in the Supabase SQL editor before enabling the BreakTudo counter.

create table if not exists breaktudo_user_votes (
  app_user_id  uuid        not null references auth.users(id) on delete cascade,
  day          date        not null default (now() at time zone 'America/Sao_Paulo')::date,
  votes        int         not null default 0 check (votes >= 0),  -- authoritative TOTAL (ranking)
  display_name text,
  updated_at   timestamptz not null default now(),
  primary key (app_user_id, day)
);

create index if not exists breaktudo_user_votes_day_idx on breaktudo_user_votes (day);

-- Community rally total (sum of everyone's submitted votes) for the counter bar.
-- Day boundaries are Brasília (America/Sao_Paulo) to match the award.
create or replace function breaktudo_vote_totals()
returns json
language sql
stable
as $$
  select json_build_object(
    'total',       coalesce(sum(votes), 0),
    'today',       coalesce(sum(votes) filter (where day = (now() at time zone 'America/Sao_Paulo')::date), 0),
    'blinksTotal', count(distinct app_user_id),
    'blinksToday', count(distinct app_user_id) filter (where day = (now() at time zone 'America/Sao_Paulo')::date)
  )
  from breaktudo_user_votes;
$$;

-- Ranked voting board — one entry per account, votes summed for today / this
-- (Mon-start) week / this month / all-time (all Brasília). Mirrors vma_vote_board:
--   • Only accounts that have STREAMED at least once EVER (any tracked campaign
--     column of user_daily_counts) are ranked. Non-streamers still count in the
--     community total (breaktudo_vote_totals) and earn the vote-only Voter badge,
--     they just don't appear on the ranked board.
--   • Nameless accounts show as blink1, blink2, … numbered by first vote (stable).
-- `streams` = that account's campaign streams for the current day (Brasília-aligned).
create or replace function breaktudo_vote_board()
returns json
language sql
stable
as $$
  with per_user as (
    select
      app_user_id,
      sum(votes)                                                                                          as total,
      sum(votes) filter (where day = (now() at time zone 'America/Sao_Paulo')::date)                       as today,
      sum(votes) filter (where day >= date_trunc('week',  now() at time zone 'America/Sao_Paulo')::date)   as week,
      sum(votes) filter (where day >= date_trunc('month', now() at time zone 'America/Sao_Paulo')::date)   as month,
      min(day)                                                                                             as first_day
    from breaktudo_user_votes
    group by app_user_id
  ),
  latest_name as (
    select distinct on (app_user_id) app_user_id, display_name
    from breaktudo_user_votes
    where display_name is not null and display_name <> ''
    order by app_user_id, day desc, updated_at desc
  ),
  handles as (
    select distinct on (la.app_user_id)
      la.app_user_id::text as app_user_id, la.source_username
    from linked_accounts la
    where la.source_username is not null and la.source_username <> ''
      and la.source_username !~ '\s'
      and la.source_username not ilike '%http%'
      and position('|' in la.source_username) = 0
      and length(la.source_username) <= 30
    order by la.app_user_id, (la.source = 'lastfm') desc, la.created_at desc
  ),
  streams as (
    select
      app_user_id,
      sum(coalesce(jump,0)+coalesce(shutdown,0)+coalesce(ddududu,0)+coalesce(ltal,0)+coalesce(go,0)
          +coalesce(sawadika,0)+coalesce(click,0)+coalesce(fallenangel,0)+coalesce(heaven,0)+coalesce(newtrick,0))  as all_streams,
      sum((coalesce(jump,0)+coalesce(shutdown,0)+coalesce(ddududu,0)+coalesce(ltal,0)+coalesce(go,0)
           +coalesce(sawadika,0)+coalesce(click,0)+coalesce(fallenangel,0)+coalesce(heaven,0)+coalesce(newtrick,0)))
        filter (where day_key::date = (now() at time zone 'America/Sao_Paulo')::date)                    as today_streams
    from user_daily_counts
    group by app_user_id
  ),
  joined as (
    select
      u.total, u.today, u.week, u.month, u.first_day, u.app_user_id,
      n.display_name,
      h.source_username as handle,
      coalesce(s.today_streams, 0) as streams,
      coalesce(s.all_streams, 0)   as ever_streams
    from per_user u
    left join latest_name n using (app_user_id)
    left join handles h on h.app_user_id = u.app_user_id::text
    left join streams s on s.app_user_id = u.app_user_id::text
  ),
  numbered as (
    select j.*,
      case
        when j.display_name is not null and j.display_name <> '' then j.display_name
        when j.handle is not null then j.handle
        else 'blink' || row_number() over (
               partition by ((j.display_name is null or j.display_name = '') and j.handle is null)
               order by j.first_day, j.app_user_id)
      end as name
    from joined j
  )
  select json_build_object(
    'ranked', coalesce((
      select json_agg(json_build_object(
        'name', name, 'total', total, 'today', today, 'week', week, 'month', month, 'streams', streams
      ) order by total desc)
      from numbered where ever_streams >= 1), '[]'::json),
    'unranked', coalesce((
      select json_agg(json_build_object(
        'name', name, 'total', total, 'today', today, 'week', week, 'month', month, 'streams', streams
      ) order by total desc)
      from numbered where ever_streams < 1), '[]'::json)
  );
$$;

-- ── Privileges ──────────────────────────────────────────────────────────────
-- Written ONLY by /api/vma-votes (service_role, does its own auth + linked check).
-- RLS on with no policies → anon/authenticated can't touch it directly; service_role
-- bypasses RLS but still needs explicit GRANTs on a freshly created table.
alter table breaktudo_user_votes enable row level security;
grant all privileges on table breaktudo_user_votes to service_role;
grant execute on function breaktudo_vote_totals() to service_role;
grant execute on function breaktudo_vote_board()  to service_role;
