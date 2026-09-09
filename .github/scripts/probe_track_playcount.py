"""Read-only: print the CURRENT Spotify play_count for one or more track IDs.

Set TRACK_IDS to a comma-separated list of Spotify track IDs. Uses the same
spotifyscraper client the catalog fetch uses, so the number matches what the
daily job would record. Writes nothing.
"""
import os
import sys
from spotify_scraper import SpotifyClient

ids = [t.strip() for t in os.environ.get("TRACK_IDS", "").split(",") if t.strip()]
if not ids:
    print("Set TRACK_IDS=<comma-separated spotify track ids>", file=sys.stderr)
    sys.exit(1)

with SpotifyClient() as client:
    results = client.get_tracks(ids)
    print(f"{'track id':<24} {'play_count':>16}  name")
    for tid, item in zip(ids, results):
        if not item.ok:
            print(f"{tid:<24} {'FAILED':>16}  ({item.error})")
            continue
        t = item.result
        pc = t.play_count
        print(f"{tid:<24} {pc:>16,}  {t.name}" if pc is not None
              else f"{tid:<24} {'no play_count':>16}  {t.name}")
