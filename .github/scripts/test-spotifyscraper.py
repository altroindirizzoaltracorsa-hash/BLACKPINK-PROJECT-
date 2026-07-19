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

        total = 0
        missing_playcount = 0
        track_failures = []
        for tid, item in zip(track_ids, track_results):
            if not item.ok:
                track_failures.append(f"{tid}: {item.error}")
                continue
            if item.result.play_count is None:
                missing_playcount += 1
                continue
            total += item.result.play_count

        print()
        print(f"TOTAL: {total:,}")
        print(f"Tracks summed: {len(track_ids) - len(track_failures) - missing_playcount}/{len(track_ids)}")
        print(f"Tracks with no play_count (Tier-2 fallback, no token): {missing_playcount}")
        print(f"Track fetch failures: {len(track_failures)}")
        if track_failures:
            print("First 5 track failures:")
            for f in track_failures[:5]:
                print(f"  - {f}")


if __name__ == "__main__":
    main()
