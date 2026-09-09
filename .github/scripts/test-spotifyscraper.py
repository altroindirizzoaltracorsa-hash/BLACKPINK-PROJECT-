"""
One-off: search for feature-artist tracks missing from each member's own
discography (same phenomenon as BLACKPINK's "Kiss and Make Up" -- when a
member is a featured artist on someone else's release, it doesn't show
up via get_discography(member_id)), then confirm play_count via
get_tracks() on the resolved candidate IDs.
"""

from spotify_scraper import SpotifyClient

SEARCHES = {
    "Black (Feat. JENNIE of BLACKPINK)": "Black JENNIE",
    "Special (JENNIE)": "Special JENNIE",
    "Without You (Feat. ROSE)": "Without You ROSE",
    "Shoong! (feat. LISA of BLACKPINK)": "Shoong LISA",
}


def main():
    with SpotifyClient() as client:
        for label, query in SEARCHES.items():
            print(f"\n=== search: {label!r}  query={query!r} ===")
            results = client.search(query, types=("track",), limit=10)
            candidate_ids = [t.id for t in results.tracks if t.id]
            if not candidate_ids:
                print("  no results")
                continue
            track_results = client.get_tracks(candidate_ids)
            for t_ref, item in zip(results.tracks, track_results):
                if not item.ok:
                    print(f"  FAILED [{t_ref.id}]: {item.error}")
                    continue
                t = item.result
                artists = ", ".join(a.name for a in t.artists)
                album_name = t.album.name if t.album else None
                print(f"  play_count={t.play_count}  name={t.name!r}  artists={artists}  album={album_name!r}  [{t.id}]")


if __name__ == "__main__":
    main()
