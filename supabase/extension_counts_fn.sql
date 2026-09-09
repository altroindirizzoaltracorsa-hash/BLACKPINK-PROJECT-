-- Aggregate counts for a profile's extension_scrobbles, done in the database so
-- it scales to unlimited rows: returns 5 rows (one per track) instead of every
-- play, at constant speed no matter how large the table grows. Replaces the
-- fetch-all-rows-and-tally approach that was capped at 1000 rows per query.
--
-- SECURITY INVOKER (the default): RLS on extension_scrobbles still applies, so a
-- logged-in user only ever gets their own counts even if they pass another uid;
-- the service-role key (server) bypasses RLS and can count any profile.
--
-- "today" = plays since day_from; "week" = plays since week_from. No upper bound
-- is needed because plays are never in the future.

create or replace function extension_counts(uid uuid, day_from timestamptz, week_from timestamptz)
returns table (track_id text, total bigint, today bigint, week bigint, last_at timestamptz)
language sql
stable
as $$
  select
    track_id,
    count(*)::bigint                                                as total,
    (count(*) filter (where listened_at >= day_from))::bigint       as today,
    (count(*) filter (where listened_at >= week_from))::bigint      as week,
    max(listened_at)                                                as last_at
  from extension_scrobbles
  where app_user_id = uid
  group by track_id;
$$;

grant execute on function extension_counts(uuid, timestamptz, timestamptz) to authenticated;

-- Per-day-of-week split for the CURRENT week, used only to fill the profile's
-- "This week's challenge (Mon–Sun)" grid cells. day_index 0 = Monday … 6 =
-- Sunday, relative to week_from (the Monday-2am week start the client passes).
create or replace function extension_week_days(uid uuid, week_from timestamptz)
returns table (track_id text, day_index int, cnt bigint)
language sql
stable
as $$
  select
    track_id,
    floor(extract(epoch from (listened_at - week_from)) / 86400)::int as day_index,
    count(*)::bigint as cnt
  from extension_scrobbles
  where app_user_id = uid and listened_at >= week_from
  group by track_id, day_index;
$$;

grant execute on function extension_week_days(uuid, timestamptz) to authenticated;
