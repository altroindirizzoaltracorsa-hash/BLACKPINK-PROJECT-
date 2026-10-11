-- The feedback table, and the columns a reply needs.
--
-- The table itself predates this file — it was made by hand in Supabase and
-- /api/feedback has been inserting into it for months — so this is written to be
-- true whether it exists or not: `create table if not exists` leaves a live
-- table completely alone, and every new column is added with `if not exists`.
-- Nothing here drops, renames or rewrites anything, so no existing feedback can
-- be lost by running it.
--
-- WHAT A REPLY NEEDS, AND WHY IT IS FOUR COLUMNS AND NOT ONE.
--
-- The form has always said "email or @handle (optional — for a reply)" and then
-- had no way to reply at all. The missing part is not storage for the reply
-- text; it is knowing WHERE a reply should go, because the answer differs per
-- person and only that person knows it:
--
--   reply_via = 'site'   → they want it on blinksunited.com. Either their
--                          account is attached (app_user_id) and it appears
--                          under "Your messages", or they are not signed in and
--                          they keep `ticket` to check back with.
--   reply_via = 'email'  → `contact` is an email address.
--   reply_via = 'handle' → `contact` is a @handle somewhere.
--   reply_via = 'none'   → they do not want one. Recorded rather than guessed,
--                          so these never sit in the queue looking ignored.
--
-- Rows written before this migration have reply_via null, which reads as "we
-- never asked" — deliberately not the same thing as 'none'.
--
-- Run once. Safe to re-run.

create table if not exists feedback (
  id         uuid        primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  message    text        not null,
  category   text        not null default 'general',
  contact    text,
  username   text
);

-- Who wrote it, when they were signed in. Nullable forever: feedback does not
-- require an account and should not start requiring one.
alter table feedback add column if not exists app_user_id uuid;

-- Where they asked to be answered: 'site' | 'email' | 'handle' | 'none'.
alter table feedback add column if not exists reply_via text;

-- The claim code for an on-site reply with no account behind it. Short,
-- unambiguous (no O/0/I/1), and the only thing that can read that row back —
-- so it is generated server-side and never derived from anything guessable.
alter table feedback add column if not exists ticket text;

-- The reply itself.
alter table feedback add column if not exists reply text;
alter table feedback add column if not exists replied_at timestamptz;

-- For the email/handle routes there is nothing to deliver from here — no mail
-- service is configured — so the admin view composes the message and this marks
-- that it was sent by hand. Separate from replied_at, which only says the text
-- exists: a reply written but not yet sent is still outstanding.
alter table feedback add column if not exists reply_sent_at timestamptz;

-- The queue is read newest-first, and the unanswered ones are what matter.
create index if not exists feedback_created_idx on feedback (created_at desc);
create index if not exists feedback_user_idx    on feedback (app_user_id);
-- Partial: the ticket lookup only ever asks about rows that have one.
create unique index if not exists feedback_ticket_idx on feedback (ticket) where ticket is not null;

-- Written and read only through /api/feedback with the service key. RLS on with
-- no policies is what locks anon/authenticated out — Supabase grants those roles
-- on every new table in schema public by default, so withholding a grant is not
-- enough on its own. A reader must come through the API, which is where the
-- "only your own rows" and "admin key" rules live.
alter table feedback enable row level security;
grant all privileges on table feedback to service_role;

do $$
declare
  n int; n_unanswered int; missing text;
begin
  -- Every column the API writes or reads must exist, whatever shape the
  -- hand-made table was in before this ran.
  select string_agg(c, ', ') into missing
  from unnest(array['message','category','contact','username','app_user_id',
                    'reply_via','ticket','reply','replied_at','reply_sent_at']) c
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'feedback' and column_name = c
  );
  if missing is not null then
    raise exception 'feedback is missing column(s): %', missing;
  end if;

  select count(*) into n from feedback;
  select count(*) into n_unanswered from feedback where reply is null;
  raise notice 'feedback: % row(s), % with no reply yet.', n, n_unanswered;
end $$;
