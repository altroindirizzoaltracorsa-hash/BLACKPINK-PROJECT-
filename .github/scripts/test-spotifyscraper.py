"""
One-off: search for the Spotify track IDs of BLACKPINK's featured-artist
tracks (not on BLACKPINK's own discography page, so get_discography()
misses them), and print the full discography canonical list WITH track
IDs so a fixed, kworb-matching track list can be pinned down.
"""

from spotify_scraper import SpotifyClient

ARTIST_ID = "41MozSoPIsD1dJM0CLPjZF"

SEARCHES = [
    "Kiss and Make Up Dua Lipa BLACKPINK",
    "Kiss and Make Up Remix Dua Lipa BLACKPINK",
    "Sour Candy Shygirl Mura Masa Remix Lady Gaga BLACKPINK",
]


def main():
    with SpotifyClient() as client:
        print("=== Searches for missing featured-artist tracks ===")
        for q in SEARCHES:
            print(f"\nQuery: {q!r}")
            results = client.search(q, types=("track",), limit=5)
            for t in results.tracks:
                artist_names = ", ".join(a.name for a in t.artists)
                print(f"  {t.id}  {t.name!r} by {artist_names}  play_count={t.play_count}")

        print("\n\n=== Full discography canonical list (name, streams, track_id, album) ===")
        albums = client.get_discography(ARTIST_ID)
        album_results = client.get_albums([a.id for a in albums])

        track_ids, seen, track_album = [], set(), {}
        for ref, item in zip(albums, album_results):
            if not item.ok:
                continue
            for t in item.result.tracks:
                if t.id:
                    track_album[t.id] = item.result.name
                    if t.id not in seen:
                        seen.add(t.id)
                        track_ids.append(t.id)

        track_results = client.get_tracks(track_ids)
        rows = []
        for tid, item in zip(track_ids, track_results):
            if item.ok and item.result.play_count is not None:
                rows.append((item.result.name, item.result.play_count, tid, track_album.get(tid)))

        for name, pc, tid, album in sorted(rows, key=lambda r: -r[1]):
            print(f"  {pc:,}  {name}  [{tid}]  ({album})")


if __name__ == "__main__":
    main()
