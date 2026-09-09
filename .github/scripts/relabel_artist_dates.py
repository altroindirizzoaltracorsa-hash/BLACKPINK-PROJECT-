"""
Copies artist_daily_stats and track_daily_stats rows from FROM_DATE to TO_DATE,
then deletes the original FROM_DATE rows. Used to fix date mislabeling caused
by off-schedule workflow triggers.

Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, FROM_DATE (YYYY-MM-DD), TO_DATE (YYYY-MM-DD)
"""

import os
import sys
import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
FROM_DATE = os.environ["FROM_DATE"]
TO_DATE = os.environ["TO_DATE"]


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


def relabel(table, conflict_key):
    print(f"\n--- {table} ---")
    rows = sb("GET", f"/{table}", params={"date": f"eq.{FROM_DATE}", "select": "*"})
    if not rows:
        print(f"  No rows for {FROM_DATE}, skipping.")
        return

    print(f"  Found {len(rows)} rows for {FROM_DATE}")
    new_rows = [{**r, "date": TO_DATE} for r in rows]
    sb(
        "POST", f"/{table}",
        params={"on_conflict": conflict_key},
        headers={"Prefer": "resolution=merge-duplicates"},
        json=new_rows,
    )
    print(f"  Upserted {len(new_rows)} rows as {TO_DATE}")

    sb("DELETE", f"/{table}", params={"date": f"eq.{FROM_DATE}"})
    print(f"  Deleted original {FROM_DATE} rows")


def main():
    print(f"Relabeling Supabase data: {FROM_DATE} → {TO_DATE}")
    relabel("artist_daily_stats", "artist_id,date")
    relabel("track_daily_stats", "track_ref,date")
    print("\nDone.")


if __name__ == "__main__":
    main()
