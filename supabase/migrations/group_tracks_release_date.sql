-- Release dates for group tracks, so "days from release to 1B" is computable.
--
-- The 1B comparison is measured in DAYS FROM RELEASE, not in streams — that is
-- what makes "fastest to 1 billion" a race rather than a ranking. We hold the
-- streams and the rate; the release date is the missing third term. Without it
-- the page can only say WHEN a track reaches 1B, never how fast it got there,
-- and those are different claims.
--
-- Nullable on purpose. It is filled by fetch_group_track_meta.py for the tracks
-- that are actually in range of 1B, and a track with no date is shown without a
-- days figure rather than with a guessed one.
--
-- Run once. Safe to re-run.

alter table group_tracks add column if not exists release_date date;

-- The date is read from Spotify's album metadata, which gives a precision:
-- 'day' is a real date, 'year' is 1 January of that year and would read as a
-- release on New Year's Day. Stored so a coarse date can be shown as coarse
-- instead of being quietly treated as exact.
alter table group_tracks add column if not exists release_precision text;

do $$
declare n_total int; n_dated int;
begin
  select count(*), count(release_date) into n_total, n_dated from group_tracks;
  raise notice 'group_tracks: % row(s), % with a release date.', n_total, n_dated;
end $$;
