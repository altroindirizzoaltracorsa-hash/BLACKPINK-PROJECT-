"""Read-only: what is in an album, and when does it land?

Set ALBUM_IDS to a comma-separated list of Spotify album IDs. Prints the album's
name, release date, artists and every track id it holds — which is what a
re-seed needs, and what tells us whether a forthcoming release will be counted.

The group catalogues are PINNED: fetch_group_streams.py sums exactly the ids in
data/group_catalogs/, and nothing adds to them on its own. That is deliberate —
it keeps every group on kworb's scope so the seven stay comparable — but it also
means a new album is worth zero to a group's total until the catalogue is
re-seeded. For a single that is a rounding error; for a full album it is not.

So each track is checked against the pinned catalogues, and the summary says
plainly how many of them are currently counted.

Writes nothing.
"""
import glob
import json
import os
import sys

from spotify_scraper import SpotifyClient

ids = [a.strip() for a in os.environ.get("ALBUM_IDS", "").split(",") if a.strip()]
if not ids:
    print("Set ALBUM_IDS=<comma-separated spotify album ids>", file=sys.stderr)
    sys.exit(1)


def catalogued():
    out = {}
    for fn in sorted(glob.glob("data/group_catalogs/*.json")):
        try:
            d = json.load(open(fn))
        except Exception:
            continue
        for t in d.get("tracks", []):
            out[t["id"]] = d.get("name", "?")
    return out


known = catalogued()

with SpotifyClient() as client:
    for aid in ids:
        print("=" * 74)
        try:
            alb = client.get_album(aid)
        except Exception as e:
            print(f"{aid}  FAILED ({e})")
            continue
        rd = getattr(alb, "release_date", None)
        day = rd.date().isoformat() if hasattr(rd, "date") else (str(rd)[:10] if rd else "—")
        artists = ", ".join(a.name for a in (getattr(alb, "artists", None) or [])
                            if getattr(a, "name", None)) or "—"
        tracks = list(getattr(alb, "tracks", None) or [])
        print(f"{getattr(alb, 'name', '?')}")
        print(f"  id            {aid}")
        print(f"  released      {day}")
        print(f"  artists       {artists}")
        print(f"  tracks        {len(tracks)}")
        counted = 0
        for i, t in enumerate(tracks, 1):
            tid = getattr(t, "id", None) or "?"
            where = known.get(tid)
            if where:
                counted += 1
            print(f"    {i:>2}. {tid:<24} {getattr(t, 'name', '?')}"
                  + (f"   [counted under {where}]" if where else ""))
        if tracks:
            print(f"  → {counted}/{len(tracks)} of these are in a pinned catalogue today"
                  + ("" if counted == len(tracks)
                     else f"; the other {len(tracks) - counted} contribute nothing to any group "
                          f"total until the catalogue is re-seeded"))
print("=" * 74)
