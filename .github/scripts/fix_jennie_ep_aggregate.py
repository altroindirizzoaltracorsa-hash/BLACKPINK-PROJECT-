"""
One-off: fold the Fallen Angel EP into JENNIE's artist-level daily stats.

When Fallen Angel + Heaven were pinned mid-stream, the pipeline wrote JENNIE's
total_streams *including* the EP for its first fetched day (Sep 1) but the
earlier days (Aug 28-31) predate the EP, so Sep 1's artist daily_delta spikes by
the EP's whole back-catalog and the earlier days understate her.

Fix: recompute JENNIE's artist_daily_stats.total_streams for Aug 28 - Sep 1 as
the SUM of all her per-track rows for that date (now complete, EP included), and
redo daily_delta as the consecutive difference (anchored to Aug 27, before the
EP existed). Only total_streams + daily_delta are PATCHed -- followers /
monthly_listeners / rank are left untouched.

Dry-run unless APPLY=1. Requires SUPABASE_URL / SUPABASE_SERVICE_KEY (select +
update on artist_daily_stats, select on artist_tracks / track_daily_stats).
"""

import os
import sys
from collections import defaultdict

import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
APPLY = bool(os.environ.get("APPLY"))

JENNIE_ID = "250b0Wlc5Vk0CoUsaCY84M"
ANCHOR = "2026-08-27"                       # last day before the EP existed
DATES = ["2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01"]


def sb(method, path, **kwargs):
    headers = {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
        **kwargs.pop("headers", {}),
    }
    r = httpx.request(method, f"{SUPABASE_URL}/rest/v1{path}", headers=headers, timeout=60, **kwargs)
    if r.is_error:
        print(f"  Supabase error body: {r.text}", file=sys.stderr)
    r.raise_for_status()
    return r.json() if r.content else None


def main():
    tracks = sb("GET", "/artist_tracks", params={"artist_id": f"eq.{JENNIE_ID}", "select": "id"})
    refs = [t["id"] for t in tracks]
    all_dates = [ANCHOR] + DATES

    # Sum every JENNIE per-track row per date.
    rows = sb("GET", "/track_daily_stats", params={
        "track_ref": f"in.({','.join(str(r) for r in refs)})",
        "date": f"in.({','.join(all_dates)})",
        "select": "track_ref,date,streams",
        "limit": "100000",
    }) or []
    sum_by_date = defaultdict(int)
    cnt_by_date = defaultdict(int)
    for r in rows:
        sum_by_date[r["date"]] += r["streams"]
        cnt_by_date[r["date"]] += 1

    # Existing artist rows.
    art = sb("GET", "/artist_daily_stats", params={
        "artist_id": f"eq.{JENNIE_ID}",
        "date": f"in.({','.join(all_dates)})",
        "select": "date,total_streams,daily_delta",
    }) or []
    art_by_date = {a["date"]: a for a in art}

    print(f"{'date':<12}{'existing_total':>16}{'existing_Δ':>14}{'sum_of_tracks':>16}{'tracks':>8}{'new_Δ':>14}")
    patches = []
    prev_total = sum_by_date.get(ANCHOR) or (art_by_date.get(ANCHOR, {}) or {}).get("total_streams")
    for d in all_dates:
        ex = art_by_date.get(d, {})
        ex_total = ex.get("total_streams")
        ex_delta = ex.get("daily_delta")
        s = sum_by_date.get(d)
        new_delta = (s - prev_total) if (s is not None and prev_total is not None) else None
        mark = "" if d == ANCHOR else "  <-fix"
        print(f"{d:<12}{(ex_total or 0):>16,}{(ex_delta if ex_delta is not None else 0):>14,}"
              f"{(s or 0):>16,}{cnt_by_date.get(d, 0):>8}{(new_delta if new_delta is not None else 0):>14,}{mark}")
        if d != ANCHOR and s is not None:
            patches.append({"date": d, "total_streams": s, "daily_delta": new_delta})
        if s is not None:
            prev_total = s

    if APPLY:
        for p in patches:
            sb("PATCH", "/artist_daily_stats",
               params={"artist_id": f"eq.{JENNIE_ID}", "date": f"eq.{p['date']}"},
               json={"total_streams": p["total_streams"], "daily_delta": p["daily_delta"]})
        print(f"\nPatched {len(patches)} artist_daily_stats rows.")
    else:
        print(f"\nDry-run -- would patch {len(patches)} rows (set APPLY=1 to write).")


if __name__ == "__main__":
    main()
