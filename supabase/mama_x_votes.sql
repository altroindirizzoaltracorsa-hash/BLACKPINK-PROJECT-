-- MAMA Fans' Choice — X votes, one per X account per day.
--
-- Mnet counts X votes as ONE PER ACCOUNT PER DAY: post, repost and quote all
-- collapse to a single vote. So the thing being counted here is not "votes
-- logged" like the VMA/BreakTudo/KCA tables — it is DISTINCT X ACCOUNTS, and
-- the uniqueness is the whole point of the table rather than a rule the API
-- remembers to apply.
--
-- Hence the primary key: (x_user_id, day). Not app_user_id. A blink with two
-- Blinks United accounts who links the same X account to both is one vote,
-- because Mnet sees one account. Making the X account the key means a second
-- row cannot exist — the database refuses it, not a code path that could be
-- skipped by a retry, a double tap or a second device.
--
-- `day` is the KST calendar date, because that is the day Mnet's reset follows.
--
-- Apply with the "Apply SQL" workflow: file = supabase/mama_x_votes.sql.
-- Idempotent: safe to re-apply.

create table if not exists mama_x_votes (
  -- The X account, from the Supabase identity (identity_data->>'provider_id').
  -- Text, not bigint: it is an opaque id from someone else's system.
  x_user_id   text        not null,
  day         date        not null,
  -- Which Blinks United account logged it. Not part of the key — it is for
  -- "my days" and for the board, and two of them may share one X account.
  app_user_id uuid        not null,
  -- Handle at the time of voting, for the board. Handles change; the id does
  -- not, which is why the id is what counts.
  x_handle    text,
  -- MAMA runs two rounds with a gap between them. Stored so a round's total can
  -- be read back without knowing the dates later.
  round       smallint,
  created_at  timestamptz not null default now(),
  primary key (x_user_id, day)
);

create index if not exists mama_x_votes_day_idx  on mama_x_votes (day);
create index if not exists mama_x_votes_user_idx on mama_x_votes (app_user_id);

-- Service role only. Every read and write goes through /api/mama-votes, which
-- is also where the X identity is resolved — the browser never asserts which X
-- account it is, or the key would protect nothing.
alter table mama_x_votes enable row level security;

-- ── the community numbers ───────────────────────────────────────────────────
-- One call rather than three round trips. `today` is the number that matters:
-- distinct X accounts that have voted on the current KST day.
create or replace function mama_vote_totals(p_day date)
returns json
language sql
stable
as $$
  select json_build_object(
    'day',     p_day,
    'today',   (select count(*)                from mama_x_votes where day = p_day),
    'accounts',(select count(distinct x_user_id) from mama_x_votes),
    'votes',   (select count(*)                from mama_x_votes),
    'days',    coalesce((
      select json_agg(d order by d.day)
      from (
        select day, count(*) as n
        from mama_x_votes
        group by day
        order by day desc
        limit 40
      ) d
    ), '[]'::json)
  );
$$;

-- ── the board ───────────────────────────────────────────────────────────────
-- Ranked by DAYS VOTED, not by a vote count: with a cap of one a day, the only
-- thing a blink can do more of is turn up again tomorrow. Which is also exactly
-- what the campaign needs.
create or replace function mama_vote_board(p_limit int default 100)
returns json
language sql
stable
as $$
  select coalesce(json_agg(r order by r.days desc, r.last_day desc), '[]'::json)
  from (
    select
      coalesce(max(x_handle), '')     as handle,
      count(*)                        as days,
      max(day)                        as last_day
    from mama_x_votes
    group by x_user_id
    order by days desc, last_day desc
    limit p_limit
  ) r;
$$;

-- ── grants ──────────────────────────────────────────────────────────────────
-- Enabling RLS is not the same as granting access, and the two fail in
-- different ways. service_role BYPASSES row-level security, so the policies
-- are irrelevant to it — but it still needs ordinary table privileges, and a
-- table created over a direct psql connection does not pick up Supabase's
-- default grants. The symptom was "permission denied for table mama_x_votes"
-- on the very first read, with RLS looking like the obvious suspect and having
-- nothing to do with it.
--
-- service_role only. anon and authenticated are deliberately left with no
-- access at all: every read and write goes through /api/mama-votes, because
-- that is where the X identity is resolved from the caller's token. A browser
-- that could write this table directly could name any X account it liked, and
-- the primary key would be guarding nothing.
grant usage on schema public to service_role;
grant select, insert, update, delete on table mama_x_votes to service_role;

-- The two readers run as the caller (security invoker), so they need the same
-- grant to be useful, and execute on top.
grant execute on function mama_vote_totals(date) to service_role;
grant execute on function mama_vote_board(int)  to service_role;
