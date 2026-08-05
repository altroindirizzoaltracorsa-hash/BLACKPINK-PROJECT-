"""
Patches artist_daily_stats for all 4 solo artists to fix the Aug 2/3
date mislabeling:

Current state:
  2026-08-02 rows contain Aug 3 Spotify data (wrong label)
  2026-08-03 rows are missing entirely

Steps per artist:
  1. Read the current 2026-08-02 row (it contains Aug 3 data + Aug 3 followers/rank)
  2. Clone it as 2026-08-03 with the correct Aug 3 total_streams / daily_delta
  3. Patch 2026-08-02 with the correct Aug 2 total_streams / daily_delta
     (followers/rank fields stay from the existing row — acceptable approximation)

Correct values recovered from the 04:30 UTC Aug 4 GitHub Actions log
(job 91892812656), which fetched real Aug 2 Spotify data but mislabelled
it as Aug 3.
"""

import os
import sys
import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

ARTISTS = {
    "6UZ0ba50XreR4TM8u322gs": {
        "name": "JISOO",
        "aug2": {"total_streams": 1356134692, "daily_delta": 654838},
        "aug3": {"total_streams": 1356828148, "daily_delta": 693456},
    },
    "250b0Wlc5Vk0CoUsaCY84M": {
        "name": "JENNIE",
        "aug2": {"total_streams": 8200475759, "daily_delta": 8185448},
        "aug3": {"total_streams": 8209245043, "daily_delta": 8769284},
    },
    "3eVa5w3URK5duf6eyVDbu9": {
        "name": "ROSÉ",
        "aug2": {"total_streams": 5659757466, "daily_delta": 3095644},
        "aug3": {"total_streams": 5663023650, "daily_delta": 3266184},
    },
    "5L1lO4eRHmJ7a0Q6csE5cT": {
        "name": "LISA",
        "aug2": {"total_streams": 5403636985, "daily_delta": 2058781},
        "aug3": {"total_streams": 5405827242, "daily_delta": 2190257},
    },
}


def sb(method, path, **kwargs):
    headers = {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
        **kwargs.pop("headers", {}),
    }
    r = httpx.request(
        method, f"{SUPABASE_URL}/rest/v1{path}",
        headers=headers, timeout=30, **kwargs,
    )
    if r.is_error:
        print(f"  ERROR {r.status_code}: {r.text}", file=sys.stderr)
    r.raise_for_status()
    return r.json() if r.content else None


def main():
    for artist_id, info in ARTISTS.items():
        name = info["name"]
        print(f"\n{'='*55}")
        print(f"Processing {name} ({artist_id})")

        # Step 1: Read the current (wrong) 2026-08-02 row in full
        current = sb("GET", "/artist_daily_stats", params={
            "artist_id": f"eq.{artist_id}",
            "date": "eq.2026-08-02",
            "select": "*",
        })

        if current:
            row = current[0]
            print(f"  Current 2026-08-02: total={row.get('total_streams'):,}  delta={row.get('daily_delta')}")

            # Step 2: Upsert this row as 2026-08-03 with correct streams/delta
            aug3_row = {
                **row,
                "date": "2026-08-03",
                **info["aug3"],
            }
            sb(
                "POST", "/artist_daily_stats",
                params={"on_conflict": "artist_id,date"},
                headers={"Prefer": "resolution=merge-duplicates"},
                json=[aug3_row],
            )
            print(f"  ✓ Upserted 2026-08-03: total={info['aug3']['total_streams']:,}  delta={info['aug3']['daily_delta']:,}")
        else:
            print(f"  No 2026-08-02 row — creating minimal 2026-08-03")
            sb(
                "POST", "/artist_daily_stats",
                params={"on_conflict": "artist_id,date"},
                headers={"Prefer": "resolution=merge-duplicates"},
                json=[{"artist_id": artist_id, "date": "2026-08-03", **info["aug3"]}],
            )
            print(f"  ✓ Created 2026-08-03: total={info['aug3']['total_streams']:,}")

        # Step 3: Patch 2026-08-02 with correct Aug 2 streams/delta
        sb(
            "POST", "/artist_daily_stats",
            params={"on_conflict": "artist_id,date"},
            headers={"Prefer": "resolution=merge-duplicates"},
            json=[{"artist_id": artist_id, "date": "2026-08-02", **info["aug2"]}],
        )
        print(f"  ✓ Patched 2026-08-02: total={info['aug2']['total_streams']:,}  delta={info['aug2']['daily_delta']:,}")

    # Verification
    print(f"\n{'='*55}")
    print("=== VERIFICATION ===")

    all_ok = True
    for artist_id, info in ARTISTS.items():
        name = info["name"]
        print(f"\n--- {name} ---")

        rows = sb("GET", "/artist_daily_stats", params=[
            ("artist_id", f"eq.{artist_id}"),
            ("date", "gte.2026-08-01"),
            ("date", "lte.2026-08-05"),
            ("order", "date.asc"),
            ("select", "date,total_streams,daily_delta"),
        ])

        for row in (rows or []):
            d = row["date"]
            total = row["total_streams"]
            delta = row["daily_delta"]
            flag = ""
            if d == "2026-08-02":
                ok = total == info["aug2"]["total_streams"]
                flag = f"  {'✓' if ok else '✗ WRONG (expected ' + str(info['aug2']['total_streams']) + ')'}"
                if not ok:
                    all_ok = False
            elif d == "2026-08-03":
                ok = total == info["aug3"]["total_streams"]
                flag = f"  {'✓' if ok else '✗ WRONG (expected ' + str(info['aug3']['total_streams']) + ')'}"
                if not ok:
                    all_ok = False
            print(f"  {d}: {total:,}  (delta={delta}){flag}")

    print(f"\n{'✓ ALL VERIFIED CORRECT' if all_ok else '✗ VERIFICATION FAILED'}")
    if not all_ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
