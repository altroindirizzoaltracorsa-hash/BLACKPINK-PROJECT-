-- Report each row's ALL-TIME streams alongside the voting day's.
--
-- `streams` is the current voting day's count, which is what the live board
-- wants. Once an award CLOSES, that column reads 0 for everyone the moment the
-- day rolls over, so a final standings table would show a full column of zeros.
-- ever_streams is already computed here (it is the ranking gate: has this
-- account ever streamed) and simply was not reported; exposing it lets a closed
-- board show a number that stays true.
--
-- Additive only: `streams` keeps its exact meaning, so the live board and
-- anything else reading these rows is unaffected.
--
-- Generated from supabase/vma_user_votes.sql by substitution rather than
-- retyped, so the body cannot drift from the definition it is based on.
--
-- Run once. Safe to re-run (create or replace).

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
      -- All tracked campaign columns (incl. ltal + the newer solo releases). The
      -- ever_streams sum is the rank gate; today_streams is display only. newtrick
      -- (ROSÉ) is included so a blink streaming it counts toward voting eligibility.
      sum(coalesce(jump,0)+coalesce(shutdown,0)+coalesce(ddududu,0)+coalesce(ltal,0)+coalesce(go,0)
          +coalesce(sawadika,0)+coalesce(click,0)+coalesce(fallenangel,0)+coalesce(heaven,0)+coalesce(newtrick,0))  as all_streams,
      sum((coalesce(jump,0)+coalesce(shutdown,0)+coalesce(ddududu,0)+coalesce(ltal,0)+coalesce(go,0)
           +coalesce(sawadika,0)+coalesce(click,0)+coalesce(fallenangel,0)+coalesce(heaven,0)+coalesce(newtrick,0)))
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
        'ever_streams', ever_streams,
        'lisa_total', lisa_total, 'lisa_today', lisa_today, 'lisa_week', lisa_week, 'lisa_month', lisa_month,
        'bp_total', bp_total, 'bp_today', bp_today, 'bp_week', bp_week, 'bp_month', bp_month
      ) order by total desc)
      from numbered where ever_streams >= 1), '[]'::json),
    'unranked', coalesce((
      select json_agg(json_build_object(
        'name', name, 'total', total, 'today', today, 'week', week, 'month', month, 'streams', streams,
        'ever_streams', ever_streams,
        'lisa_total', lisa_total, 'lisa_today', lisa_today, 'lisa_week', lisa_week, 'lisa_month', lisa_month,
        'bp_total', bp_total, 'bp_today', bp_today, 'bp_week', bp_week, 'bp_month', bp_month
      ) order by total desc)
      from numbered where ever_streams < 1), '[]'::json)
  );
$$;

grant execute on function vma_vote_board() to service_role;
