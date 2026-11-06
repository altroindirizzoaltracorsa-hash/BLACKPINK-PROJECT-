-- 2026-11-06 — make JENNIE's "Someone to Hold" (from the Netflix film Steps)
-- count per-user, like the other solo singles.
--
-- Adds the `sth` column to user_daily_counts. Until this runs, the cron
-- (api/cron-scrobbles.js) and the live submit (api/leaderboard.js) both no-op
-- on it through their own isolated guarded upserts, and api/user-week.js reads
-- it in its own tolerant query — so nothing breaks before it is applied, but
-- the badges "Today's Challenge" grid has no Someone to Hold row and the
-- per-day history has nowhere to put the count. Same shape as the `newtrick`
-- and `addicted` migrations.
--
-- WRITTEN ON RELEASE DAY, which is the only difference from ADDICTED's. That
-- column arrived a week after the song did, and for that week the count was
-- being computed and silently discarded: the grid showed no row at all while
-- every other column kept working, so nothing looked broken. The code paths
-- above are deliberately forgiving, which is exactly what makes a missing
-- column quiet — the guard that stops it taking the others down also stops it
-- announcing itself.
--
-- Then re-applies vma_vote_board() so the new column is inside the voting
-- board's streamed-ever rank gate and its per-row "streams today". Without
-- that, a blink whose streaming is mostly Someone to Hold would read as having
-- streamed less than they have, which is the gate deciding eligibility.
--
-- NOT ADDED HERE: the five PRESS PLAY EP tracks (v12, cobra, tarantino,
-- cutuoff, sweat) still have no columns, so they remain missing from this grid
-- and from that gate in exactly the same way. That is a bigger scope decision
-- than one single and is still left to be taken deliberately rather than
-- smuggled in beside it.
--
-- Idempotent; safe to re-run. Apply via the "Apply SQL" workflow with
--   file: supabase/migrations/2026_11_sth_stream_column.sql
-- or paste into the Supabase SQL editor.

alter table public.user_daily_counts add column if not exists sth integer not null default 0;

-- Re-apply the function definitions now that the column exists. Relative to
-- this file's directory (supabase/migrations/), so ../ points at supabase/.
\ir ../vma_user_votes.sql
