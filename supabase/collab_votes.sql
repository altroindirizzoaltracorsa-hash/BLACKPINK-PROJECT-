-- Votes cast through a fandom collab (see /collabs).
--
-- ITS OWN TABLE, not a column on kca_user_votes, for the reason this repo has
-- learned twice already: those tables carry site-visible meaning and widening
-- one is how a wrong row ends up on a page. Concretely, `kca_user_votes.votes`
-- is the number that ranks the Kids' Choice board and earns the Voter badge.
-- A pick for a PARTNER's nominee is not a BLACKPINK vote, and putting it in
-- that column would raise a blink's BLACKPINK standing for voting BINI.
--
-- So: nothing here is ever read by the KCA board, and nothing in kca_user_votes
-- is ever read by the collab board. Two dimensions, two tables.
--
-- WHAT A ROW IS. One account, one collab, one day, with `cats` holding that
-- day's picks per ballot category — every category in the collab, ours and
-- theirs alike, because the collab counts the whole pass. `votes` is their sum,
-- stored rather than derived so the board can order without unpacking jsonb.
--
-- DAY BOUNDARY: midnight KST, matching kca_user_votes and the rest of the vote
-- tables. The collab has no externally-imposed reset to align to, and this is
-- the clock the fandom counts days on.
--
-- Apply with: Actions → Apply SQL → file: supabase/collab_votes.sql
-- Idempotent, so re-applying is safe.

create table if not exists collab_user_votes (
  collab_id    text  not null,
  app_user_id  uuid  not null,
  day          date  not null default ((now() at time zone 'Asia/Seoul')::date),
  votes        int   not null default 0,
  cats         jsonb not null default '{}'::jsonb,
  display_name text,
  updated_at   timestamptz not null default now(),
  ext_at       timestamptz,
  primary key (collab_id, app_user_id, day)
);

-- The board reads every row of one collab and the day grid reads every day of
-- it, so both of those are the hot path.
create index if not exists collab_user_votes_collab_day_idx
  on collab_user_votes (collab_id, day);
create index if not exists collab_user_votes_collab_user_idx
  on collab_user_votes (collab_id, app_user_id);

-- Service-role only. The API is the single writer and it authenticates every
-- caller itself; no anon client has any business reaching this directly.
alter table collab_user_votes enable row level security;

-- `votes` must equal the sum of `cats`, or a board ordered by `votes` disagrees
-- with the breakdown printed underneath it. Enforced rather than trusted: the
-- API computes both, and a bug there would otherwise show as a row whose chips
-- do not add up to its own total.
create or replace function collab_votes_sum(c jsonb) returns int
language sql immutable as $$
  select coalesce(sum((value)::int), 0)::int
  from jsonb_each_text(coalesce(c, '{}'::jsonb))
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'collab_user_votes_sum_matches'
  ) then
    alter table collab_user_votes
      add constraint collab_user_votes_sum_matches
      check (votes = collab_votes_sum(cats));
  end if;
end $$;
