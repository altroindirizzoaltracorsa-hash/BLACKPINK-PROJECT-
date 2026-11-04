-- 2026-11 — recover the ADDICTED plays the extension filed under solo_jisoo.
--
-- RUN THE PREVIEW FIRST: supabase/migrations/2026_11_backfill_addicted_preview.sql
-- It writes nothing and prints exactly which rows this will touch, the artist
-- and title strings being matched, the per-day shape, and the near misses this
-- deliberately leaves alone.
--
-- WHY THESE ROWS ARE WRONG. api/ingest-scrobble.js matched plays against a
-- hand-written list of campaign tracks that never had ADDICTED (JISOO,
-- 2026-10-30) added to it. matchTrack() returned null, classifyArtist() filed
-- the play under the generic 'solo_jisoo' bucket, and the ADDICTED card, the
-- ADDICTED board and the campaign *_all sums all read as if it had not been
-- played. The matcher is fixed; this repairs the history behind it.
--
-- THE PREDICATE MIRRORS matchTrack() EXACTLY (norm + keyName + the artist
-- substring test), so the recovered rows are precisely the ones the fixed
-- matcher would have produced at ingest time. See the preview file for why a
-- looser rule would be worse than this one.
--
-- IDEMPOTENT: re-running changes nothing, because rows already carrying
-- 'addicted' are excluded by the predicate itself.
--
-- REVERSIBLE: the rule is deterministic and every row it moves came from
-- 'solo_jisoo' (confirmed by the preview's first query before applying), so
-- the inverse is the same predicate with track_id = 'addicted' set back. The
-- raw artist/title columns are never modified, so nothing is lost either way.
--
-- NOT A DOUBLE COUNT: extension_counts() groups by track_id, so a play is
-- counted under exactly one id. Moving it from solo_jisoo to addicted moves
-- the count; it does not add one. The fan's "Solo Scrobbles" total is built
-- from the same rows and is unaffected in size.
--
-- Apply via the "Apply SQL" workflow with
--   file: supabase/migrations/2026_11_backfill_addicted_extension_scrobbles.sql

begin;

\echo '== before =='
select track_id, count(*) as plays
from extension_scrobbles
where track_id in ('addicted', 'solo_jisoo')
group by track_id
order by track_id;

update extension_scrobbles
set track_id = 'addicted'
where track_id <> 'addicted'
  and regexp_replace(lower(regexp_replace(coalesce(title, ''), '\(.*?\)|\[.*?\]', '', 'g')),
                     '[^a-z0-9]', '', 'g') = 'addicted'
  and lower(regexp_replace(coalesce(artist, ''), '\(.*?\)|\[.*?\]', '', 'g')) like '%jisoo%';

\echo ''
\echo '== after =='
select track_id, count(*) as plays
from extension_scrobbles
where track_id in ('addicted', 'solo_jisoo')
group by track_id
order by track_id;

commit;

-- The leaderboard picks these up on the next refresh: extensionCountsForUser()
-- re-runs extension_counts() per visit and the cron folds them in hourly, so
-- no cache needs clearing. Overall totals climb immediately; a fan's DAILY
-- figure only moves for plays inside the current streaming day, because the
-- daily floor is max-merged and never lowers — older days are recovered in the
-- overall and weekly figures, not retroactively in each past day's row.
