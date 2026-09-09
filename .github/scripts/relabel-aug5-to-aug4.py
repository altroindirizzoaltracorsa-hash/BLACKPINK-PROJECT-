"""
Relabel the 2026-08-05 snapshot to 2026-08-04.

Spotify was running ~2 days behind when the Aug-6 /update-streams ran, so the
data it fetched was Aug-4's finalized counts -- but fetch_artist_streams.py
stamps every run as "yesterday" (date.today()-1 = Aug-5). Verified across all
5 artists: each 2026-08-05 row is a clean ONE-day step from 2026-08-03 (their
normal daily rate), i.e. it's Aug-4's day. There is no existing 2026-08-04 row
for anyone (the Aug-5 cron skipped, since Spotify hadn't published yet).

Fix: move date 2026-08-05 -> 2026-08-04 on both artist_daily_stats and
track_daily_stats. The daily_delta values were computed vs 2026-08-03, so they
are already the correct Aug-3 -> Aug-4 steps; only the date label changes.

Safety: aborts if ANY 2026-08-04 row already exists (would collide on the
(artist_id,date) / (track_ref,date) unique keys). Dry-run unless APPLY=1.
"""

import os
import sys
import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
APPLY = os.environ.get("APPLY") == "1"

OLD_DATE = "2026-08-05"
NEW_DATE = "2026-08-04"

ARTISTS = {
    "BLACKPINK": "41MozSoPIsD1dJM0CLPjZF",
    "JISOO": "6UZ0ba50XreR4TM8u322gs",
    "JENNIE": "250b0Wlc5Vk0CoUsaCY84M",
    "ROSÉ": "3eVa5w3URK5duf6eyVDbu9",
    "LISA": "5L1lO4eRHmJ7a0Q6csE5cT",
}

HEADERS = {"Authorization": f"Bearer {SUPABASE_KEY}", "apikey": SUPABASE_KEY,
           "Content-Type": "application/json"}


def sb(method, path, **kwargs):
    r = httpx.request(method, f"{SUPABASE_URL}/rest/v1{path}",
                      headers={**HEADERS, **kwargs.pop("headers", {})}, timeout=30, **kwargs)
    if r.is_error:
        print(f"  Supabase error: {r.text}", file=sys.stderr)
    r.raise_for_status()
    return r.json() if r.content else None


def main():
    print(f"MODE: {'APPLY' if APPLY else 'DRY-RUN'}   relabel {OLD_DATE} -> {NEW_DATE}\n")

    # --- SAFETY: make sure nothing already lives on NEW_DATE ---
    existing_artist = sb("GET", "/artist_daily_stats",
                         params={"date": f"eq.{NEW_DATE}", "select": "artist_id"})
    existing_track = sb("GET", "/track_daily_stats",
                        params={"date": f"eq.{NEW_DATE}", "select": "track_ref", "limit": 1})
    if existing_artist or existing_track:
        print(f"ABORT: rows already exist on {NEW_DATE} "
              f"(artist={len(existing_artist)}, track≥{len(existing_track)}). "
              f"Relabel would collide; investigate first.", file=sys.stderr)
        sys.exit(1)

    # --- Show the artist rows that will move ---
    print("artist_daily_stats rows to relabel:")
    art_rows = sb("GET", "/artist_daily_stats", params={
        "date": f"eq.{OLD_DATE}", "select": "artist_id,total_streams,daily_delta,track_count",
    })
    id_to_name = {v: k for k, v in ARTISTS.items()}
    for r in art_rows:
        nm = id_to_name.get(r["artist_id"], r["artist_id"])
        dd = r["daily_delta"]
        print(f"  {nm:10} total={r['total_streams']:,}  delta={dd:+,}  tracks={r.get('track_count')}")

    # --- Count the track rows that will move ---
    track_rows = sb("GET", "/track_daily_stats",
                    params={"date": f"eq.{OLD_DATE}", "select": "track_ref"})
    print(f"\ntrack_daily_stats rows to relabel: {len(track_rows)}")
    print(f"artist_daily_stats rows to relabel: {len(art_rows)}")

    if not APPLY:
        print("\nDRY-RUN — no writes. Set APPLY=1 to apply.")
        return

    # --- Apply: shift the date on both tables ---
    sb("PATCH", "/artist_daily_stats", params={"date": f"eq.{OLD_DATE}"}, json={"date": NEW_DATE})
    sb("PATCH", "/track_daily_stats", params={"date": f"eq.{OLD_DATE}"}, json={"date": NEW_DATE})
    print("\nAPPLIED.")

    # --- Readback ---
    back = sb("GET", "/artist_daily_stats", params={
        "date": f"eq.{NEW_DATE}", "select": "artist_id,total_streams,daily_delta"})
    moved_tracks = sb("GET", "/track_daily_stats", params={"date": f"eq.{NEW_DATE}", "select": "track_ref"})
    left_old = sb("GET", "/artist_daily_stats", params={"date": f"eq.{OLD_DATE}", "select": "artist_id"})
    print(f"Readback: {len(back)} artist rows now on {NEW_DATE}, {len(moved_tracks)} track rows moved, "
          f"{len(left_old)} artist rows left on {OLD_DATE} (should be 0).")


if __name__ == "__main__":
    main()
