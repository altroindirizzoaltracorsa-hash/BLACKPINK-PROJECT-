-- Scale every stored BLACKPINK/LISA split down to fit its own vote total.
--
-- api/vma-votes.js capped each half at 10,000 on its own, derived the total from
-- their sum, and only then capped the total — so one submission of bp=8000 +
-- lisa=8000 stored a 16,000 breakdown against a 10,000 total. Enough of those
-- and the board showed 16,000 + 16,000 beside 20,000 votes. The handler now
-- scales the halves with the total; this fixes the rows written before that.
--
-- `votes` is authoritative and is NOT touched: the cap on it is deliberate
-- policy, and it is the column the board ranks on. Only the two halves move, and
-- only downwards, keeping the proportions they were stored in. Nobody's vote
-- count or position changes — the split columns simply stop overstating.
--
-- Rows where the split is UNDER the total are left exactly alone: those are
-- votes logged with no breakdown at all, counted but unattributed, which is by
-- design and not the same thing.
--
-- Transactional, guarded, and a no-op on a second run.

begin;

\echo '=== before ==='
select count(*) as rows_over_total,
       sum((bp + lisa) - votes) as total_excess,
       max((bp + lisa) - votes) as worst_row
from vma_user_votes
where bp + lisa > votes;

-- Largest-remainder: bp takes its share rounded down, lisa takes the rest, so
-- the two add to `votes` exactly rather than drifting by a rounding unit.
update vma_user_votes
set bp   = floor(bp::numeric * votes / (bp + lisa)),
    lisa = votes - floor(bp::numeric * votes / (bp + lisa))
where bp + lisa > votes
  and votes >= 0
  and bp + lisa > 0;

\echo ''
\echo '=== after ==='
select count(*) filter (where bp + lisa > votes) as still_over_total,
       count(*) filter (where bp + lisa < votes) as under_total_by_design,
       count(*) filter (where bp + lisa = votes) as exact,
       count(*) filter (where bp < 0 or lisa < 0) as negative
from vma_user_votes;

do $$
declare bad int; neg int;
begin
  select count(*) into bad from vma_user_votes where bp + lisa > votes;
  if bad > 0 then
    raise exception '% row(s) still have a split above their total', bad;
  end if;
  select count(*) into neg from vma_user_votes where bp < 0 or lisa < 0;
  if neg > 0 then
    raise exception '% row(s) ended up negative', neg;
  end if;
  raise notice 'every split now fits inside its total';
end $$;

commit;

\echo ''
\echo '=== the board totals that were disagreeing ==='
select app_user_id,
       sum(votes) as votes, sum(bp) as bp, sum(lisa) as lisa,
       sum(bp) + sum(lisa) - sum(votes) as split_minus_total
from vma_user_votes
group by app_user_id
having sum(bp) + sum(lisa) > sum(votes)
order by 5 desc
limit 10;
