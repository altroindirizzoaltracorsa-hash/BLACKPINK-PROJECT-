-- Remove the ended agreement's category from the collab's stored votes.
--
--   Apply SQL  (apply-sql.yml)
--     file: supabase/migrations/repair_drop_animated_voice_category.sql
--
-- The BLINKs × BLOOMs trade briefly had a second agreement — Pauljjak, for Ahn
-- Hyo-seop in `favorite-animated-male-voice-from-a-movie` — which was called
-- off. The code stopped counting that category, and /collabs stopped rendering
-- it, but the picks already logged stayed in `cats` on every row. This takes
-- them out.
--
-- `votes` is recomputed rather than left alone: the table has a CHECK that
-- `votes = collab_votes_sum(cats)`, so removing a key without adjusting the
-- total would make every affected row fail its own constraint on the next
-- write — a vote failing to log days later, for a reason nothing would connect
-- to this.
--
-- Rows are printed BEFORE they change, so this log is the record of what was
-- removed. There is no backup table: the change is one key per row and the
-- notices below hold enough to put it back by hand if it ever had to be.
--
-- Re-runnable: after the first pass no row has the key, so the second finds
-- nothing and says so.

\set ON_ERROR_STOP on

do $$
declare
  k    text := 'favorite-animated-male-voice-from-a-movie';
  cid  text := 'bvp-kca-2026';
  r    record;
  n    int := 0;
  tot  int := 0;
begin
  for r in
    select app_user_id, day, votes, cats, (cats->>k)::int as dropping
    from collab_user_votes
    where collab_id = cid and cats ? k
    order by day, app_user_id
  loop
    n := n + 1;
    tot := tot + coalesce(r.dropping, 0);
    -- The person is identified by the first eight characters of their id: enough
    -- to tell two rows apart in this log, not enough to be an account id.
    raise notice 'day % · %… · votes % → % (removing % from %)',
      r.day, left(r.app_user_id::text, 8), r.votes,
      r.votes - coalesce(r.dropping, 0), coalesce(r.dropping, 0), k;
  end loop;

  if n = 0 then
    raise notice 'nothing to do: no row in % still carries %', cid, k;
    return;
  end if;

  update collab_user_votes
     set cats = cats - k,
         votes = collab_votes_sum(cats - k),
         updated_at = now()
   where collab_id = cid and cats ? k;

  raise notice '% row(s) changed, % vote(s) removed in total', n, tot;

  -- Proof rather than assumption: nothing left carrying the key, and every
  -- row's total still agreeing with its own breakdown.
  if exists (select 1 from collab_user_votes where collab_id = cid and cats ? k) then
    raise exception 'rows still carry % after the update', k;
  end if;
  if exists (
    select 1 from collab_user_votes
    where collab_id = cid and votes <> collab_votes_sum(cats)
  ) then
    raise exception 'a row''s votes no longer match its cats';
  end if;
  raise notice 'checked: the key is gone and every total still matches its breakdown';
end $$;
