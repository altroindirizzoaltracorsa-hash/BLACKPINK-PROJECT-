"""
One-time fix, not part of the daily pipeline:

backfill_kworb_subtraction.py re-inserted BLACKPINK's 07-16
artist_daily_stats row (to attach real per-track data) without passing
a previous-date reference, so its upsert overwrote the correct delta
(+4,555,519, set earlier by backfill_widget_history.py) with null.
Recomputes it from 07-16's total minus 07-15's total.

Requires SUPABASE_URL / SUPABASE_SERVICE_KEY env vars.
"""

import os
import sys

import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

BLACKPINK_ID = "41MozSoPIsD1dJM0CLPjZF"


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
    day16 = sb("GET", "/artist_daily_stats", params={
        "artist_id": f"eq.{BLACKPINK_ID}", "date": "eq.2026-07-16",
        "select": "total_streams,followers,monthly_listeners,track_count",
    })
    day15 = sb("GET", "/artist_daily_stats", params={
        "artist_id": f"eq.{BLACKPINK_ID}", "date": "eq.2026-07-15", "select": "total_streams",
    })
    if not day16 or not day15:
        print("FATAL: missing 07-15 or 07-16 row", file=sys.stderr)
        sys.exit(1)

    delta = day16[0]["total_streams"] - day15[0]["total_streams"]
    print(f"07-16 total={day16[0]['total_streams']:,}  07-15 total={day15[0]['total_streams']:,}  delta={delta:,}")

    sb("POST", "/artist_daily_stats",
       params={"on_conflict": "artist_id,date"},
       headers={"Prefer": "resolution=merge-duplicates"},
       json=[{
           "artist_id": BLACKPINK_ID,
           "date": "2026-07-16",
           "total_streams": day16[0]["total_streams"],
           "daily_delta": delta,
           "followers": day16[0]["followers"],
           "monthly_listeners": day16[0]["monthly_listeners"],
           "track_count": day16[0]["track_count"],
       }])
    print("Patched.")


if __name__ == "__main__":
    main()
