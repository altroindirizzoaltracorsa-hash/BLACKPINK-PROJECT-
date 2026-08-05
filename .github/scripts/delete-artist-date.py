"""
Delete one artist's rows for a single date from artist_daily_stats and
track_daily_stats. Used to remove the corrupted JENNIE 2026-08-04 row written
when 2 of 41 tracks failed to fetch (produced a negative daily_delta).

Safe by default: prints exactly what it would delete and writes NOTHING unless
APPLY=1. Target via DELETE_ARTIST (artist_id) and DELETE_DATE (YYYY-MM-DD).
"""

import os
import sys
import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
APPLY = os.environ.get("APPLY") == "1"
ARTIST = os.environ.get("DELETE_ARTIST", "250b0Wlc5Vk0CoUsaCY84M")  # JENNIE
DATE = os.environ.get("DELETE_DATE", "2026-08-04")


def sb(method, path, **kwargs):
    headers = {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
        **kwargs.pop("headers", {}),
    }
    r = httpx.request(method, f"{SUPABASE_URL}/rest/v1{path}",
                      headers=headers, timeout=30, **kwargs)
    if r.is_error:
        print(f"  ERROR {r.status_code}: {r.text}", file=sys.stderr)
    r.raise_for_status()
    return r.json() if r.content else None


def main():
    print(f"MODE: {'APPLY (deleting)' if APPLY else 'DRY RUN (no deletes)'}")
    print(f"Target: artist={ARTIST}  date={DATE}\n")

    art = sb("GET", "/artist_daily_stats", params={
        "artist_id": f"eq.{ARTIST}", "date": f"eq.{DATE}",
        "select": "date,total_streams,daily_delta,track_count",
    }) or []
    print(f"artist_daily_stats rows to delete: {len(art)}")
    for r in art:
        dd = r.get("daily_delta")
        print(f"  {r['date']}  total={r['total_streams']:,}  "
              f"daily_delta={dd:,} ({'NEGATIVE - bad' if dd is not None and dd < 0 else 'ok'})  "
              f"track_count={r.get('track_count')}")

    tracks = sb("GET", "/artist_tracks", params={"artist_id": f"eq.{ARTIST}", "select": "id"}) or []
    ids = [str(t["id"]) for t in tracks]
    trows = []
    if ids:
        trows = sb("GET", "/track_daily_stats", params={
            "track_ref": f"in.({','.join(ids)})", "date": f"eq.{DATE}",
            "select": "track_ref",
        }) or []
    print(f"track_daily_stats rows to delete: {len(trows)}")

    if not APPLY:
        print("\nDRY RUN — nothing deleted. Set APPLY=1 to delete.")
        return

    if ids:
        sb("DELETE", "/track_daily_stats", params={
            "track_ref": f"in.({','.join(ids)})", "date": f"eq.{DATE}",
        })
    sb("DELETE", "/artist_daily_stats", params={
        "artist_id": f"eq.{ARTIST}", "date": f"eq.{DATE}",
    })
    print(f"\n✓ Deleted {len(trows)} track rows and {len(art)} artist row(s) for {DATE}.")


if __name__ == "__main__":
    main()
