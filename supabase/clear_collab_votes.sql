-- Clear one collab's board, by id.
--
-- Run once, deliberately: the Kids' Choice trade was voted through while
-- /collabs was still unpublished, to prove the counter actually recorded a
-- BINI pick after the "Asia: BINI" fix. Those rounds were a test, and a board
-- that opens to the public with somebody's test votes already on it is a board
-- nobody can read — the first number anyone sees would be wrong.
--
-- SCOPED TO ONE collab_id AND NOTHING ELSE. collab_user_votes is the only
-- table a collab writes to: no BLACKPINK total, rank or badge reads it (that
-- separation is the whole reason the table exists), so this cannot touch a
-- vote that counts toward anything else.
--
-- DO NOT RUN THIS ONCE A COLLAB IS PUBLIC AND COUNTING. It deletes real
-- people's logged votes, there is no soft delete, and nothing backs this table
-- up. Change `target` deliberately or not at all.
do $$
declare
  target constant text := 'bvp-kca-2026';
  n_rows int;
  n_votes int;
  n_other int;
begin
  select count(*), coalesce(sum(votes), 0) into n_rows, n_votes
    from collab_user_votes where collab_id = target;
  raise notice 'before: collab % has % row(s), % vote(s)', target, n_rows, n_votes;

  delete from collab_user_votes where collab_id = target;

  select count(*) into n_rows from collab_user_votes where collab_id = target;
  select count(*) into n_other from collab_user_votes where collab_id <> target;
  raise notice 'after:  collab % has % row(s); % row(s) elsewhere in the table left alone',
    target, n_rows, n_other;
end $$;
