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
-- (Mon-start) week / this month / all-time (all US-Eastern).
--
-- Two rules baked in here (intentionally NOT surfaced to users):
--   • Only accounts that have actually STREAMED (>=1 campaign scrobble ever, from
--     user_daily_counts) are ranked. You can still register votes without
--     streaming — they count in the community total (vma_vote_totals) — you just
--     don't appear on this board or earn badges until you've streamed.
--   • Accounts with no display name are shown as blink1, blink2, … numbered by
--     when they first voted (stable), instead of a generic "a blink".
-- Each row also carries `streams` = that account's campaign streams for the
-- current voting day (ET-aligned, so it naturally holds yesterday's total during
-- the 2–6am gap and tracks today's after 6am).
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
      sum(votes) filter (where day >= date_trunc('month', now() at time zone 'America/New_York')::date)  as month,
      min(day)                                                                                           as first_day
    from vma_user_votes
    group by app_user_id
  ),
  latest_name as (
    select distinct on (app_user_id) app_user_id, display_name
    from vma_user_votes
    order by app_user_id, day desc, updated_at desc
  ),
  streams as (
    select
      app_user_id,
      sum(coalesce(jump,0)+coalesce(shutdown,0)+coalesce(ddududu,0)+coalesce(go,0))                     as all_streams,
      sum((coalesce(jump,0)+coalesce(shutdown,0)+coalesce(ddududu,0)+coalesce(go,0)))
        filter (where day_key::date = (now() at time zone 'America/New_York')::date)                    as today_streams
    from user_daily_counts
    group by app_user_id
  ),
  -- Every voter (streamer or not). LEFT join streams so non-streamers are kept;
  -- app_user_id is text in user_daily_counts vs uuid here → cast.
  joined as (
    select
      u.total, u.today, u.week, u.month, u.first_day, u.app_user_id,
      n.display_name,
      coalesce(s.today_streams, 0) as streams
    from per_user u
    left join latest_name n using (app_user_id)
    left join streams s on s.app_user_id = u.app_user_id::text
  ),
  -- Number the nameless GLOBALLY (across streamers and non-streamers) by when they
  -- first voted, so blinkN is stable for an account whether or not it's ranked.
  numbered as (
    select j.*,
      case
        when j.display_name is null or j.display_name = ''
          then 'blink' || row_number() over (
                 partition by (j.display_name is null or j.display_name = '')
                 order by j.first_day, j.app_user_id)
        else j.display_name
      end as name
    from joined j
  )
  -- Ranked = streaming on the current voting day (>=1 campaign scrobble today).
  -- Unranked = voted but not streaming today — shown separately, still counted in
  -- the community total (vma_vote_totals is unchanged).
  select json_build_object(
    'ranked', coalesce((
      select json_agg(json_build_object(
        'name', name, 'total', total, 'today', today, 'week', week, 'month', month, 'streams', streams
      ) order by total desc)
      from numbered where streams >= 1), '[]'::json),
    'unranked', coalesce((
      select json_agg(json_build_object(
        'name', name, 'total', total, 'today', today, 'week', week, 'month', month, 'streams', streams
      ) order by total desc)
      from numbered where streams < 1), '[]'::json)
  );
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
