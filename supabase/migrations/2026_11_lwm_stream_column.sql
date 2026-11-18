-- 2026-11-18 — make LISA's "Leave With Me (Featured in Always Lalisa)" count
-- per-user, like the other solo singles.
--
-- Adds the `lwm` column to user_daily_counts. Until this runs, the cron
-- (api/cron-scrobbles.js) and the live submit (api/leaderboard.js) both no-op
-- on it through their own isolated guarded upserts, and api/user-week.js reads
-- it in its own tolerant query — so nothing breaks before it is applied, but
-- the badges "Today's Challenge" grid has no Leave With Me row and the per-day
-- history has nowhere to put the count. Same shape as the `newtrick`,
-- `addicted` and `sth` migrations.
--
-- WRITTEN ON RELEASE DAY, for the reason ADDICTED's wasn't. That column
-- arrived a week after the song, and for that week the count was computed
-- every run and silently discarded: the grid showed no row at all while every
-- other column kept working, so nothing looked broken. The code paths above
-- are deliberately forgiving, and the guard that stops a missing column taking
-- the others down is the same guard that stops it announcing itself.
--
-- Then re-applies vma_vote_board() so the new column is inside the voting
-- board's streamed-ever rank gate and its per-row "streams today". Without
-- that, a blink whose streaming is mostly Leave With Me would read as having
-- streamed less than they have, which is the gate deciding eligibility.
--
-- NOT ADDED HERE: the five PRESS PLAY EP tracks (v12, cobra, tarantino,
-- cutuoff, sweat) still have no columns, so they remain missing from this grid
-- and from that gate in exactly the same way. That is a bigger scope decision
-- than one single and is still left to be taken deliberately rather than
-- smuggled in beside it.
--
-- Idempotent; safe to re-run. Apply via the "Apply SQL" workflow with
--   file: supabase/migrations/2026_11_lwm_stream_column.sql
-- or paste into the Supabase SQL editor.

alter table public.user_daily_counts add column if not exists lwm integer not null default 0;

-- Re-apply the function definitions now that the column exists. Relative to
-- this file's directory (supabase/migrations/), so ../ points at supabase/.
\ir ../vma_user_votes.sql
