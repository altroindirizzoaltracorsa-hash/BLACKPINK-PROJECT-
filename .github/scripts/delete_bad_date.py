"""One-time cleanup: delete the 2026-07-28 rows that were written
when Spotify hadn't published new counts yet (daily_delta=0).
"""

import os
import sys
import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
BAD_DATE = "2026-07-28"

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}

def delete_rows(table: str) -> int:
    url = f"{SUPABASE_URL}/rest/v1/{table}?date=eq.{BAD_DATE}"
    r = httpx.delete(url, headers={**HEADERS, "Prefer": "return=representation"})
    r.raise_for_status()
    deleted = r.json()
    return len(deleted)

def main():
    for table in ("track_daily_stats", "artist_daily_stats"):
        n = delete_rows(table)
        print(f"Deleted {n} row(s) from {table} for date={BAD_DATE}")
    print("Done.")

main()
