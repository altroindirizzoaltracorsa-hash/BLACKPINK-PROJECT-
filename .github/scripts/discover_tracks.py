"""
Read-only preview of auto-discovery: for each tracked artist, list the recent
releases discover_new_tracks() would ADD (tracks credited to the member, dated
within the window, not already in FIXED_TRACKS or artist_tracks). Writes nothing.

Run this after a new drop (e.g. SaWaDiKa / CLICK) to confirm it's caught, or any
time to confirm discovery isn't about to add anything unexpected.
WITHIN_DAYS env overrides the recency window (default 75).
"""

import os
import sys

from spotify_scraper import SpotifyClient

import fetch_artist_streams as F


def known_for(artist_id):
    ids = {tid for _, tid in F.FIXED_TRACKS.get(artist_id, [])}
    names = {F._norm_track_name(n) for n, _ in F.FIXED_TRACKS.get(artist_id, [])}
    rows = F.sb("GET", "/artist_tracks", params={
        "artist_id": f"eq.{artist_id}", "select": "name,source_track_ids",
    }) or []
    for r in rows:
        names.add(F._norm_track_name(r.get("name")))
        for s in (r.get("source_track_ids") or []):
            ids.add(s)
    return ids, names


def main():
    within = int(os.environ.get("WITHIN_DAYS", "75"))
    artists = F.sb("GET", "/tracked_artists",
                   params={"active": "eq.true", "select": "spotify_artist_id,name"})
    print(f"Recency window: last {within} days\n")
    with SpotifyClient() as client:
        for a in artists:
            aid, name = a["spotify_artist_id"], a["name"]
            known_ids, known_names = known_for(aid)
            found = F.discover_new_tracks(client, aid, known_ids, known_names, within_days=within)
            print(f"=== {name} ({aid}) — already tracking {len(known_ids)} ===")
            if not found:
                print("   (nothing new in window)")
            for n, tid, rd in found:
                print(f"   + {n!r}  [{tid}]  released {rd}")
            print()


if __name__ == "__main__":
    main()
