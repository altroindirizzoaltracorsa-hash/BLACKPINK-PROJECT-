-- READ ONLY. Which OAuth providers have actually been used to sign in, and how
-- many accounts carry an X identity.
--
-- The MAMA vote counter rests entirely on this: Mnet counts one X vote per X
-- account per day, so our count is only meaningful if we hold a verified X
-- identity per blink. The sign-in button calls signInWithOAuth({provider:'x'}),
-- but Supabase's stored provider name is its own business — it has historically
-- been 'twitter' — and if nobody has ever signed in that way the whole approach
-- is worth nothing. Both are facts about the live database, not about the code.
--
-- Counts only. No handles, no ids, no emails.
\echo '== identities by provider =='
select provider, count(*) as identities, count(distinct user_id) as users
from auth.identities
group by provider
order by identities desc;

\echo ''
\echo '== accounts that could cast a MAMA vote today =='
select
  count(distinct user_id) filter (where provider in ('twitter', 'x'))        as with_x_identity,
  count(distinct user_id)                                                    as all_accounts
from auth.identities;

\echo ''
\echo '== shape of one X identity (keys only, no values) =='
select provider, jsonb_object_keys(identity_data) as identity_data_key
from auth.identities
where provider in ('twitter', 'x')
group by provider, identity_data_key
order by identity_data_key;
