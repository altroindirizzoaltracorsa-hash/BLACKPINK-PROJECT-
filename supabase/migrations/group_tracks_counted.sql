-- Does this track's streams go into its group's total?
--
-- Until now every row in group_tracks was, by construction, a track the pinned
-- catalogue counts — so summing group_track_daily_stats for an artist on a date
-- reproduced that group's recorded total. The watchlist breaks that assumption:
-- it records per-track history for tracks NOT in the catalogue (a just-released
-- album kworb has not listed yet), so that the first weeks of a release are not
-- lost while we wait for the scope to catch up.
--
-- Without a flag, the only way to know whether a row belongs in a total would be
-- to re-derive the catalogue for the date in question — which nobody will do,
-- so sooner or later someone sums the table and gets a number that does not
-- match the group, with nothing to explain the gap. Hence the column.
--
-- It is DERIVED, not declared: fetch_group_streams.py sets it true for tracks it
-- read from data/group_catalogs/ and false for watchlist tracks, on every run.
-- So when a catalogue is re-seeded and the track becomes counted, the next run
-- flips it on its own and no cleanup is needed.
--
-- Default true so every existing row keeps the meaning it was written with.
--
-- Run once. Safe to re-run.

alter table group_tracks add column if not exists counted boolean not null default true;

create index if not exists group_tracks_counted_idx on group_tracks (artist_id, counted);

do $$
declare n_total int; n_watch int;
begin
  select count(*), count(*) filter (where not counted) into n_total, n_watch from group_tracks;
  raise notice 'group_tracks: % row(s), % on the watchlist (not in any group total).',
    n_total, n_watch;
end $$;
