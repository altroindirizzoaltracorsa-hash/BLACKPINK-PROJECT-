-- READ-ONLY: where does a blink's BLACKPINK+LISA split exceed their vote total?
--
-- Run through apply-sql.yml. SELECTs only.
--
-- The hypothesis. api/vma-votes.js derives the total from the split and then
-- bounds it, but bounds the two halves separately and first:
--
--   bp   = min(bp,   10000);
--   lisa = min(lisa, 10000);
--   votes = bp + lisa;
--   votes = Math.min(votes, 10000);   <- total capped, halves left alone
--
-- So a single submission of bp=8000, lisa=8000 stores votes=10,000 alongside
-- bp=8,000 and lisa=8,000 — a breakdown of 16,000 against a total of 10,000.
-- Two of those would land on exactly 16,000 / 16,000 / 20,000, which is what the
-- board shows for one blink.
--
-- If that is right, every offending row's excess is a multiple of the amount the
-- cap removed, and the split/total ratio never exceeds 2.

\echo '=== 1. rows where the split exceeds the total ==='
select day, votes, bp, lisa, bp + lisa as split_sum,
       (bp + lisa) - votes                      as excess,
       round((bp + lisa)::numeric / nullif(votes,0), 3) as ratio
from vma_user_votes
where bp + lisa > votes
order by excess desc
limit 25;

\echo ''
\echo '=== 2. how widespread is it? ==='
select count(*)                                             as rows_total,
       count(*) filter (where bp + lisa > votes)            as split_over_total,
       count(*) filter (where bp + lisa < votes)            as split_under_total,
       count(*) filter (where bp + lisa = votes)            as exact,
       count(*) filter (where bp = 0 and lisa = 0)          as no_split_recorded,
       max((bp + lisa) - votes)                             as worst_excess
from vma_user_votes;

\echo ''
\echo '=== 3. does any single row exceed the 10,000 cap? ==='
-- If the cap is doing its job on the total, no stored `votes` is above it; the
-- halves, never scaled to fit, are the ones that can sit above their share.
select count(*) filter (where votes > 10000) as votes_over_cap,
       count(*) filter (where bp    > 10000) as bp_over_cap,
       count(*) filter (where lisa  > 10000) as lisa_over_cap,
       max(votes) as max_votes, max(bp) as max_bp, max(lisa) as max_lisa
from vma_user_votes;

\echo ''
\echo '=== 4. the per-blink totals the board actually shows ==='
-- Board columns are sums over all of a blink's days, so a single bad day is
-- enough to make the displayed split disagree with the displayed total.
select v.app_user_id,
       sum(v.votes) as votes, sum(v.bp) as bp, sum(v.lisa) as lisa,
       sum(v.bp) + sum(v.lisa) - sum(v.votes) as excess,
       count(*) as days,
       count(*) filter (where v.bp + v.lisa > v.votes) as bad_days
from vma_user_votes v
group by v.app_user_id
having sum(v.bp) + sum(v.lisa) <> sum(v.votes)
order by abs(sum(v.bp) + sum(v.lisa) - sum(v.votes)) desc
limit 20;
