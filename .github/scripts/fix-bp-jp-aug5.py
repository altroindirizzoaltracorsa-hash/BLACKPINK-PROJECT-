"""
Correct the BLACKPINK 2026-08-05 artist total after the two JP/TOKYO DOME tracks
failed to fetch (Spotify reported them unavailable), which left the saved total
short by those two tracks and the daily_delta negative (a fake -2.58M "decline").

Fix, using the exact current stream counts read off Spotify (screenshots):
  - REALLY - JP Ver./TOKYO DOME          (track_ref 562) = 3,645,449
  - PLAYING WITH FIRE - JP Ver./TOKYO DOME (track_ref 563) = 3,632,108

Adds those two back to the BLACKPINK 08-05 artist_daily_stats total, recomputes
the daily_delta against the previous complete row (08-03), sets track_count=113,
and inserts the two missing track_daily_stats rows for 08-05.

Dry-run by default. Set APPLY=1 to write.
"""

import os
import sys
import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
APPLY = os.environ.get("APPLY") == "1"

BLACKPINK_ID = "41MozSoPIsD1dJM0CLPjZF"
FIX_DATE = "2026-08-05"

# track_ref -> (name, exact current streams from screenshot, prev streams on 08-03)
JP_FIX = {
    562: ("REALLY - JP Ver./TOKYO DOME", 3_645_449, 3_645_100),
    563: ("PLAYING WITH FIRE - JP Ver./TOKYO DOME", 3_632_108, 3_631_751),
}

HEADERS = {"Authorization": f"Bearer {SUPABASE_KEY}", "apikey": SUPABASE_KEY,
           "Content-Type": "application/json"}


def sb(method, path, **kwargs):
    r = httpx.request(method, f"{SUPABASE_URL}/rest/v1{path}", headers={**HEADERS, **kwargs.pop("headers", {})}, timeout=30, **kwargs)
    if r.is_error:
        print(f"  Supabase error: {r.text}", file=sys.stderr)
    r.raise_for_status()
    return r.json() if r.content else None


def main():
    # Read the corrupted BLACKPINK 08-05 row and the previous complete row.
    cur = sb("GET", "/artist_daily_stats", params={
        "artist_id": f"eq.{BLACKPINK_ID}", "date": f"eq.{FIX_DATE}",
        "select": "date,total_streams,daily_delta,track_count",
    })
    if not cur:
        print(f"No BLACKPINK row for {FIX_DATE}; aborting.", file=sys.stderr)
        sys.exit(1)
    cur = cur[0]
    prev = sb("GET", "/artist_daily_stats", params={
        "artist_id": f"eq.{BLACKPINK_ID}", "date": f"lt.{FIX_DATE}",
        "order": "date.desc", "limit": 1, "select": "date,total_streams",
    })[0]

    add = sum(streams for _, streams, _ in JP_FIX.values())
    new_total = cur["total_streams"] + add
    new_delta = new_total - prev["total_streams"]

    print(f"MODE: {'APPLY' if APPLY else 'DRY-RUN'}")
    print(f"\nBLACKPINK {FIX_DATE} artist_daily_stats:")
    print(f"  total_streams : {cur['total_streams']:,}  ->  {new_total:,}   (+{add:,})")
    print(f"  daily_delta   : {cur['daily_delta']:,}  ->  {new_delta:,}   (vs {prev['date']} = {prev['total_streams']:,})")
    print(f"  track_count   : {cur.get('track_count')}  ->  113")

    print(f"\ntrack_daily_stats inserts for {FIX_DATE}:")
    track_rows = []
    for ref, (name, streams, prev_streams) in JP_FIX.items():
        delta = streams - prev_streams
        print(f"  ref {ref}  {name}: streams={streams:,}  delta={delta:,}")
        track_rows.append({"track_ref": ref, "date": FIX_DATE, "streams": streams, "daily_delta": delta})

    if not APPLY:
        print("\nDRY-RUN — no writes. Set APPLY=1 to apply.")
        return

    # 1) Patch the artist row (partial update — leaves followers/rank/etc. intact).
    sb("PATCH", "/artist_daily_stats",
       params={"artist_id": f"eq.{BLACKPINK_ID}", "date": f"eq.{FIX_DATE}"},
       json={"total_streams": new_total, "daily_delta": new_delta, "track_count": 113})
    # 2) Upsert the two missing track rows.
    sb("POST", "/track_daily_stats",
       params={"on_conflict": "track_ref,date"},
       headers={"Prefer": "resolution=merge-duplicates"},
       json=track_rows)
    print("\nAPPLIED.")

    # Read back for confirmation.
    back = sb("GET", "/artist_daily_stats", params={
        "artist_id": f"eq.{BLACKPINK_ID}", "date": f"eq.{FIX_DATE}",
        "select": "total_streams,daily_delta,track_count",
    })[0]
    print(f"Readback: total={back['total_streams']:,}  delta={back['daily_delta']:,}  tracks={back['track_count']}")


if __name__ == "__main__":
    main()
