-- READ ONLY. What is actually in the MAMA vote table right now.
--
-- Run before deleting anything, so the delete is aimed at a row that has been
-- looked at rather than at a guess about which rows exist.
\echo '== every row =='
select
  day,
  x_handle,
  round,
  created_at,
  left(x_user_id, 4) || '…' as x_user_id_prefix   -- enough to tell rows apart
from mama_x_votes
order by created_at;

\echo ''
\echo '== totals the page would show =='
select count(*) as rows, count(distinct x_user_id) as accounts, count(distinct day) as days
from mama_x_votes;
