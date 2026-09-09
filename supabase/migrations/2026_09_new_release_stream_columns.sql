-- 2026-09 — make the newer releases count per-user, and fix the voting board.
--
-- Adds SaWaDiKa / CLICK / Fallen Angel / Heaven columns to user_daily_counts
-- (cron writes them via a guarded upsert), then re-applies vma_vote_board(), which
-- now (a) ranks on streamed-EVER across all tracked columns incl. these, (b) counts
-- the new releases in the per-row "streams today", and (c) ignores malformed linked
-- handles so the voting-board name matches the streaming board.
--
-- Idempotent; safe to re-run. Apply via the "Apply SQL" workflow (SUPABASE_DB_URL)
-- or paste into the Supabase SQL editor.

alter table public.user_daily_counts add column if not exists sawadika    integer not null default 0;
alter table public.user_daily_counts add column if not exists click       integer not null default 0;
alter table public.user_daily_counts add column if not exists fallenangel integer not null default 0;
alter table public.user_daily_counts add column if not exists heaven      integer not null default 0;

-- Re-apply the function definitions (create-or-replace, so this just refreshes them
-- now that the columns exist). Relative to this file's directory.
\ir ../vma_user_votes.sql
