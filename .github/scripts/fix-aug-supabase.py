"""
Patches artist_daily_stats for BLACKPINK group to fix the Aug 2/3 date mislabeling:
  2026-08-02: total_streams = 17,595,602,852  (daily_delta = +4,359,152)
  2026-08-03: total_streams = 17,600,158,856  (daily_delta = +4,556,004)

Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY
"""

import os
import sys
import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

BLACKPINK_ID = "41MozSoPIsD1dJM0CLPjZF"

CORRECT = [
    {"date": "2026-08-02", "total_streams": 17595602852, "daily_delta": 4359152},
    {"date": "2026-08-03", "total_streams": 17600158856, "daily_delta": 4556004},
]


def sb(method, path, **kwargs):
    headers = {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
        **kwargs.pop("headers", {}),
    }
    r = httpx.request(method, f"{SUPABASE_URL}/rest/v1{path}", headers=headers, timeout=30, **kwargs)
    if r.is_error:
        print(f"  ERROR {r.status_code}: {r.text}", file=sys.stderr)
    r.raise_for_status()
    return r.json() if r.content else None


def main():
    print(f"Fixing BLACKPINK group ({BLACKPINK_ID}) in artist_daily_stats")

    for row in CORRECT:
        d = row["date"]
        total = row["total_streams"]
        delta = row["daily_delta"]
        print(f"\n--- {d} ---")

        # Check current state
        existing = sb("GET", "/artist_daily_stats", params={
            "artist_id": f"eq.{BLACKPINK_ID}",
            "date": f"eq.{d}",
            "select": "date,total_streams,daily_delta",
        })
        if existing:
            print(f"  Current: total_streams={existing[0].get('total_streams'):,}  daily_delta={existing[0].get('daily_delta')}")
        else:
            print(f"  No existing row for {d}")

        # Upsert with correct values (only updates total_streams and daily_delta; leaves other fields intact)
        sb(
            "POST", "/artist_daily_stats",
            params={"on_conflict": "artist_id,date"},
            headers={"Prefer": "resolution=merge-duplicates"},
            json=[{
                "artist_id": BLACKPINK_ID,
                "date": d,
                "total_streams": total,
                "daily_delta": delta,
            }],
        )
        print(f"  ✓ upserted: total_streams={total:,}  daily_delta={delta:,}")

    # Verify
    print("\n=== Verification ===")
    rows = sb("GET", "/artist_daily_stats", params={
        "artist_id": f"eq.{BLACKPINK_ID}",
        "date": "gte.2026-07-31",
        "order": "date.asc",
        "select": "date,total_streams,daily_delta",
    })
    ok = True
    for row in (rows or []):
        flag = ""
        if row["date"] == "2026-08-02":
            flag = " <-- " + ("✓" if row["total_streams"] == 17595602852 else "✗ WRONG")
            if row["total_streams"] != 17595602852:
                ok = False
        elif row["date"] == "2026-08-03":
            flag = " <-- " + ("✓" if row["total_streams"] == 17600158856 else "✗ WRONG")
            if row["total_streams"] != 17600158856:
                ok = False
        print(f"  {row['date']}: {row['total_streams']:,}  (delta={row['daily_delta']}){flag}")

    if not rows:
        print("  No rows returned — check Supabase credentials")
        sys.exit(1)

    print(f"\n{'✓ VERIFIED CORRECT' if ok else '✗ VERIFICATION FAILED'}")
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
