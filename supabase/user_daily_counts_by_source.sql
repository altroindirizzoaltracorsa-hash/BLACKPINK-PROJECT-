-- Per-scrobbler daily breakdown for the personal history calendar.
--
-- Adds a JSONB column to user_daily_counts holding that day's split by scrobbler,
-- e.g. { "Last.fm · Alice9629": {jump,shutdown,ddududu,ltal,go},
--        "BU Extension": {...}, "Musicat / Stats.fm": {...} }.
-- The cron writes it each refresh from the sources it can see, and it freezes at the
-- 2am-Rome reset like the totals. Musicat/Stats.fm expose only today (no per-day
-- history), so their slice is whatever was current at the freeze — accurate going
-- forward, absent for days that already passed.
--
-- Apply once in the Supabase SQL editor. Until applied, the cron write of by_source
-- degrades (the column just isn't there) — totals keep working, breakdown is null.

alter table public.user_daily_counts
  add column if not exists by_source jsonb;
