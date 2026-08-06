"""
Read-only. Dump exactly what's needed to correct the BLACKPINK artist total
after the two JP/TOKYO DOME tracks failed to fetch (Spotify reported them
unavailable), which left the saved total short and the daily_delta negative.

Prints:
  - BLACKPINK's last few artist_daily_stats rows (date, total, delta, track_count)
    so we can see which date is corrupted and what the correct previous total is.
  - The two JP tracks' artist_tracks ids + their recent track_daily_stats history,
    so we can add their missing rows with the right prev/delta.
"""

import os
import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

BLACKPINK_ID = "41MozSoPIsD1dJM0CLPjZF"
JP_TRACKS = [
    "REALLY - JP Ver./TOKYO DOME",
    "PLAYING WITH FIRE - JP Ver./TOKYO DOME",
]


def sb(path, **params):
    r = httpx.get(
        f"{SUPABASE_URL}/rest/v1{path}",
        headers={"Authorization": f"Bearer {SUPABASE_KEY}", "apikey": SUPABASE_KEY},
        params=params, timeout=30,
    )
    r.raise_for_status()
    return r.json()


def main():
    print("=== BLACKPINK artist_daily_stats (last 6) ===")
    rows = sb("/artist_daily_stats",
              artist_id=f"eq.{BLACKPINK_ID}", order="date.desc", limit=6,
              select="date,total_streams,daily_delta,track_count")
    for r in rows:
        print(f"  {r['date']}  total={r['total_streams']:,}  delta={r['daily_delta']}  tracks={r.get('track_count')}")

    print("\n=== JP tracks: artist_tracks id + recent track_daily_stats ===")
    for name in JP_TRACKS:
        at = sb("/artist_tracks",
                artist_id=f"eq.{BLACKPINK_ID}", name=f"eq.{name}", select="id,name")
        if not at:
            print(f"  [{name}] NOT FOUND in artist_tracks")
            continue
        ref = at[0]["id"]
        print(f"  [{name}] track_ref={ref}")
        hist = sb("/track_daily_stats",
                  track_ref=f"eq.{ref}", order="date.desc", limit=5,
                  select="date,streams,daily_delta")
        for h in hist:
            print(f"      {h['date']}  streams={h['streams']:,}  delta={h['daily_delta']}")


if __name__ == "__main__":
    main()
