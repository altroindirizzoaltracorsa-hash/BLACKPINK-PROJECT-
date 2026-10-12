-- ONE-OFF. Remove the single test vote cast while checking the MAMA flow on a
-- preview deployment, so the account is not locked out of voting for real
-- until KST midnight.
--
-- Guarded rather than trusting. probe_mama_votes.sql was run first and showed
-- exactly one row; this refuses to delete unless that is still true. Between
-- looking and acting, somebody else could have voted — and their vote is not
-- mine to throw away. ON_ERROR_STOP=1 in the workflow turns the exception into
-- a failed run rather than a silent one.
\echo '== about to delete =='
select day, x_handle, round, created_at from mama_x_votes order by created_at;

do $$
declare n int;
begin
  select count(*) into n from mama_x_votes;
  if n <> 1 then
    raise exception
      'Expected exactly 1 row (the test vote) but found %. Refusing to delete — look again before running this.', n;
  end if;
end $$;

delete from mama_x_votes;

\echo ''
\echo '== after =='
select count(*) as rows_left from mama_x_votes;
