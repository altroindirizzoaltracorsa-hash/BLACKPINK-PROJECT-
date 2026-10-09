-- Kids' Choice Awards 2026 board: its own table and its own two RPCs.
--
-- Deliberately a THIRD award dimension rather than another column on the
-- BreakTudo tables, for the same reason group_track_daily_stats is separate
-- from track_daily_stats: those tables carry site-visible meaning, and widening
-- them is how a wrong row ends up on a page. A KCA vote is not a BreakTudo vote
-- and shares nothing with one but its shape.
--
--
-- WHAT A "VOTE" IS HERE, AND WHY IT IS NOT A ROUND.
--
-- The KCA ballot does not submit per category. Nickelodeon's published rules:
-- "The site will guide you to the next category… Your selections are sent for
-- submission at the end of the round." So one submission carries up to one pick
-- per category, and a blink who completes a round having picked BLACKPINK, ROSÉ
-- and Dracula has cast THREE votes that matter to us, not one.
--
-- So `votes` counts per-category picks for OUR nominees, exactly as it does on
-- the BreakTudo side, and `cats` breaks it down by category slug. That keeps the
-- two boards reading in the same unit and means the existing panel arithmetic
-- transfers unchanged. A round in which a blink voted in all three of our
-- categories is 3; a round where they only did Favorite Female Artist is 1.
--
--
-- DAY BOUNDARY: midnight KST, from the start.
--
-- The BreakTudo table had to be migrated onto this boundary afterwards
-- (breaktudo_day_boundary_kst.sql) and carries a seam in its history because of
-- it. There is no reason to repeat that: KCA's own rules say closing times
-- "may differ by region", so there is no single externally-imposed instant to
-- align to, and midnight KST is the convention this fandom counts days on.
-- Asia/Seoul is a fixed UTC+9 with no DST, so there is no offset to track.
--
-- Run once. Safe to re-run.

create table if not exists kca_user_votes (
  app_user_id  uuid        not null,
  day          date        not null default (now() at time zone 'Asia/Seoul')::date,
  -- Per-category picks for our nominees, summed across every round that day.
  votes        integer     not null default 0 check (votes >= 0),
  -- { '<category-slug>': n }. The slugs are the ones kca.nick.tv serves —
  -- favorite-music-group-or-duo / favorite-female-artist /
  -- favorite-music-collaboration — confirmed live in probe-kca.yml.
  cats         jsonb       not null default '{}'::jsonb,
  display_name text,
  -- When the browser extension last reported for this row, as opposed to the
  -- blink typing it in. Null means every vote in it was logged by hand.
  ext_at       timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (app_user_id, day)
);

create index if not exists kca_user_votes_day_idx  on kca_user_votes (day);
create index if not exists kca_user_votes_user_idx on kca_user_votes (app_user_id);

-- ── community totals ────────────────────────────────────────────────────────
create or replace function kca_vote_totals()
returns json
language sql
stable
as $$
  with today_bounds as (
    select (now() at time zone 'Asia/Seoul')::date as d
  ),
  cat_all as (
    select e.key as k, sum((e.value)::numeric)::bigint as v
    from kca_user_votes b, jsonb_each(b.cats) e
    group by e.key
  ),
  cat_today as (
    select e.key as k, sum((e.value)::numeric)::bigint as v
    from kca_user_votes b, today_bounds t, jsonb_each(b.cats) e
    where b.day = t.d
    group by e.key
  )
  select json_build_object(
    'total',       coalesce((select sum(votes) from kca_user_votes), 0),
    'today',       coalesce((select sum(votes) from kca_user_votes b, today_bounds t where b.day = t.d), 0),
    'blinksTotal', (select count(distinct app_user_id) from kca_user_votes),
    'blinksToday', (select count(distinct app_user_id) from kca_user_votes b, today_bounds t where b.day = t.d),
    'byCat',       coalesce((select jsonb_object_agg(k, v) from cat_all),   '{}'::jsonb),
    'byCatToday',  coalesce((select jsonb_object_agg(k, v) from cat_today), '{}'::jsonb)
  );
$$;

grant execute on function kca_vote_totals() to service_role;

-- ── the ranked board ────────────────────────────────────────────────────────
-- Same shape the BreakTudo board returns, so the panel that renders one renders
-- the other: per-blink totals for each period, plus the per-category breakdown
-- rolled up per period.
create or replace function kca_vote_board()
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
      coalesce(sum(votes) filter (where day = (select d_today from bounds)), 0)  as today,
      coalesce(sum(votes) filter (where day >= (select d_week from bounds)), 0)  as week,
      coalesce(sum(votes) filter (where day >= (select d_month from bounds)), 0) as month,
      min(day)                                                      as first_day,
      max(ext_at)                                                   as last_ext
    from kca_user_votes
    group by app_user_id
  ),
  per_user_cat as (
    select
      b.app_user_id,
      e.key                                                                       as k,
      sum((e.value)::numeric)::bigint                                             as v_total,
      coalesce(sum((e.value)::numeric) filter (where b.day = (select d_today from bounds)), 0)::bigint as v_today,
      coalesce(sum((e.value)::numeric) filter (where b.day >= (select d_week from bounds)), 0)::bigint as v_week,
      coalesce(sum((e.value)::numeric) filter (where b.day >= (select d_month from bounds)), 0)::bigint as v_month
    from kca_user_votes b, jsonb_each(b.cats) e
    group by b.app_user_id, e.key
  ),
  -- The FILTER drops zero entries, so a category a blink has not voted in this
  -- period simply is not in that period's map rather than sitting there as a 0
  -- the page would have to hide.
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
    from kca_user_votes
    where display_name is not null
    order by app_user_id, day desc, updated_at desc
  )
  select coalesce(json_agg(row_to_json(x) order by x.total desc, x."firstDay" asc), '[]'::json)
  from (
    select
      p.app_user_id                                as id,
      n.display_name                               as name,
      p.total::bigint                              as total,
      p.today::bigint                              as today,
      p.week::bigint                               as week,
      p.month::bigint                              as month,
      p.first_day                                  as "firstDay",
      (p.last_ext is not null)                     as "usedExtension",
      coalesce(c.cats_total, '{}'::jsonb)          as cats,
      coalesce(c.cats_today, '{}'::jsonb)          as "catsToday",
      coalesce(c.cats_week,  '{}'::jsonb)          as "catsWeek",
      coalesce(c.cats_month, '{}'::jsonb)          as "catsMonth"
    from per_user p
    left join latest_name n on n.app_user_id = p.app_user_id
    left join cats_rolled c on c.app_user_id = p.app_user_id
  ) x;
$$;

grant execute on function kca_vote_board() to service_role;

-- Written only through /api/vma-votes with the service key. RLS on with no
-- policies is what locks anon/authenticated out: Supabase grants those roles on
-- every NEW table in schema public by default, so withholding a grant is not
-- enough on its own.
alter table kca_user_votes enable row level security;
grant all privileges on table kca_user_votes to service_role;

do $$
declare n int;
begin
  select count(*) into n from kca_user_votes;
  raise notice 'kca_user_votes: % row(s). totals=% board=%',
    n,
    (select (kca_vote_totals()->>'total')),
    (select json_array_length(kca_vote_board()));
end $$;
