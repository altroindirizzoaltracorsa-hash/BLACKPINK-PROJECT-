-- BreakTudo board: move the day boundary from Brasília to midnight KST.
--
-- WHY. BreakTudo has no daily vote cap and no daily reset — votes are uncapped
-- and cumulative, so unlike the VMAs there is no externally-imposed instant when
-- "today" ends. The original choice of Brasília (America/Sao_Paulo) was reasoning
-- from the award's own country. But nothing on BreakTudo's side rolls at that
-- hour, so it bought no alignment; it just put our day bucket on a clock none of
-- the blinks reading the board live on. Midnight KST is the convention the rest
-- of this fandom counts days on, so that is the one we adopt.
--
-- This is a DISPLAY boundary only. It decides which rows fall in the today /
-- week / month buckets. It does not touch `votes`, does not change all-time
-- totals, and does not change the ranking — breaktudo_vote_board() still orders
-- by the combined all-time total, which is a sum over every day and therefore
-- boundary-independent.
--
-- HISTORY IS NOT RE-BUCKETED, deliberately. breaktudo_user_votes is one row per
-- (blink, day) with votes MERGED into it across that day, so a row carries no
-- per-vote timestamps and cannot be re-dated without inventing them. Rows written
-- before this migration keep their Brasília dates; rows written after it get KST
-- ones. The two conventions agree whenever UTC is between 03:00 and 15:00 and
-- differ by one day outside that window, so the seam affects at most the
-- transition day's today/week/month edges. All-time totals and ranking are
-- unaffected either way, which is why re-dating was not worth guessing at.
--
-- Asia/Seoul has no DST and has been a fixed UTC+9 for the whole life of this
-- data, so unlike the ET boundary on the VMA side there is no offset to track.
--
-- Run once. Safe to re-run (create or replace + a verification block).

-- ── 1. the column default ───────────────────────────────────────────────────
-- /api/vma-votes always passes `day` explicitly, so this is belt-and-braces —
-- but a default that disagreed with the functions would be a trap for whatever
-- writes here next.
alter table breaktudo_user_votes
  alter column day set default (now() at time zone 'Asia/Seoul')::date;

-- ── 2. community totals ─────────────────────────────────────────────────────
-- Body identical to add_categories_to_breaktudo_user_votes.sql apart from the
-- timezone in today_bounds.
create or replace function breaktudo_vote_totals()
returns json
language sql
stable
as $$
  with today_bounds as (
    select (now() at time zone 'Asia/Seoul')::date as d
  ),
  cat_all as (
    select e.key as k, sum((e.value)::numeric)::bigint as v
    from breaktudo_user_votes b, jsonb_each(b.cats) e
    group by e.key
  ),
  cat_today as (
    select e.key as k, sum((e.value)::numeric)::bigint as v
    from breaktudo_user_votes b, today_bounds t, jsonb_each(b.cats) e
    where b.day = t.d
    group by e.key
  )
  select json_build_object(
    'total',       coalesce((select sum(votes) from breaktudo_user_votes), 0),
    'today',       coalesce((select sum(votes) from breaktudo_user_votes b, today_bounds t where b.day = t.d), 0),
    'blinksTotal', (select count(distinct app_user_id) from breaktudo_user_votes),
    'blinksToday', (select count(distinct app_user_id) from breaktudo_user_votes b, today_bounds t where b.day = t.d),
    'byCat',       coalesce((select jsonb_object_agg(k, v) from cat_all),   '{}'::jsonb),
    'byCatToday',  coalesce((select jsonb_object_agg(k, v) from cat_today), '{}'::jsonb)
  );
$$;

grant execute on function breaktudo_vote_totals() to service_role;

-- ── 3. the ranked board ─────────────────────────────────────────────────────
-- Body identical to add_categories_to_breaktudo_vote_board.sql apart from the
-- three timezones in `bounds`. Note `streams` uses the same bounds, so a blink's
-- "today's streams" column moves onto the KST day with everything else rather
-- than being read against a different clock from the votes beside it.
create or replace function breaktudo_vote_board()
returns json
language sql
stable
as $$
  with bounds as (
    select
      (now() at time zone 'Asia/Seoul')::date                       as d_today,
      date_trunc('week',  now() at time zone 'Asia/Seoul')::date    as d_week,
      date_trunc('month', now() at time zone 'Asia/Seoul')::date    as d_month
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

-- ── 4. verification ─────────────────────────────────────────────────────────
-- A silent create-or-replace that left one function behind on the old clock
-- would show up as today/week counts that disagree between the community bar and
-- the ranked table for twelve hours a day — the kind of thing nobody reports
-- because each number looks plausible alone. So assert it instead.
do $$
declare
  n_seoul int;
  n_sp    int;
  col_def text;
begin
  select count(*) into n_seoul
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public'
    and p.proname in ('breaktudo_vote_totals', 'breaktudo_vote_board')
    and p.prosrc like '%Asia/Seoul%';

  select count(*) into n_sp
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public'
    and p.proname in ('breaktudo_vote_totals', 'breaktudo_vote_board')
    and p.prosrc like '%America/Sao_Paulo%';

  if n_seoul <> 2 or n_sp <> 0 then
    raise exception
      'breaktudo functions not fully on Asia/Seoul: % of 2 mention Asia/Seoul, % still mention America/Sao_Paulo',
      n_seoul, n_sp;
  end if;

  select pg_get_expr(d.adbin, d.adrelid) into col_def
  from pg_attrdef d
  join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
  where d.adrelid = 'breaktudo_user_votes'::regclass and a.attname = 'day';

  if col_def is null or col_def not like '%Asia/Seoul%' then
    raise exception 'breaktudo_user_votes.day default is %, expected an Asia/Seoul expression', coalesce(col_def, '(none)');
  end if;

  raise notice 'BreakTudo day boundary now midnight KST. Today (KST) = %, was (Brasília) = %.',
    (now() at time zone 'Asia/Seoul')::date,
    (now() at time zone 'America/Sao_Paulo')::date;
end $$;
