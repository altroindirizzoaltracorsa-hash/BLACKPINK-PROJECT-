-- Let somebody delete their own account from the site.
--
-- The Settings → Account page has had a "Delete Account" button for a long
-- time. It called delete_account(), which does not exist — and a bug in the
-- client meant it never actually called it either, so the button signed you
-- out and left the account exactly where it was. Signing out looks like
-- success, which is why nobody noticed.
--
-- What it does, and it is what that button's own warning promises:
--   "Your leaderboard data stays but will no longer be linked to any account."
--
--   · the account itself goes (auth.users), and everything keyed to it by a
--     cascading foreign key goes with it — linked scrobblers, extension
--     tokens, ingested plays;
--   · the vote rows STAY, because they are the campaign's totals and not one
--     person's property — but their display_name is nulled, so what remains is
--     a count and not a name. "No longer linked to any account" has to mean
--     the name too, or a deleted account goes on being listed by name on a
--     public board.
--
-- SECURITY DEFINER with auth.uid() as the only input: it can delete the caller
-- and nobody else. There is no argument to get wrong.
--
-- Apply once in the Supabase SQL editor, or through apply-sql.yml. Safe to
-- re-run.

create or replace function public.delete_account()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  uid uuid := auth.uid();
  t   text;
begin
  if uid is null then
    raise exception 'not signed in';
  end if;

  -- Anonymise, do not delete: these rows are vote totals that other people's
  -- numbers are compared against. Removing them would quietly rewrite the
  -- campaign's history; removing the NAME is what was promised.
  --
  -- Listed by name and checked for existence, so this keeps working on a
  -- project where one of them has not been created yet.
  foreach t in array array['collab_user_votes', 'kca_user_votes',
                           'vma_user_votes', 'breaktudo_user_votes']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('update public.%I set display_name = null where app_user_id = $1', t)
        using uid;
    end if;
  end loop;

  -- Their own things, which mean nothing without the account and should not
  -- outlive it: a scrobbler link, and a token that can still post votes.
  delete from public.linked_accounts where app_user_id = uid;
  delete from public.scrobble_tokens where app_user_id = uid;

  -- And the account. Cascades inside the auth schema take the sessions and
  -- identities with it.
  delete from auth.users where id = uid;
end
$$;

revoke all on function public.delete_account() from public;
-- Signed-in callers only, and auth.uid() means each can only reach themselves.
grant execute on function public.delete_account() to authenticated;
