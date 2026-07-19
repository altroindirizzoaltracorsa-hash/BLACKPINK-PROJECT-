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
        by_playcount = {}  # play_count -> list of (id, name)
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
            by_playcount.setdefault(pc, []).append((tid, item.result.name))
            playcount_by_id[tid] = (item.result.name, pc)

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

        # Spotify serves the *same* play_count under multiple track IDs when a
        # song exists as both a standalone single and (later) embedded in an
        # album, or as explicit/clean edition pairs -- these are linked, not
        # independent, so each distinct play_count value should count once.
        dedup_total = 0
        linked_groups = []
        for pc, entries in by_playcount.items():
            dedup_total += pc
            if len(entries) > 1:
                linked_groups.append((pc, entries))

        print()
        print(f"RAW TOTAL (every track ID counted): {raw_total:,}")
        print(f"DEDUPED TOTAL (each distinct play_count counted once): {dedup_total:,}")
        print(f"Distinct play_count values: {len(by_playcount)}  (from {len(track_ids)} track IDs)")
        print(f"Tracks with no play_count (Tier-2 fallback, no token): {missing_playcount}")
        print(f"Track fetch failures: {len(track_failures)}")
        if track_failures:
            print("First 5 track failures:")
            for f in track_failures[:5]:
                print(f"  - {f}")

        print()
        print(f"Linked groups found (same play_count across multiple IDs): {len(linked_groups)}")
        for pc, entries in sorted(linked_groups, key=lambda g: -g[0]):
            names = ", ".join(f"{name!r}({tid})" for tid, name in entries)
            print(f"  {pc:,} shared by {len(entries)}: {names}")


if __name__ == "__main__":
    main()
