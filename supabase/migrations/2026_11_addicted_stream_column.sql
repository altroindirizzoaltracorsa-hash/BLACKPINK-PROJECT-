-- 2026-11 — make JISOO's ADDICTED (2026-10-30) count per-user, like the other
-- solo singles.
--
-- Adds the `addicted` column to user_daily_counts. Until this runs, the cron
-- and the live submit both no-op on it through their own isolated guarded
-- upserts, and api/user-week.js reads it in its own tolerant query — so the
-- badges "Today's Challenge" grid has had no ADDICTED row since release while
-- every other column kept working. Same shape as the `newtrick` migration.
--
-- Then re-applies vma_vote_board() so the new column is inside the voting
-- board's streamed-ever rank gate and its per-row "streams today". Without
-- that, a blink whose streaming is mostly ADDICTED would read as having
-- streamed less than they have, which is the gate deciding eligibility.
--
-- NOT ADDED HERE: the five PRESS PLAY EP tracks (v12, cobra, tarantino,
-- cutuoff, sweat) still have no columns either, so they are missing from this
-- grid and from that gate in exactly the same way. That is a bigger scope
-- decision than one single and is left to be taken deliberately rather than
-- smuggled in beside it.
--
-- Idempotent; safe to re-run. Apply via the "Apply SQL" workflow with
--   file: supabase/migrations/2026_11_addicted_stream_column.sql
-- or paste into the Supabase SQL editor.

alter table public.user_daily_counts add column if not exists addicted integer not null default 0;

-- Re-apply the function definitions now that the column exists. Relative to
-- this file's directory (supabase/migrations/), so ../ points at supabase/.
\ir ../vma_user_votes.sql
