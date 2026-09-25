-- Per-category detail on the BreakTudo LEADERBOARD, not just on your own card.
--
-- The first category migration deliberately left breaktudo_vote_board() alone,
-- reasoning that eight categories x four periods is 32 numbers per blink and no
-- table can show that. That reasoning was about COLUMNS. The board can carry the
-- detail as one map per period instead — four jsonb values per row, not 32
-- columns — and the page renders only the categories a blink actually voted,
-- under their name, for whichever period is selected. So the objection does not
-- apply and the leaderboard now carries the split.
--
-- Ranking is unchanged: still by the combined `votes` total. These maps are
-- display detail only.
--
-- As everywhere else, sum(cats_*) <= the matching total: rows written before
-- per-category tracking carry a total with no detail. The page shows the
-- remainder rather than implying the parts add up.
--
-- Run once. Safe to re-run (create or replace).

create or replace function breaktudo_vote_board()
returns json
language sql
stable
as $$
  with bounds as (
    select
      (now() at time zone 'America/Sao_Paulo')::date                       as d_today,
      date_trunc('week',  now() at time zone 'America/Sao_Paulo')::date    as d_week,
      date_trunc('month', now() at time zone 'America/Sao_Paulo')::date    as d_month
  ),
  per_user as (
    select
      app_user_id,
      sum(votes)                                                    as total,
      sum(votes) filter (where day = (select d_today from bounds))  as today,
      sum(votes) filter (where day >= (select d_week from bounds))  as week,
      sum(votes) filter (where day >= (select d_month from bounds)) as month,
      min(day)                                                      as first_day
    from breaktudo_user_votes
    group by app_user_id
  ),
  -- One row per (blink, category) with that pair summed over each period.
  per_user_cat as (
    select
      b.app_user_id,
      e.key                                                                       as k,
      sum((e.value)::numeric)::bigint                                             as v_total,
      coalesce(sum((e.value)::numeric) filter (where b.day = (select d_today from bounds)), 0)::bigint as v_today,
      coalesce(sum((e.value)::numeric) filter (where b.day >= (select d_week from bounds)), 0)::bigint as v_week,
      coalesce(sum((e.value)::numeric) filter (where b.day >= (select d_month from bounds)), 0)::bigint as v_month
    from breaktudo_user_votes b, jsonb_each(b.cats) e
    group by b.app_user_id, e.key
  ),
  -- Rolled back up into one map per period. The FILTER drops zero entries so a
  -- category a blink has not voted this period simply is not in that period's
  -- map, rather than sitting there as a 0 the page would have to hide.
  cats_rolled as (
    select
      app_user_id,
      coalesce(jsonb_object_agg(k, v_total) filter (where v_total > 0), '{}'::jsonb) as cats_total,
      coalesce(jsonb_object_agg(k, v_today) filter (where v_today > 0), '{}'::jsonb) as cats_today,
      coalesce(jsonb_object_agg(k, v_week)  filter (where v_week  > 0), '{}'::jsonb) as cats_week,
      coalesce(jsonb_object_agg(k, v_month) filter (where v_month > 0), '{}'::jsonb) as cats_month
    from per_user_cat
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
        filter (where day_key::date = (select d_today from bounds))                 as today_streams
    from user_daily_counts
    group by app_user_id
  ),
  joined as (
    select
      u.total, u.today, u.week, u.month, u.first_day, u.app_user_id,
      n.display_name,
      h.source_username as handle,
      coalesce(s.today_streams, 0) as streams,
      coalesce(s.all_streams, 0)   as ever_streams,
      coalesce(c.cats_total, '{}'::jsonb) as cats_total,
      coalesce(c.cats_today, '{}'::jsonb) as cats_today,
      coalesce(c.cats_week,  '{}'::jsonb) as cats_week,
      coalesce(c.cats_month, '{}'::jsonb) as cats_month
    from per_user u
    left join latest_name n using (app_user_id)
    left join handles h on h.app_user_id = u.app_user_id::text
    left join streams s on s.app_user_id = u.app_user_id::text
    -- Explicit ON, not USING: `handles` has already contributed its own
    -- app_user_id to the left side, so a second USING on that name is ambiguous
    -- ("common column name appears more than once in left table").
    left join cats_rolled c on c.app_user_id = u.app_user_id
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
        'cats_total', cats_total, 'cats_today', cats_today, 'cats_week', cats_week, 'cats_month', cats_month
      ) order by total desc)
      from numbered where ever_streams >= 1), '[]'::json),
    'unranked', coalesce((
      select json_agg(json_build_object(
        'name', name, 'total', total, 'today', today, 'week', week, 'month', month, 'streams', streams,
        'cats_total', cats_total, 'cats_today', cats_today, 'cats_week', cats_week, 'cats_month', cats_month
      ) order by total desc)
      from numbered where ever_streams < 1), '[]'::json)
  );
$$;

grant execute on function breaktudo_vote_board() to service_role;
