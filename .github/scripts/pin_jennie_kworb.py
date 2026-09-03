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
KWORB_TOTAL = 8_441_429_322
KWORB_DAILY = 7_973_242


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
    if not cur:
        print(f"FATAL: no artist_daily_stats row for JENNIE on {DATE}", file=sys.stderr)
        sys.exit(1)
    c = cur[0]
    print(f"JENNIE {DATE}:")
    print(f"  current : total={c['total_streams']:>15,}  daily={c['daily_delta']:>12,}")
    print(f"  kworb   : total={KWORB_TOTAL:>15,}  daily={KWORB_DAILY:>12,}")
    print(f"  Δtotal={KWORB_TOTAL - c['total_streams']:>+,}   Δdaily={KWORB_DAILY - c['daily_delta']:>+,}")

    if APPLY:
        sb("PATCH", "/artist_daily_stats",
           params={"artist_id": f"eq.{JENNIE_ID}", "date": f"eq.{DATE}"},
           json={"total_streams": KWORB_TOTAL, "daily_delta": KWORB_DAILY})
        print("  -> pinned to kworb.")
    else:
        print("  -> dry-run (set APPLY=1 to write).")


if __name__ == "__main__":
    main()
