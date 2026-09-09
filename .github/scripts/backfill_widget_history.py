"""
One-time fix, not part of the daily pipeline:

The site's older kworb-derived "total streams" widget already had daily
deltas going back further than our new per-track tracking does:

    17/07  +4,628,975
    16/07  +4,555,519
    15/07  +4,562,281
    14/07  +4,666,057

Each delta is the change *on* that day (e.g. 17/07's delta is
total(07-17) - total(07-16)). Our 07-17 baseline (from the kworb
snapshot used to pin the track list) is already in artist_daily_stats,
so working backwards from it gives real totals for 07-14 through 07-16
too -- extending "Streams last 7 days" instead of starting it at 07-17.
No per-track breakdown is available for these days (the widget only
ever tracked the aggregate), so this only touches artist_daily_stats.

Also patches 07-17's own daily_delta, which was null (it was the
earliest row when it was first inserted) but is now derivable the same
way: 4,628,975, matching the widget exactly.

Requires SUPABASE_URL / SUPABASE_SERVICE_KEY env vars.
"""

import os
import sys

import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

BLACKPINK_ID = "41MozSoPIsD1dJM0CLPjZF"
BASELINE_DATE = "2026-07-17"
BASELINE_TOTAL = 17522009888

# date -> change that occurred *on* that date (vs. the day before), from
# the site's existing kworb-derived widget.
WIDGET_DELTAS = {
    "2026-07-17": 4628975,
    "2026-07-16": 4555519,
    "2026-07-15": 4562281,
    "2026-07-14": 4666057,
}


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
    rows = sb("GET", "/artist_daily_stats", params={
        "artist_id": f"eq.{BLACKPINK_ID}",
        "date": f"eq.{BASELINE_DATE}",
        "select": "total_streams,followers,monthly_listeners,track_count",
    })
    if not rows:
        print(f"FATAL: no {BASELINE_DATE} row for {BLACKPINK_ID} -- run backfill_july17_baseline.py first", file=sys.stderr)
        sys.exit(1)
    baseline_row = rows[0]
    if baseline_row["total_streams"] != BASELINE_TOTAL:
        print(f"FATAL: {BASELINE_DATE} total_streams is {baseline_row['total_streams']:,}, expected {BASELINE_TOTAL:,}", file=sys.stderr)
        sys.exit(1)

    order = ["2026-07-17", "2026-07-16", "2026-07-15", "2026-07-14"]
    totals = {"2026-07-17": BASELINE_TOTAL}
    for i in range(len(order) - 1):
        day, prev_day = order[i], order[i + 1]
        totals[prev_day] = totals[day] - WIDGET_DELTAS[day]

    payload = [{
        "artist_id": BLACKPINK_ID,
        "date": date,
        "total_streams": totals[date],
        "daily_delta": WIDGET_DELTAS[date],
        "followers": baseline_row["followers"],
        "monthly_listeners": baseline_row["monthly_listeners"],
        "track_count": baseline_row["track_count"],
    } for date in order]

    for row in payload:
        print(f"  {row['date']}: total={row['total_streams']:,} delta={row['daily_delta']:,}")

    sb("POST", "/artist_daily_stats",
       params={"on_conflict": "artist_id,date"},
       headers={"Prefer": "resolution=merge-duplicates"},
       json=payload)

    print("Done.")


if __name__ == "__main__":
    main()
