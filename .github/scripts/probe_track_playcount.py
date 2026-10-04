"""Read-only: should this track count towards a group's total?

Set TRACK_IDS to a comma-separated list of Spotify track IDs. Prints, per track:

  - its current play_count, via the same spotifyscraper the catalog fetch uses,
    so the number matches what the daily job would record
  - its CREDITED ARTISTS, which is the thing that decides whether it belongs to
    a group at all. A track can surface on a group's Spotify profile — under
    "appears on", or because a member is credited — without the group being an
    artist on it.
  - whether any of our pinned catalogues already counts it
  - and, with KWORB_ARTIST set, whether kworb lists it under that artist

That last pair is the whole question. The group catalogues were seeded so that
summing exactly their IDs reproduces kworb's published total to the digit, and
the race compares seven groups on that one scope. A track kworb does not count,
added to one group, breaks the reconciliation for that group and makes its total
incomparable with the other six — the number goes up without the streams being
new.

Writes nothing.
"""
import glob
import json
import os
import re
import sys

from spotify_scraper import SpotifyClient

ids = [t.strip() for t in os.environ.get("TRACK_IDS", "").split(",") if t.strip()]
if not ids:
    print("Set TRACK_IDS=<comma-separated spotify track ids>", file=sys.stderr)
    sys.exit(1)
KWORB_ARTIST = os.environ.get("KWORB_ARTIST", "").strip()


def catalogued():
    """{track_id: (group name, track name)} across every pinned catalogue."""
    out = {}
    for fn in sorted(glob.glob("data/group_catalogs/*.json")):
        try:
            d = json.load(open(fn))
        except Exception:
            continue
        for t in d.get("tracks", []):
            out[t["id"]] = (d.get("name", "?"), t.get("name", "?"))
    return out


def kworb_ids(artist_id):
    """Every track id kworb lists for this artist, or None if unreachable."""
    try:
        import httpx
        r = httpx.get(f"https://kworb.net/spotify/artist/{artist_id}_songs.html",
                      timeout=60, headers={"User-Agent": "Mozilla/5.0"}, follow_redirects=True)
        r.raise_for_status()
        return set(re.findall(r"track/([0-9A-Za-z]{22})", r.text))
    except Exception as e:
        print(f"  ⚠ kworb unreachable: {e}", file=sys.stderr)
        return None


known = catalogued()
kw = kworb_ids(KWORB_ARTIST) if KWORB_ARTIST else None
if KWORB_ARTIST:
    print(f"kworb lists {len(kw) if kw is not None else '?'} track ids for {KWORB_ARTIST}\n")

with SpotifyClient() as client:
    results = client.get_tracks(ids)
    for tid, item in zip(ids, results):
        print("=" * 72)
        if not item.ok:
            print(f"{tid}  FAILED ({item.error})")
            continue
        t = item.result
        pc = t.play_count
        artists = ", ".join(a.name for a in (t.artists or []) if getattr(a, "name", None)) or "—"
        print(f"{t.name}")
        print(f"  id           {tid}")
        print(f"  play_count   {pc:,}" if pc is not None else "  play_count   (none)")
        print(f"  credited to  {artists}")
        alb = getattr(t, "album", None)
        if alb is not None and getattr(alb, "name", None):
            print(f"  album        {alb.name}")
        hit = known.get(tid)
        print(f"  counted by   {hit[0]} (as {hit[1]!r})" if hit
              else "  counted by   nothing — not in any pinned catalogue")
        if kw is not None:
            print(f"  on kworb     {'yes' if tid in kw else 'NO — kworb does not list this id'}")
print("=" * 72)
