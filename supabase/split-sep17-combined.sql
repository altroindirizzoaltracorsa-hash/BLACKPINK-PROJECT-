-- One-off data fix: split the merged 2026-09-17 catalog entry into an estimated
-- Sept 17 + Sept 18, for BLACKPINK and the four members.
--
-- Context: Spotify froze the catalog play-counts after Sep 16 and then published
-- Sep 17 + Sep 18 together as a single cumulative jump, which the nightly fetch
-- recorded as one ~2x day labelled 2026-09-17. The 2-day TOTAL is real; Spotify
-- never exposes a per-day breakdown, so we split the delta ~50/50 across the two
-- days and flag BOTH as estimated=true (surfaced as "≈ est" in the UI). This also
-- realigns the sequential day-labelling to the calendar (the next real bump will
-- correctly land on 2026-09-19).
--
-- Idempotent: the INSERT is guarded by NOT EXISTS on the 18th and the UPDATE by
-- estimated=false, so re-running is a no-op. Wrapped in a transaction for safety.

ALTER TABLE artist_daily_stats ADD COLUMN IF NOT EXISTS estimated boolean NOT NULL DEFAULT false;

BEGIN;

-- 1) Insert the Sept 18 row = the SECOND half of the combined delta, carrying the
--    current cumulative total and the follower/monthly/rank deltas. Skipped if an
--    18th row already exists (e.g. a real Spotify bump landed first).
INSERT INTO artist_daily_stats
  (artist_id, date, total_streams, daily_delta, followers, followers_delta,
   monthly_listeners, monthly_listeners_delta, world_rank, world_rank_delta,
   track_count, estimated)
SELECT
  s.artist_id, DATE '2026-09-18', s.total_streams,
  s.daily_delta - FLOOR(s.daily_delta / 2)::bigint,          -- half2 (Sept 18 delta)
  s.followers, s.followers_delta,
  s.monthly_listeners, s.monthly_listeners_delta,
  s.world_rank, s.world_rank_delta,
  s.track_count, true
FROM artist_daily_stats s
WHERE s.date = DATE '2026-09-17'
  AND s.artist_id IN (
    '41MozSoPIsD1dJM0CLPjZF',  -- BLACKPINK
    '6UZ0ba50XreR4TM8u322gs',  -- JISOO
    '250b0Wlc5Vk0CoUsaCY84M',  -- JENNIE
    '3eVa5w3URK5duf6eyVDbu9',  -- ROSÉ
    '5L1lO4eRHmJ7a0Q6csE5cT'   -- LISA
  )
  AND s.daily_delta IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM artist_daily_stats t
    WHERE t.artist_id = s.artist_id AND t.date = DATE '2026-09-18'
  );

-- 2) Reduce the Sept 17 row to the FIRST half: total = T - half2 (= T16 + half1),
--    delta = half1. Move the follower/monthly/rank growth onto the 18th (null here).
--    Guarded by estimated=false so a second run does nothing.
UPDATE artist_daily_stats s
SET total_streams           = s.total_streams - (s.daily_delta - FLOOR(s.daily_delta / 2)::bigint),
    daily_delta             = FLOOR(s.daily_delta / 2)::bigint,   -- half1 (Sept 17 delta)
    followers_delta         = NULL,
    monthly_listeners_delta = NULL,
    world_rank_delta        = NULL,
    estimated               = true
WHERE s.date = DATE '2026-09-17'
  AND s.artist_id IN (
    '41MozSoPIsD1dJM0CLPjZF',
    '6UZ0ba50XreR4TM8u322gs',
    '250b0Wlc5Vk0CoUsaCY84M',
    '3eVa5w3URK5duf6eyVDbu9',
    '5L1lO4eRHmJ7a0Q6csE5cT'
  )
  AND s.daily_delta IS NOT NULL
  AND s.estimated = false;

COMMIT;

-- Verify (prints the two split days per artist):
--   SELECT artist_id, date, total_streams, daily_delta, estimated
--   FROM artist_daily_stats
--   WHERE date IN (DATE '2026-09-17', DATE '2026-09-18')
--     AND artist_id IN ('41MozSoPIsD1dJM0CLPjZF','6UZ0ba50XreR4TM8u322gs',
--                       '250b0Wlc5Vk0CoUsaCY84M','3eVa5w3URK5duf6eyVDbu9','5L1lO4eRHmJ7a0Q6csE5cT')
--   ORDER BY artist_id, date;
