"""
One-time fix, not part of the daily pipeline:

A workflow_dispatch run at 02:51 UTC on 07-20 re-triggered
fetch_artist_streams.py right after the calendar rolled over, so
TODAY computed to 07-19 -- but Spotify hadn't actually updated its
public counts yet (it typically updates midday-to-evening Rome time,
per the comment in api/streams.js), so the fetch just re-pulled
07-18's numbers verbatim and wrote them under a bogus 07-19 label with
daily_delta=0 for every artist and track. Deletes those rows outright
so 07-18 remains the latest real data until an actual 07-19 fetch runs
later.

Requires SUPABASE_URL / SUPABASE_SERVICE_KEY env vars.
"""

import os
import sys

import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

BOGUS_DATE = "2026-07-19"


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
    artists = sb("GET", "/tracked_artists", params={"select": "spotify_artist_id,name"})
    for a in artists:
        artist_id, name = a["spotify_artist_id"], a["name"]
        tracks = sb("GET", "/artist_tracks", params={"artist_id": f"eq.{artist_id}", "select": "id"})
        ids = [str(t["id"]) for t in tracks]

        artist_row = sb("GET", "/artist_daily_stats", params={
            "artist_id": f"eq.{artist_id}", "date": f"eq.{BOGUS_DATE}", "select": "total_streams,daily_delta",
        })
        if not artist_row:
            print(f"{name}: no {BOGUS_DATE} row, skipping")
            continue

        print(f"{name}: deleting {BOGUS_DATE} row (total={artist_row[0]['total_streams']:,} delta={artist_row[0]['daily_delta']})")
        if ids:
            sb("DELETE", "/track_daily_stats", params={
                "date": f"eq.{BOGUS_DATE}", "track_ref": f"in.({','.join(ids)})",
            })
        sb("DELETE", "/artist_daily_stats", params={"artist_id": f"eq.{artist_id}", "date": f"eq.{BOGUS_DATE}"})

    print("Done.")


if __name__ == "__main__":
    main()
