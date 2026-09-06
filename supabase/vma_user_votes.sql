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
  votes        int         not null default 0 check (votes >= 0),  -- authoritative TOTAL (ranking)
  bp           int         not null default 0 check (bp   >= 0),   -- attributed: BLACKPINK (JUMP, Best K-Pop)
  lisa         int         not null default 0 check (lisa >= 0),   -- attributed: LISA (Best Pop / Best K-Pop)
  display_name text,
  updated_at   timestamptz not null default now(),
  primary key (app_user_id, day)
);
-- Existing installs: see supabase/migrations/add_bp_lisa_to_vma_user_votes.sql

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
    'lisaTotal',   coalesce(sum(lisa), 0),
    'bpTotal',     coalesce(sum(bp), 0),
    'lisaToday',   coalesce(sum(lisa) filter (where day = (now() at time zone 'America/New_York')::date), 0),
    'bpToday',     coalesce(sum(bp)   filter (where day = (now() at time zone 'America/New_York')::date), 0),
    'blinksTotal', count(distinct app_user_id),
    'blinksToday', count(distinct app_user_id) filter (where day = (now() at time zone 'America/New_York')::date)
  )
  from vma_user_votes;
$$;

-- Ranked voting board: one entry per account, votes summed for today / this
-- (Mon-start) week / this month / all-time (all US-Eastern).
--
-- Two rules baked in here (intentionally NOT surfaced to users):
--   • Only accounts that have actually STREAMED (>=1 tracked scrobble EVER, across
--     all campaign columns of user_daily_counts) are ranked. You can still register
--     votes without ever streaming — they count in the community total
--     (vma_vote_totals) — you just don't appear on this board or earn badges until
--     you've streamed at least once. NOTE: the gate is "ever", not "today" — a
--     daily voter who streamed on earlier days (or streams the newer releases,
--     which don't have their own user_daily_counts columns) must still rank.
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
      sum(lisa)                                                                                          as lisa_total,
      sum(lisa) filter (where day = (now() at time zone 'America/New_York')::date)                       as lisa_today,
      sum(lisa) filter (where day >= date_trunc('week',  now() at time zone 'America/New_York')::date)   as lisa_week,
      sum(lisa) filter (where day >= date_trunc('month', now() at time zone 'America/New_York')::date)   as lisa_month,
      sum(bp)                                                                                            as bp_total,
      sum(bp) filter (where day = (now() at time zone 'America/New_York')::date)                         as bp_today,
      sum(bp) filter (where day >= date_trunc('week',  now() at time zone 'America/New_York')::date)     as bp_week,
      sum(bp) filter (where day >= date_trunc('month', now() at time zone 'America/New_York')::date)     as bp_month,
      min(day)                                                                                           as first_day
    from vma_user_votes
    group by app_user_id
  ),
  latest_name as (
    -- Most recent NON-NULL display name. Votes logged by the extension may carry a
    -- null name; ignoring nulls here means such a row can't wipe out the real name
    -- (otherwise the board would fall through to a scrobbler handle like "jumppink").
    select distinct on (app_user_id) app_user_id, display_name
    from vma_user_votes
    where display_name is not null and display_name <> ''
    order by app_user_id, day desc, updated_at desc
  ),
  -- Fallback handle from the linked scrobbler (prefer Last.fm, else most recent),
  -- so a voter who never set a BU display name shows their handle — same as the
  -- streaming leaderboard — instead of a generic blinkN. (Voting requires a linked
  -- scrobbler, so nearly every account here has one.)
  handles as (
    select distinct on (la.app_user_id)
      la.app_user_id::text as app_user_id, la.source_username
    from linked_accounts la
    where la.source_username is not null and la.source_username <> ''
      -- Ignore malformed handles (a pasted profile title / URL, e.g.
      -- "lalalamesaa's Music Profile | Last.fm https://…") so a clean handle
      -- wins and the voting board name matches the streaming board.
      and la.source_username !~ '\s'          -- no spaces
      and la.source_username not ilike '%http%'
      and position('|' in la.source_username) = 0
      and length(la.source_username) <= 30
    order by la.app_user_id, (la.source = 'lastfm') desc, la.created_at desc
  ),
  streams as (
    select
      app_user_id,
      -- All tracked campaign columns (incl. ltal). ever_streams is the rank gate;
      -- today_streams is display only. New releases (SaWaDiKa/CLICK/EP) have no
      -- columns here, so they can't lift today_streams — which is exactly why the
      -- gate must be "ever", not "today".
      sum(coalesce(jump,0)+coalesce(shutdown,0)+coalesce(ddududu,0)+coalesce(ltal,0)+coalesce(go,0)
          +coalesce(sawadika,0)+coalesce(click,0)+coalesce(fallenangel,0)+coalesce(heaven,0))            as all_streams,
      sum((coalesce(jump,0)+coalesce(shutdown,0)+coalesce(ddududu,0)+coalesce(ltal,0)+coalesce(go,0)
           +coalesce(sawadika,0)+coalesce(click,0)+coalesce(fallenangel,0)+coalesce(heaven,0)))
        filter (where day_key::date = (now() at time zone 'America/New_York')::date)                    as today_streams
    from user_daily_counts
    group by app_user_id
  ),
  -- Every voter (streamer or not). LEFT join streams so non-streamers are kept;
  -- app_user_id is text in user_daily_counts vs uuid here → cast.
  joined as (
    select
      u.total, u.today, u.week, u.month,
      u.lisa_total, u.lisa_today, u.lisa_week, u.lisa_month,
      u.bp_total, u.bp_today, u.bp_week, u.bp_month,
      u.first_day, u.app_user_id,
      n.display_name,
      h.source_username as handle,
      coalesce(s.today_streams, 0) as streams,        -- display: streams on the voting day
      coalesce(s.all_streams, 0)   as ever_streams    -- rank gate: has this account ever streamed?
    from per_user u
    left join latest_name n using (app_user_id)
    left join handles h on h.app_user_id = u.app_user_id::text
    left join streams s on s.app_user_id = u.app_user_id::text
  ),
  -- Name = BU display name → linked scrobbler handle → blinkN, mirroring the
  -- streaming leaderboard's `displayName || handle`. The blinkN privacy default for
  -- new signups is handled at sign-up (ensureAutoDisplayName assigns a real blinkN
  -- display name), so it flows through the display_name branch to BOTH boards; only
  -- an account with no name AND no handle would ever fall through to numbering here.
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
  -- Ranked = has streamed at least once EVER (any tracked campaign column).
  -- Unranked = voted but never streamed — shown separately, still counted in the
  -- community total (vma_vote_totals is unchanged). `streams` (today) is still
  -- reported on each row for display, but no longer decides the ranking.
  select json_build_object(
    'ranked', coalesce((
      select json_agg(json_build_object(
        'name', name, 'total', total, 'today', today, 'week', week, 'month', month, 'streams', streams,
        'lisa_total', lisa_total, 'lisa_today', lisa_today, 'lisa_week', lisa_week, 'lisa_month', lisa_month,
        'bp_total', bp_total, 'bp_today', bp_today, 'bp_week', bp_week, 'bp_month', bp_month
      ) order by total desc)
      from numbered where ever_streams >= 1), '[]'::json),
    'unranked', coalesce((
      select json_agg(json_build_object(
        'name', name, 'total', total, 'today', today, 'week', week, 'month', month, 'streams', streams,
        'lisa_total', lisa_total, 'lisa_today', lisa_today, 'lisa_week', lisa_week, 'lisa_month', lisa_month,
        'bp_total', bp_total, 'bp_today', bp_today, 'bp_week', bp_week, 'bp_month', bp_month
      ) order by total desc)
      from numbered where ever_streams < 1), '[]'::json)
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
