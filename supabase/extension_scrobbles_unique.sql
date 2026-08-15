-- Guard against duplicate scrobbles: one real play = one row.
--
-- A play is uniquely identified by (app_user_id, spotify_account, track_id,
-- listened_at) — one Spotify account cannot start the same track twice in the
-- same second. This unique index makes the DB reject re-sends (SW-restart /
-- poll-overlap races, or an old extension version running alongside a new one).
--
-- ORDER MATTERS: run the dedupe cleanup FIRST. This index will fail to create
-- while duplicate rows still exist. Run this in the Supabase SQL editor.

create unique index if not exists extension_scrobbles_play_uniq
  on public.extension_scrobbles (app_user_id, spotify_account, track_id, listened_at);

-- After this exists, api/ingest-scrobble.js upserts with
-- onConflict: 'app_user_id,spotify_account,track_id,listened_at' and
-- ignoreDuplicates: true, so a duplicate POST is a no-op instead of a new row.
