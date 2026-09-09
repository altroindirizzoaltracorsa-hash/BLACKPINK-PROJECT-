-- Adds ext_at to vma_user_votes: the timestamp a day's votes were last logged by
-- the VMA vote counter (browser extension or Android app), which post via a link
-- token. /api/vma-votes sets it on every token-authenticated vote and returns
-- extToday from ?me=1; the /voting page uses that to hide the manual "Add votes"
-- form for accounts already being counted automatically, preventing double counts.
--
-- Safe to run anytime — the API writes/reads it best-effort, so nothing breaks
-- before or after this runs. Run once in the Supabase SQL editor.

alter table vma_user_votes
  add column if not exists ext_at timestamptz;
