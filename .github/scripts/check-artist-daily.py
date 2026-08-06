"""
Read-only. For each tracked artist, dump the last 8 artist_daily_stats rows
(date, total, delta, track_count). Purpose: check whether the row the Aug-6
/update-streams run stamped 2026-08-05 actually holds Aug-4's data (i.e. the
delta is a normal ONE-day step vs the previous row, not a two-day step),
which would mean it's mislabeled and should be relabeled 2026-08-04.
"""

import os
import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

ARTISTS = {
    "BLACKPINK": "41MozSoPIsD1dJM0CLPjZF",
    "JISOO": "6UZ0ba50XreR4TM8u322gs",
    "JENNIE": "250b0Wlc5Vk0CoUsaCY84M",
    "ROSÉ": "3eVa5w3URK5duf6eyVDbu9",
    "LISA": "5L1lO4eRHmJ7a0Q6csE5cT",
}


def sb(path, **params):
    r = httpx.get(f"{SUPABASE_URL}/rest/v1{path}",
                  headers={"Authorization": f"Bearer {SUPABASE_KEY}", "apikey": SUPABASE_KEY},
                  params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def main():
    for name, aid in ARTISTS.items():
        rows = sb("/artist_daily_stats", artist_id=f"eq.{aid}", order="date.desc", limit=8,
                  select="date,total_streams,daily_delta,track_count")
        print(f"\n=== {name} ===")
        prev_total = None
        for r in rows:  # desc order
            d = r["daily_delta"]
            d_str = f"{d:+,}" if isinstance(d, int) else str(d)
            print(f"  {r['date']}  total={r['total_streams']:,}  delta={d_str}  tracks={r.get('track_count')}")
        # Explicit step check between the two most recent rows.
        if len(rows) >= 2:
            newest, prev = rows[0], rows[1]
            step = newest["total_streams"] - prev["total_streams"]
            import datetime
            gap_days = (datetime.date.fromisoformat(newest["date"]) - datetime.date.fromisoformat(prev["date"])).days
            print(f"  -> newest {newest['date']} is {gap_days} calendar day(s) after {prev['date']}, "
                  f"but grew {step:,} (~{step // max(gap_days,1):,}/day-equiv)")


if __name__ == "__main__":
    main()
