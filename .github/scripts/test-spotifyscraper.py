"""
One-off test: can spotifyscraper (embed-page-bootstrapped anon token) get
BLACKPINK's real per-track play counts from GitHub Actions' network, where
the open.spotify.com/get_access_token endpoint is blocked?

Prints diagnostics only -- does not write anything to production.
"""

from spotify_scraper import SpotifyClient

ARTIST_ID = "41MozSoPIsD1dJM0CLPjZF"


def main():
    with SpotifyClient() as client:
        print("Fetching discography...")
        albums = client.get_discography(ARTIST_ID)
        print(f"  {len(albums)} releases found")

        album_ids = [a.id for a in albums]
        print("Fetching full album data (batched)...")
        album_results = client.get_albums(album_ids)

        track_ids = []
        seen = set()
        album_failures = []
        track_album = {}  # track id -> (album_id, album_name, track_number)
        print()
        print("Per-album breakdown:")
        for ref, item in zip(albums, album_results):
            if not item.ok:
                album_failures.append(f"{ref.name}: {item.error}")
                print(f"  FAILED  {ref.id}  {ref.name!r}: {item.error}")
                continue
            a = item.result
            new_ids = [t.id for t in a.tracks if t.id]
            dup_in_this_album = len(new_ids) - len(set(new_ids))
            already_seen = sum(1 for tid in new_ids if tid in seen)
            print(f"  {a.id}  {a.name!r}  type={a.album_type}  release={a.release_date}  "
                  f"total_tracks={a.total_tracks}  tracks_returned={len(new_ids)}  "
                  f"already_seen_elsewhere={already_seen}")
            for t in a.tracks:
                if t.id:
                    track_album[t.id] = (a.id, a.name, t.track_number)
                if t.id and t.id not in seen:
                    seen.add(t.id)
                    track_ids.append(t.id)
        print()

        print(f"  {len(track_ids)} unique tracks across {len(album_ids) - len(album_failures)} albums")
        if album_failures:
            print(f"  {len(album_failures)} album fetch failures (showing up to 5):")
            for f in album_failures[:5]:
                print(f"    - {f}")

        print("Fetching per-track play counts (batched)...")
        track_results = client.get_tracks(track_ids)

        raw_total = 0
        missing_playcount = 0
        track_failures = []
        playcount_by_id = {}
        for tid, item in zip(track_ids, track_results):
            if not item.ok:
                track_failures.append(f"{tid}: {item.error}")
                continue
            pc = item.result.play_count
            if pc is None:
                missing_playcount += 1
                continue
            raw_total += pc
            playcount_by_id[tid] = (item.result.name, pc)

        print()
        print(f"All {len(playcount_by_id)} tracks fetched (name, play_count, id):")
        for tid, (name, pc) in sorted(playcount_by_id.items(), key=lambda kv: -kv[1][1]):
            print(f"  {pc:,}  {name}  ({tid})")

        # Diagnostic: side-by-side comparison of DEADLINE's two album IDs
        # (explicit vs clean), matched by track name, to see the actual
        # play_count gap rather than a binary matched/unmatched verdict.
        deadline_albums = {}
        for tid, (album_id, album_name, track_number) in track_album.items():
            if album_name == "DEADLINE":
                deadline_albums.setdefault(album_id, []).append((track_number, tid))
        if len(deadline_albums) == 2:
            print()
            print("DEADLINE explicit vs clean, track-by-track (matched by name):")
            (aid_a, tracks_a), (aid_b, tracks_b) = list(deadline_albums.items())
            by_name_a = {playcount_by_id.get(tid, (None, None))[0]: (tid, playcount_by_id.get(tid, (None, None))[1]) for _, tid in tracks_a}
            by_name_b = {playcount_by_id.get(tid, (None, None))[0]: (tid, playcount_by_id.get(tid, (None, None))[1]) for _, tid in tracks_b}
            for name in by_name_a:
                a_tid, a_pc = by_name_a[name]
                b_tid, b_pc = by_name_b.get(name, (None, None))
                if b_pc is None:
                    print(f"  {name!r}: album A={a_pc:,} ({a_tid})  |  album B=<no match by name>")
                else:
                    delta = a_pc - b_pc
                    print(f"  {name!r}: A={a_pc:,} ({a_tid})  B={b_pc:,} ({b_tid})  delta={delta:,}")

        # Spotify serves the *same* underlying play count under multiple track
        # IDs when a song exists as both a standalone single and (later)
        # embedded in an album, or as explicit/clean edition pairs. Requiring
        # an exact numeric match misses this when the shared counter ticks
        # over between the two async batch fetches (seen on DEADLINE's fast-
        # moving tracks: ~0.1-0.2% drift). Group by track name instead, and
        # treat a small spread as timing noise -- take the max (freshest
        # sample) and count it once. A large spread means the names just
        # coincide and isn't safe to auto-merge; each is counted separately
        # and flagged for manual review.
        DRIFT_TOLERANCE = 0.01  # 1% -- comfortably above the ~0.2% drift observed

        by_name = {}
        for tid, (name, pc) in playcount_by_id.items():
            by_name.setdefault(name, []).append((tid, pc))

        dedup_total = 0
        merged_groups = []
        unmerged_groups = []
        for name, entries in by_name.items():
            values = [pc for _, pc in entries]
            hi, lo = max(values), min(values)
            if len(entries) == 1:
                dedup_total += values[0]
                continue
            spread = (hi - lo) / hi if hi else 0
            if spread <= DRIFT_TOLERANCE:
                dedup_total += hi
                merged_groups.append((name, entries, hi))
            else:
                dedup_total += sum(values)
                unmerged_groups.append((name, entries, spread))

        print()
        print(f"RAW TOTAL (every track ID counted): {raw_total:,}")
        print(f"DEDUPED TOTAL (name-grouped, max of each group counted once): {dedup_total:,}")
        print(f"Distinct song names: {len(by_name)}  (from {len(track_ids)} track IDs)")
        print(f"Tracks with no play_count (Tier-2 fallback, no token): {missing_playcount}")
        print(f"Track fetch failures: {len(track_failures)}")
        if track_failures:
            print("First 5 track failures:")
            for f in track_failures[:5]:
                print(f"  - {f}")

        print()
        print(f"Merged groups (same name, within {DRIFT_TOLERANCE:.0%} -- treated as one song): {len(merged_groups)}")
        for name, entries, hi in sorted(merged_groups, key=lambda g: -g[2]):
            parts = ", ".join(f"{pc:,}({tid})" for tid, pc in entries)
            print(f"  {name!r} -> counted once at {hi:,}: {parts}")

        if unmerged_groups:
            print()
            print(f"NOT auto-merged (same name, spread > {DRIFT_TOLERANCE:.0%} -- needs manual review): {len(unmerged_groups)}")
            for name, entries, spread in sorted(unmerged_groups, key=lambda g: -g[2]):
                parts = ", ".join(f"{pc:,}({tid})" for tid, pc in entries)
                print(f"  {name!r} spread={spread:.1%}: {parts}")

        # Full canonical (post-dedup) list, matching exactly what
        # fetch_artist_streams.py's dedupe() produces and stores -- one row
        # per merged group (max value), one row per singleton, and one row
        # PER TRACK for unmerged collisions (disambiguated by album), so
        # this can be diffed name-for-name against kworb's list.
        canonical = []
        for name, entries in by_name.items():
            values = [pc for _, pc in entries]
            hi, lo = max(values), min(values)
            if len(entries) == 1:
                canonical.append((name, values[0]))
                continue
            spread = (hi - lo) / hi if hi else 0
            if spread <= DRIFT_TOLERANCE:
                canonical.append((name, hi))
            else:
                for tid, pc in entries:
                    album = track_album.get(tid, (None, "unknown album", None))[1]
                    canonical.append((f"{name} ({album})", pc))

        print()
        print(f"CANONICAL LIST ({len(canonical)} rows, sum={sum(v for _, v in canonical):,}):")
        for name, v in sorted(canonical, key=lambda x: -x[1]):
            print(f"  {v:,}  {name}")


if __name__ == "__main__":
    main()
