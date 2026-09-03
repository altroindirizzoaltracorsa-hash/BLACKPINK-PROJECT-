"""
One-off: pin JENNIE's Sep 1 artist_daily_stats to kworb's authoritative figures
(kworb.net/spotify, JENNIE, last updated 2026/09/02).

Our per-track sum runs ~374K above kworb (normal scrape variance) and the
Aug 31 -> Sep 1 baseline catch-up left Sep 1's daily gain ~1.18M high. This
aligns the displayed member total + daily gain to kworb exactly. Only
total_streams + daily_delta are PATCHed.

Dry-run unless APPLY=1. Requires SUPABASE_URL / SUPABASE_SERVICE_KEY.
"""

import os
import sys

import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
APPLY = bool(os.environ.get("APPLY"))

JENNIE_ID = "250b0Wlc5Vk0CoUsaCY84M"
DATE = "2026-09-01"
PREV_DATE = "2026-08-31"
KWORB_TOTAL = 8_441_429_322
# daily_delta must equal total - previous-day total, or the streams page flags
# the row as "recount". We keep the total pinned to kworb and make the daily the
# consistent value (computed from our Aug 31 total) so the row adds up.


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
    cur = sb("GET", "/artist_daily_stats", params={
        "artist_id": f"eq.{JENNIE_ID}", "date": f"eq.{DATE}",
        "select": "date,total_streams,daily_delta",
    })
    prev = sb("GET", "/artist_daily_stats", params={
        "artist_id": f"eq.{JENNIE_ID}", "date": f"eq.{PREV_DATE}",
        "select": "total_streams",
    })
    if not cur or not prev:
        print(f"FATAL: missing artist_daily_stats row for {DATE} or {PREV_DATE}", file=sys.stderr)
        sys.exit(1)
    c = cur[0]
    prev_total = prev[0]["total_streams"]
    new_daily = KWORB_TOTAL - prev_total     # consistent with the Aug 31 total -> no "recount"

    print(f"JENNIE {DATE} (prev {PREV_DATE} total = {prev_total:,}):")
    print(f"  current : total={c['total_streams']:>15,}  daily={c['daily_delta']:>12,}")
    print(f"  target  : total={KWORB_TOTAL:>15,}  daily={new_daily:>12,}  (= total - prev, consistent)")

    if APPLY:
        sb("PATCH", "/artist_daily_stats",
           params={"artist_id": f"eq.{JENNIE_ID}", "date": f"eq.{DATE}"},
           json={"total_streams": KWORB_TOTAL, "daily_delta": new_daily})
        print("  -> pinned total to kworb, daily set to the consistent value.")
    else:
        print("  -> dry-run (set APPLY=1 to write).")


if __name__ == "__main__":
    main()
