-- PREVIEW ONLY — selects, no writes. Run this before the backfill beside it.
--
-- api/ingest-scrobble.js carried a hand-written list of campaign tracks and
-- ADDICTED (JISOO, 2026-10-30) was never added to it. So every ADDICTED play
-- that arrived through the BU browser extension missed matchTrack() and fell
-- through to classifyArtist(), which filed it under the generic 'solo_jisoo'
-- bucket. It counted toward "Solo Scrobbles" and toward nothing else — the
-- ADDICTED card, the ADDICTED board and the campaign sums all read as if those
-- plays had not happened.
--
-- The rows themselves are intact: ingest stores the real artist and title
-- alongside the bucket, so this is recoverable by re-classifying them.
--
-- THE PREDICATE BELOW MIRRORS matchTrack() EXACTLY, and that is deliberate:
--
--   norm(s)    lower-case, drop (...) and [...], collapse spaces, trim
--   keyName(s) norm(s) with every non-alphanumeric removed
--   match      keyName(title) = 'addicted' AND norm(artist) contains 'jisoo'
--
-- Mirroring it rather than writing something broader means the recovered
-- history agrees with what the fixed matcher will do from now on. A looser
-- rule here (say, catching a Korean-titled scrobble) would recover plays that
-- the live matcher will keep missing tomorrow, and the two would disagree
-- forever. If that case turns out to matter, it belongs in matchTrack first
-- and in a second backfill after.
--
-- Apply via the "Apply SQL" workflow with
--   file: supabase/migrations/2026_11_backfill_addicted_preview.sql

\echo '== rows that would be re-classified, by the bucket they are in now =='
select track_id          as current_bucket,
       count(*)          as plays,
       count(distinct app_user_id) as users,
       min(listened_at)  as first_play,
       max(listened_at)  as last_play
from extension_scrobbles
where track_id <> 'addicted'
  and regexp_replace(lower(regexp_replace(coalesce(title, ''), '\(.*?\)|\[.*?\]', '', 'g')),
                     '[^a-z0-9]', '', 'g') = 'addicted'
  and lower(regexp_replace(coalesce(artist, ''), '\(.*?\)|\[.*?\]', '', 'g')) like '%jisoo%'
group by track_id
order by plays desc;

\echo ''
\echo '== the exact artist/title strings being matched (sanity: all should be ADDICTED) =='
select artist, title, count(*) as plays
from extension_scrobbles
where track_id <> 'addicted'
  and regexp_replace(lower(regexp_replace(coalesce(title, ''), '\(.*?\)|\[.*?\]', '', 'g')),
                     '[^a-z0-9]', '', 'g') = 'addicted'
  and lower(regexp_replace(coalesce(artist, ''), '\(.*?\)|\[.*?\]', '', 'g')) like '%jisoo%'
group by artist, title
order by plays desc
limit 40;

\echo ''
\echo '== per day, so the shape can be checked against the release date =='
select (listened_at at time zone 'UTC')::date as utc_day, count(*) as plays
from extension_scrobbles
where track_id <> 'addicted'
  and regexp_replace(lower(regexp_replace(coalesce(title, ''), '\(.*?\)|\[.*?\]', '', 'g')),
                     '[^a-z0-9]', '', 'g') = 'addicted'
  and lower(regexp_replace(coalesce(artist, ''), '\(.*?\)|\[.*?\]', '', 'g')) like '%jisoo%'
group by utc_day
order by utc_day;

\echo ''
\echo '== NEAR MISSES: jisoo plays whose title merely looks addicted-ish =='
\echo '(these will NOT be touched — shown so a real variant spelling is not missed)'
select artist, title, track_id, count(*) as plays
from extension_scrobbles
where lower(coalesce(title, '')) like '%addict%'
  and regexp_replace(lower(regexp_replace(coalesce(title, ''), '\(.*?\)|\[.*?\]', '', 'g')),
                     '[^a-z0-9]', '', 'g') <> 'addicted'
group by artist, title, track_id
order by plays desc
limit 40;

\echo ''
\echo '== already correct, for comparison (plays ingested since the matcher fix) =='
select count(*) as already_addicted,
       count(distinct app_user_id) as users,
       min(listened_at) as first_play,
       max(listened_at) as last_play
from extension_scrobbles
where track_id = 'addicted';
