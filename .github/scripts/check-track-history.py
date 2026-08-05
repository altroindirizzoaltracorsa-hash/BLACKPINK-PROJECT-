"""
Read-only: print the full track_daily_stats history for one track.

Set TRACK to an exact artist_tracks.name (optionally ARTIST=<artist_id> to
disambiguate). Prints every stored (date, streams, daily_delta) row ordered by
date. Writes nothing.
"""

import os
import sys
import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
TRACK = os.environ.get("TRACK", "Black (Feat. JENNIE of BLACKPINK)")
ARTIST = os.environ.get("ARTIST")  # optional artist_id filter


def sb(path, **params):
    r = httpx.get(
        f"{SUPABASE_URL}/rest/v1{path}",
        headers={"Authorization": f"Bearer {SUPABASE_KEY}", "apikey": SUPABASE_KEY},
        params=params, timeout=30,
    )
    r.raise_for_status()
    return r.json()


def main():
    q = {"name": f"eq.{TRACK}", "select": "id,name,artist_id"}
    if ARTIST:
        q["artist_id"] = f"eq.{ARTIST}"
    tracks = sb("/artist_tracks", **q)
    if not tracks:
        print(f"No artist_tracks row named {TRACK!r}")
        sys.exit(0)

    for t in tracks:
        ref = t["id"]
        print(f"\n=== {t['name']}  (ref={ref}, artist={t['artist_id']}) ===")
        rows = sb("/track_daily_stats",
                  track_ref=f"eq.{ref}", order="date.asc",
                  select="date,streams,daily_delta")
        if not rows:
            print("  (no track_daily_stats rows)")
            continue
        print(f"  {'date':<12} {'streams':>16} {'daily_delta':>14}")
        for r in rows:
            dd = r["daily_delta"]
            dds = f"{dd:,}" if dd is not None else "null"
            print(f"  {r['date']:<12} {r['streams']:>16,} {dds:>14}")


if __name__ == "__main__":
    main()
