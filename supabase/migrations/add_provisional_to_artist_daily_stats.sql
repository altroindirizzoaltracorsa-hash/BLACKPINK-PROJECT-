-- Let a day stay OPEN while Spotify is still publishing it.
--
-- Why: Spotify does not publish a streaming day all at once — it works through
-- the catalogue, so for a while some tracks carry the new number and the rest
-- still carry yesterday's. fetch_artist_streams.py labelled every run "the day
-- after the last recorded day", so a fetch landing mid-publish opened a new day
-- from half the catalogue, and the next run opened ANOTHER day from the other
-- half. On 2026-09-23/24 that produced two dated rows for one streaming day:
-- 113 tracks, 62 of which moved only on the 23rd and 51 only on the 24th, with
-- not a single track moving on both, and the two rows together adding up to one
-- day's streams (+4,270,043, against +4.18M and +4.28M for the clean days
-- either side).
--
-- With this flag the fetch marks such a row provisional and REUSES its date on
-- the next run instead of advancing, so the day is overwritten until the publish
-- completes and only then finalised. One row per streaming day, as intended.
--
-- Defaults to false, so every existing row reads as final and nothing that
-- queries this table has to change.
--
-- Run once. Safe to re-run.

alter table artist_daily_stats
  add column if not exists provisional boolean not null default false;

comment on column artist_daily_stats.provisional is
  'True while Spotify is still publishing this day: a large share of the '
  'catalogue had not moved when the row was written. The fetch overwrites this '
  'row (same date) on later runs rather than opening a new day, and clears the '
  'flag once the publish looks complete.';
