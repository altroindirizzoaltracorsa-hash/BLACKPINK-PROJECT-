"""
One-time fix, not part of the daily pipeline:

backfill_kworb_subtraction.py's LISA 07-16 upsert passed
prev_date_for_delta="2026-07-17" -- a LATER date -- to upsert_day(),
which computes daily_delta = total(date) - total(prev_date_for_delta).
That made 07-16's delta = total(07-16) - total(07-17), a negative
number representing the wrong direction entirely (there is no 07-15
data, so 07-16 has no valid delta at all). Meanwhile 07-17's delta was
never computed against 07-16 and was left null.

Fixes:
  - LISA 07-16 artist_daily_stats.daily_delta -> null (no 07-15 baseline)
  - LISA 07-17 daily_delta (artist + every track) <- total(07-17) - total(07-16)

Requires SUPABASE_URL / SUPABASE_SERVICE_KEY env vars.
"""

import os
import sys

import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

LISA_ID = "5L1lO4eRHmJ7a0Q6csE5cT"


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
        "artist_id": f"eq.{LISA_ID}", "date": "eq.2026-07-16",
        "select": "total_streams,followers,monthly_listeners,track_count",
    })
    day17 = sb("GET", "/artist_daily_stats", params={
        "artist_id": f"eq.{LISA_ID}", "date": "eq.2026-07-17",
        "select": "total_streams,followers,monthly_listeners,track_count",
    })
    if not day16 or not day17:
        print("FATAL: missing 07-16 or 07-17 row for LISA", file=sys.stderr)
        sys.exit(1)

    # 1. Null out 07-16's bogus delta (no 07-15 baseline exists).
    sb("POST", "/artist_daily_stats",
       params={"on_conflict": "artist_id,date"},
       headers={"Prefer": "resolution=merge-duplicates"},
       json=[{
           "artist_id": LISA_ID,
           "date": "2026-07-16",
           "total_streams": day16[0]["total_streams"],
           "daily_delta": None,
           "followers": day16[0]["followers"],
           "monthly_listeners": day16[0]["monthly_listeners"],
           "track_count": day16[0]["track_count"],
       }])
    print(f"07-16: total={day16[0]['total_streams']:,} delta=null")

    # 2. Compute 07-17's real delta against 07-16, per track and for the artist total.
    tracks = sb("GET", "/artist_tracks", params={"artist_id": f"eq.{LISA_ID}", "select": "id"})
    ids = [str(t["id"]) for t in tracks]

    prev_rows = sb("GET", "/track_daily_stats", params={
        "track_ref": f"in.({','.join(ids)})", "date": "eq.2026-07-16", "select": "track_ref,streams",
    })
    prev_by_ref = {r["track_ref"]: r["streams"] for r in prev_rows}

    cur_rows = sb("GET", "/track_daily_stats", params={
        "track_ref": f"in.({','.join(ids)})", "date": "eq.2026-07-17", "select": "track_ref,streams",
    })
    patched = []
    for r in cur_rows:
        prev = prev_by_ref.get(r["track_ref"])
        if prev is None:
            continue
        patched.append({"track_ref": r["track_ref"], "date": "2026-07-17", "streams": r["streams"], "daily_delta": r["streams"] - prev})
    if patched:
        sb("POST", "/track_daily_stats",
           params={"on_conflict": "track_ref,date"},
           headers={"Prefer": "resolution=merge-duplicates"},
           json=patched)

    artist_delta = day17[0]["total_streams"] - day16[0]["total_streams"]
    sb("POST", "/artist_daily_stats",
       params={"on_conflict": "artist_id,date"},
       headers={"Prefer": "resolution=merge-duplicates"},
       json=[{
           "artist_id": LISA_ID,
           "date": "2026-07-17",
           "total_streams": day17[0]["total_streams"],
           "daily_delta": artist_delta,
           "followers": day17[0]["followers"],
           "monthly_listeners": day17[0]["monthly_listeners"],
           "track_count": day17[0]["track_count"],
       }])
    print(f"07-17: total={day17[0]['total_streams']:,} delta={artist_delta:,} ({len(patched)} tracks patched)")
    print("Done.")


if __name__ == "__main__":
    main()
