"""
Diagnostic: shows artist_daily_stats for all 5 tracked artists
for July 31 – Aug 5, so we can identify the Aug 2/3 corruption
in each and know what the correct values should be.
"""

import os
import sys
import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

ARTISTS = {
    "41MozSoPIsD1dJM0CLPjZF": "BLACKPINK",
    "6UZ0ba50XreR4TM8u322gs": "JISOO",
    "250b0Wlc5Vk0CoUsaCY84M": "JENNIE",
    "3eVa5w3URK5duf6eyVDbu9": "ROSÉ",
    "5L1lO4eRHmJ7a0Q6csE5cT": "LISA",
}


def sb(path, params=None):
    headers = {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "apikey": SUPABASE_KEY,
    }
    r = httpx.get(f"{SUPABASE_URL}/rest/v1{path}", headers=headers, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def main():
    for artist_id, name in ARTISTS.items():
        rows = sb("/artist_daily_stats", [
            ("artist_id", f"eq.{artist_id}"),
            ("date", "gte.2026-07-30"),
            ("date", "lte.2026-08-05"),
            ("order", "date.asc"),
            ("select", "date,total_streams,daily_delta"),
        ])
        print(f"\n=== {name} ({artist_id}) ===")
        if not rows:
            print("  No rows found")
            continue
        for r in rows:
            date = r["date"]
            total = r["total_streams"]
            delta = r["daily_delta"]
            flag = ""
            if date == "2026-08-02":
                flag = "  <-- CHECK (may contain Aug3 data)"
            elif date == "2026-08-03":
                flag = "  <-- CHECK (should exist)"
            print(f"  {date}: {total:,}  (delta={delta}){flag}")


if __name__ == "__main__":
    main()
