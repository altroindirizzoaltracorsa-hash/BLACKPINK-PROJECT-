"""
One-off: dump each member's raw discography (track name, Spotify track
ID, play_count, album name) for kworb reconciliation -- same process
used to pin BLACKPINK's track list, applied per-member.
"""

from spotify_scraper import SpotifyClient

MEMBER_IDS = {
    "JISOO": "6UZ0ba50XreR4TM8u322gs",
    "JENNIE": "250b0Wlc5Vk0CoUsaCY84M",
    "ROSÉ": "3eVa5w3URK5duf6eyVDbu9",
    "LISA": "5L1lO4eRHmJ7a0Q6csE5cT",
}


def dump_artist(client, name, artist_id):
    print(f"\n=== {name} ({artist_id}) ===")
    albums = client.get_discography(artist_id)
    album_results = client.get_albums([a.id for a in albums])

    track_ids, album_name_by_id = [], {}
    seen = set()
    for ref, item in zip(albums, album_results):
        if not item.ok:
            print(f"  album fetch failed: {ref.name!r}: {item.error}")
            continue
        for t in item.result.tracks:
            if not t.id:
                continue
            album_name_by_id[t.id] = item.result.name
            if t.id not in seen:
                seen.add(t.id)
                track_ids.append(t.id)

    track_results = client.get_tracks(track_ids)
    total = 0
    count = 0
    for tid, item in zip(track_ids, track_results):
        if not item.ok:
            print(f"  track fetch failed: {tid}: {item.error}")
            continue
        if item.result.play_count is None:
            continue
        count += 1
        total += item.result.play_count
        print(f"  {item.result.play_count:>15,}  {item.result.name!r}  [{tid}]  album={album_name_by_id.get(tid)!r}")
    print(f"  -- {count} tracks, raw total={total:,}")


def main():
    with SpotifyClient() as client:
        for name, artist_id in MEMBER_IDS.items():
            dump_artist(client, name, artist_id)


if __name__ == "__main__":
    main()
