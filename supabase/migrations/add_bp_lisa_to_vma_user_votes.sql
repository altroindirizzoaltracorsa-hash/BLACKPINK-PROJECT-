-- Split the VMA vote leaderboard into LISA (Best Pop / Best K-Pop) vs BLACKPINK
-- (JUMP, Best K-Pop). The `votes` column stays the authoritative TOTAL used for
-- ranking; `bp` + `lisa` hold the attributed breakdown (legacy rows logged before
-- this migration keep their votes total with bp = lisa = 0, i.e. "unattributed").
--
-- Run once in the Supabase SQL editor. Safe to re-run (idempotent).

alter table vma_user_votes add column if not exists bp   int not null default 0 check (bp   >= 0);
alter table vma_user_votes add column if not exists lisa int not null default 0 check (lisa >= 0);

-- Community totals now also carry the LISA / BP split (all-time + today, ET day).
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

-- Ranked board — unchanged ranking (by combined `total`), now also returning each
-- account's LISA / BP split per period so the board can show them as columns.
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
    select distinct on (app_user_id) app_user_id, display_name
    from vma_user_votes
    where display_name is not null and display_name <> ''
    order by app_user_id, day desc, updated_at desc
  ),
  handles as (
    select distinct on (la.app_user_id)
      la.app_user_id::text as app_user_id, la.source_username
    from linked_accounts la
    where la.source_username is not null and la.source_username <> ''
    order by la.app_user_id, (la.source = 'lastfm') desc, la.created_at desc
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
  joined as (
    select
      u.total, u.today, u.week, u.month,
      u.lisa_total, u.lisa_today, u.lisa_week, u.lisa_month,
      u.bp_total, u.bp_today, u.bp_week, u.bp_month,
      u.first_day, u.app_user_id,
      n.display_name,
      h.source_username as handle,
      coalesce(s.today_streams, 0) as streams
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
        'name', name, 'total', total, 'today', today, 'week', week, 'month', month, 'streams', streams,
        'lisa_total', lisa_total, 'lisa_today', lisa_today, 'lisa_week', lisa_week, 'lisa_month', lisa_month,
        'bp_total', bp_total, 'bp_today', bp_today, 'bp_week', bp_week, 'bp_month', bp_month
      ) order by total desc)
      from numbered where streams >= 1), '[]'::json),
    'unranked', coalesce((
      select json_agg(json_build_object(
        'name', name, 'total', total, 'today', today, 'week', week, 'month', month, 'streams', streams,
        'lisa_total', lisa_total, 'lisa_today', lisa_today, 'lisa_week', lisa_week, 'lisa_month', lisa_month,
        'bp_total', bp_total, 'bp_today', bp_today, 'bp_week', bp_week, 'bp_month', bp_month
      ) order by total desc)
      from numbered where streams < 1), '[]'::json)
  );
$$;

grant execute on function vma_vote_totals() to service_role;
grant execute on function vma_vote_board()  to service_role;
