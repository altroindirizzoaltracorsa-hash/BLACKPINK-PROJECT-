-- Durable per-user, per-day campaign counts.
--
-- One row per (signed-in owner, streaming day). Written every refresh by
-- api/cron-scrobbles.js with the floored daily counts, and read by
-- api/user-week.js so the badges weekly grid can show the SAME frozen numbers
-- as the leaderboard/finalized board on every device.
--
-- Why a dedicated table instead of reusing leaderboard_archive (the whole-board
-- snapshot): each day lives under its own key here, so a fan who opens their
-- badges just after the 2am reset can never overwrite the previous day, and the
-- Musicat/Stats.fm slice (which a returning client can't re-derive for past days)
-- is frozen here while it was still "today". The cron max-merges on write, so a
-- partial/rate-limited run can never lower a day that was previously higher.
--
-- day_key is the 2am-Rome-aligned calendar day as 'YYYY-MM-DD' (UTC parts of the
-- day-start instant) — identical to the key used by leaderboard_archive and the
-- client's italyDayKey(), so all three surfaces line up.
--
-- Apply once in the Supabase SQL editor. Until it's applied, the cron write and
-- the read endpoint both degrade to a no-op and the badges page falls back to its
-- own per-day computation — nothing breaks, past days just aren't cross-device yet.

create table if not exists public.user_daily_counts (
  app_user_id text        not null,
  day_key     text        not null,               -- 'YYYY-MM-DD', 2am-Rome aligned
  jump        integer     not null default 0,
  shutdown    integer     not null default 0,
  ddududu     integer     not null default 0,
  ltal        integer     not null default 0,
  go          integer     not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (app_user_id, day_key)
);

-- Fast "this user's recent days" lookups (api/user-week orders by day_key).
create index if not exists user_daily_counts_user_day_idx
  on public.user_daily_counts (app_user_id, day_key desc);

-- Server-only table: written and read exclusively via the service key in our API
-- routes (never queried directly from the browser), so enable RLS with no public
-- policies — the service role bypasses RLS, everyone else is denied.
alter table public.user_daily_counts enable row level security;
