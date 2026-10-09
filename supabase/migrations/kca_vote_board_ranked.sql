-- KCA board: same {ranked, unranked} shape the BreakTudo board returns.
--
-- WHY THIS EXISTS. kca_vote_board.sql shipped the table and a FLAT board — one
-- array, ordered by total, named from display_name alone. That was enough to
-- verify the arithmetic, but it is not the shape /voting renders, and the three
-- differences are all visible on the page:
--
--   * NO RANKED/UNRANKED SPLIT. The rule across this whole board is "no stream =
--     no rank": a blink who votes but does not stream is listed, and counted,
--     under "Voters · not streaming — not ranked" rather than in the table. A
--     flat board puts them in the ranked table beside streamers, which is the
--     one thing that rule exists to prevent.
--   * NO STREAMS COLUMN. The table has a Streams column on every other award.
--   * NO NAME FALLBACK. display_name is null for anyone who never set one, so
--     every such blink rendered as the same "a blink". The BreakTudo board falls
--     back to the linked scrobbler handle and then to a stable blinkN.
--
-- So this is not new behaviour, it is the KCA board catching up to the one the
-- panel already knows how to draw — which is what kca_vote_board.sql's own
-- header claimed ("Same shape the BreakTudo board returns, so the panel that
-- renders one renders the other"). Body deliberately mirrors
-- breaktudo_day_boundary_kst.sql: same bounds, same handle filters, same stream
-- columns, same blinkN numbering. Divergence between the two boards is a bug,
-- so the diff between these two functions should stay readable as "the table
-- name, and `usedExtension`".
--
-- `usedExtension` is the one field KCA has and BreakTudo does not: kca_user_votes
-- carries ext_at from the start, so the board can say whether a row was counted
-- by the extension or typed in by hand.
--
-- The day boundary stays midnight KST, exactly as kca_vote_board.sql set it.
-- kca_vote_totals() is unchanged and is NOT redefined here.
--
-- Run after kca_vote_board.sql. Safe to re-run.

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
  -- period is ABSENT from that period's map rather than present as a 0 — the
  -- page keys off presence.
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
    where display_name is not null and display_name <> ''
    order by app_user_id, day desc, updated_at desc
  ),
  -- Same filters as the BreakTudo board: a scrobbler handle is only usable as a
  -- display name if it looks like a handle (no spaces, no URL, no pipe, short).
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
  -- Today's streams use the SAME KST bounds as the votes beside them, so the two
  -- columns in a row are never read off different clocks.
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
      (u.last_ext is not null)     as used_extension,
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
    -- app_user_id to the left side, so a second USING on that name is ambiguous.
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
        'usedExtension', used_extension, 'firstDay', first_day,
        'cats_total', cats_total, 'cats_today', cats_today, 'cats_week', cats_week, 'cats_month', cats_month
      ) order by total desc, first_day asc)
      from numbered where ever_streams >= 1), '[]'::json),
    'unranked', coalesce((
      select json_agg(json_build_object(
        'name', name, 'total', total, 'today', today, 'week', week, 'month', month, 'streams', streams,
        'usedExtension', used_extension, 'firstDay', first_day,
        'cats_total', cats_total, 'cats_today', cats_today, 'cats_week', cats_week, 'cats_month', cats_month
      ) order by total desc, first_day asc)
      from numbered where ever_streams < 1), '[]'::json)
  );
$$;

grant execute on function kca_vote_board() to service_role;

-- ── verification ────────────────────────────────────────────────────────────
-- A board left on the flat shape renders as an empty table rather than an
-- error — the page reads `.ranked` off an array and gets undefined — so assert
-- the shape rather than trusting that the replace took.
do $$
declare
  b json;
begin
  select kca_vote_board() into b;
  if json_typeof(b) <> 'object'
     or b->'ranked' is null or json_typeof(b->'ranked') <> 'array'
     or b->'unranked' is null or json_typeof(b->'unranked') <> 'array' then
    raise exception 'kca_vote_board() did not return {ranked:[], unranked:[]} — got %', json_typeof(b);
  end if;
  raise notice 'kca_vote_board(): % ranked, % unranked. kca_vote_totals total=%.',
    json_array_length(b->'ranked'),
    json_array_length(b->'unranked'),
    (kca_vote_totals()->>'total');
end $$;
