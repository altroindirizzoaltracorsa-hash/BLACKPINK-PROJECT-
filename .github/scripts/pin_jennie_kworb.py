"""
One-off: align JENNIE's Sep 1 artist_daily_stats to jenniecharts.com / kworb
(they agree): total 8,441,429,322, daily +7,973,242.

For Sep 1 to *display* +7,973,242 without the streams page flagging "recount",
the previous day's total must equal total - daily = 8,433,456,080. Our stored
Aug 31 sits ~808K below that (scrape drift), so we also set Aug 31 to that
self-consistent value; its own daily is then recomputed against Aug 30. This
makes Sep 1 match jenniecharts exactly and the rows reconcile.

Only total_streams + daily_delta are PATCHed. Dry-run unless APPLY=1.
"""

import os
import sys

import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
APPLY = bool(os.environ.get("APPLY"))

JENNIE_ID = "250b0Wlc5Vk0CoUsaCY84M"
SEP1, AUG31, AUG30 = "2026-09-01", "2026-08-31", "2026-08-30"
SEP1_TOTAL = 8_441_429_322      # jenniecharts.com / kworb
SEP1_DAILY = 7_973_242          # jenniecharts.com / kworb
AUG31_TOTAL = SEP1_TOTAL - SEP1_DAILY   # 8,433,456,080 (implied so Sep 1 reconciles)


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


def get_row(date):
    rows = sb("GET", "/artist_daily_stats", params={
        "artist_id": f"eq.{JENNIE_ID}", "date": f"eq.{date}",
        "select": "date,total_streams,daily_delta",
    })
    return rows[0] if rows else None


def patch(date, total, daily):
    sb("PATCH", "/artist_daily_stats",
       params={"artist_id": f"eq.{JENNIE_ID}", "date": f"eq.{date}"},
       json={"total_streams": total, "daily_delta": daily})


def main():
    aug30 = get_row(AUG30)
    aug31 = get_row(AUG31)
    sep1 = get_row(SEP1)
    if not (aug30 and aug31 and sep1):
        print("FATAL: missing one of Aug 30 / Aug 31 / Sep 1 rows", file=sys.stderr)
        sys.exit(1)

    aug31_daily = AUG31_TOTAL - aug30["total_streams"]

    print(f"Aug 30 (anchor): total={aug30['total_streams']:,}")
    print(f"Aug 31:  current total={aug31['total_streams']:>15,} daily={aug31['daily_delta']:>12,}")
    print(f"         target  total={AUG31_TOTAL:>15,} daily={aug31_daily:>12,}")
    print(f"Sep 1:   current total={sep1['total_streams']:>15,} daily={sep1['daily_delta']:>12,}")
    print(f"         target  total={SEP1_TOTAL:>15,} daily={SEP1_DAILY:>12,}   (jenniecharts / kworb)")

    if APPLY:
        patch(AUG31, AUG31_TOTAL, aug31_daily)
        patch(SEP1, SEP1_TOTAL, SEP1_DAILY)
        print("\n-> written: Sep 1 now matches jenniecharts exactly; Aug 31 set to the reconciling value.")
    else:
        print("\n-> dry-run (set APPLY=1 to write).")


if __name__ == "__main__":
    main()
