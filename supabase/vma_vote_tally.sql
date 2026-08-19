-- Community "votes logged" tally for the VMAs page (blinksunited.com/vmas).
-- Self-reported honor-system counter: each device logs how many votes it cast
-- per day (capped), and the page shows the running community total.
--
-- Run this in the Supabase SQL editor once before deploying /api/vma-votes.

create table if not exists vma_vote_tally (
  id         bigint generated always as identity primary key,
  day        date        not null default (now() at time zone 'utc')::date,
  votes      int         not null check (votes >= 0 and votes <= 40),
  client_id  text        not null,
  created_at timestamptz not null default now()
);

-- One row per device per day (an update overwrites that day's number, so a
-- device can't stack multiple submissions to inflate the total).
create unique index if not exists vma_vote_tally_client_day
  on vma_vote_tally (client_id, day);

-- Fast, single-round-trip aggregate for the page. "today" uses the same
-- 00:00 UTC day boundary as the rest of the site.
create or replace function vma_vote_stats()
returns json
language sql
stable
as $$
  select json_build_object(
    'total',       coalesce(sum(votes), 0),
    'today',       coalesce(sum(votes) filter (where day = (now() at time zone 'utc')::date), 0),
    'blinksTotal', count(distinct client_id),
    'blinksToday', count(distinct client_id) filter (where day = (now() at time zone 'utc')::date)
  )
  from vma_vote_tally;
$$;
