"""
One-time backfill, not part of the daily pipeline:

artist_tracks didn't originally store album metadata. fetch_artist_streams.py
now captures it (album, album_release_date, track_number) for every track it
touches going forward, but the ~214 tracks inserted before that change need a
one-off pass to fill those columns in.

Deliberately does NOT touch track_daily_stats or artist_daily_stats -- it
only PATCHes artist_tracks, so unlike fetch_artist_streams.py it's safe to
run at any time of day without risking a premature/duplicate daily row.

Requires SUPABASE_URL / SUPABASE_SERVICE_KEY env vars.
"""

import os
import sys

import httpx
from spotify_scraper import SpotifyClient

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]


def sb(method, path, **kwargs):
    headers = {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
        **kwargs.pop("headers", {}),
    }
    r = httpx.request(method, f"{SUPABASE_URL}/rest/v1{path}", headers=headers, timeout=30, **kwargs)
    if r.is_error:
        print(f"  Supabase error body: {r.text}", file=sys.stderr)
    r.raise_for_status()
    return r.json() if r.content else None


def main():
    artists = sb("GET", "/tracked_artists", params={"select": "spotify_artist_id,name"})
    tracks = sb("GET", "/artist_tracks", params={"select": "id,artist_id,name,source_track_ids,album"})
    by_artist = {}
    for t in tracks:
        by_artist.setdefault(t["artist_id"], []).append(t)

    with SpotifyClient() as client:
        for a in artists:
            artist_id, name = a["spotify_artist_id"], a["name"]
            artist_tracks = by_artist.get(artist_id, [])
            if not artist_tracks:
                continue
            print(f"=== {name}: {len(artist_tracks)} tracks ===")
            ids = [t["source_track_ids"][0] for t in artist_tracks]
            results = client.get_tracks(ids)
            patched = 0
            for t, item in zip(artist_tracks, results):
                if not item.ok:
                    print(f"  fetch failed: {t['name']!r}: {item.error}", file=sys.stderr)
                    continue
                r = item.result
                sb("PATCH", f"/artist_tracks?id=eq.{t['id']}", json={
                    "album": r.album.name if r.album else None,
                    "album_release_date": r.release_date.date().isoformat() if r.release_date else None,
                    "track_number": r.track_number,
                })
                patched += 1
            print(f"  patched {patched}/{len(artist_tracks)}")

    print("Done.")


if __name__ == "__main__":
    main()
