-- 2026-09 — make "new trick" (ROSÉ, 2026-09-17) count per-user, like the other
-- solo singles.
--
-- Adds the `newtrick` column to user_daily_counts (cron + leaderboard write it via
-- their own isolated guarded upserts, which no-op until this runs), then re-applies
-- vma_vote_board() so the newtrick column is included in the voting board's
-- streamed-ever rank gate + per-row "streams today".
--
-- Idempotent; safe to re-run. Apply via the "Apply SQL" workflow with
--   file: supabase/migrations/2026_09_newtrick_stream_column.sql
-- or paste into the Supabase SQL editor.

alter table public.user_daily_counts add column if not exists newtrick integer not null default 0;

-- Re-apply the function definitions now that the column exists. Relative to this
-- file's directory (supabase/migrations/), so ../ points at supabase/.
\ir ../vma_user_votes.sql
