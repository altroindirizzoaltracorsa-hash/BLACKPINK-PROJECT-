-- VMA voting leaderboard — manually-submitted vote counts per BU account, per day.
--
-- Only a signed-in blink who has linked a scrobbler (>=1 row in linked_accounts)
-- may submit; that's enforced in /api/vma-votes. Votes are self-reported and
-- uncapped. Weekly/monthly totals are just sums over date ranges. The display
-- name is denormalised onto each row so the board can rank without touching the
-- auth schema.
--
-- Run once in the Supabase SQL editor before deploying /api/vma-votes.

create table if not exists vma_user_votes (
  app_user_id  uuid        not null references auth.users(id) on delete cascade,
  day          date        not null default (now() at time zone 'utc')::date,
  votes        int         not null default 0 check (votes >= 0),
  display_name text,
  updated_at   timestamptz not null default now(),
  primary key (app_user_id, day)
);

create index if not exists vma_user_votes_day_idx on vma_user_votes (day);

-- Community rally total (sum of everyone's submitted votes) for the /vmas bar.
-- Day boundaries are US Eastern (midnight ET) to match MTV's VMA voting reset.
create or replace function vma_vote_totals()
returns json
language sql
stable
as $$
  select json_build_object(
    'total',       coalesce(sum(votes), 0),
    'today',       coalesce(sum(votes) filter (where day = (now() at time zone 'America/New_York')::date), 0),
    'blinksTotal', count(distinct app_user_id),
    'blinksToday', count(distinct app_user_id) filter (where day = (now() at time zone 'America/New_York')::date)
  )
  from vma_user_votes;
$$;

-- Ranked voting board: one entry per account, votes summed for today / this
-- (Mon-start) week / this month / all-time. Name is taken from the most recent
-- row for that account.
create or replace function vma_vote_board()
returns json
language sql
stable
as $$
  with per_user as (
    select
      app_user_id,
      sum(votes)                                                                                        as total,
      sum(votes) filter (where day = (now() at time zone 'America/New_York')::date)                      as today,
      sum(votes) filter (where day >= date_trunc('week',  now() at time zone 'America/New_York')::date)  as week,
      sum(votes) filter (where day >= date_trunc('month', now() at time zone 'America/New_York')::date)  as month
    from vma_user_votes
    group by app_user_id
  ),
  latest_name as (
    select distinct on (app_user_id) app_user_id, display_name
    from vma_user_votes
    order by app_user_id, day desc, updated_at desc
  )
  select coalesce(
    json_agg(
      json_build_object(
        'name',  coalesce(n.display_name, 'a blink'),
        'total', u.total, 'today', u.today, 'week', u.week, 'month', u.month
      )
      order by u.total desc
    ),
    '[]'::json
  )
  from per_user u
  left join latest_name n using (app_user_id);
$$;

-- ── Privileges ──────────────────────────────────────────────────────────────
-- This table is written ONLY by the /api/vma-votes serverless function, which
-- connects with the service_role key and does its own auth + linked-scrobbler
-- check. Lock everyone else out and make sure the server can write:
--   • RLS on, with NO policies → anon/authenticated can't touch it directly
--     (they must go through the API).
--   • service_role bypasses RLS but still needs table GRANTs — a freshly
--     created table doesn't always inherit them, which is what caused
--     "permission denied for table vma_user_votes" on the first write.
alter table vma_user_votes enable row level security;
grant all privileges on table vma_user_votes to service_role;
grant execute on function vma_vote_totals() to service_role;
grant execute on function vma_vote_board()  to service_role;
