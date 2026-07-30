"""
Diagnoses and fixes the duplicate GO entry in artist_tracks for BLACKPINK.
Two GO versions ended up as separate rows, doubling the stream count.
Keeps the row whose source_track_ids contains the canonical ID and deletes the other.
"""

import os
import sys
import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

BLACKPINK_ID = "41MozSoPIsD1dJM0CLPjZF"
CANONICAL_GO_ID = "0mYa3o6tlUN5HRippmKmwH"

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}

def sb(method, path, **kwargs):
    r = httpx.request(method, f"{SUPABASE_URL}/rest/v1{path}", headers={
        **HEADERS, **kwargs.pop("headers", {})
    }, timeout=30, **kwargs)
    r.raise_for_status()
    return r.json() if r.content else None

def main():
    # Find all artist_tracks rows for BLACKPINK where name contains 'GO'
    rows = sb("GET", "/artist_tracks", params={
        "artist_id": f"eq.{BLACKPINK_ID}",
        "name": "ilike.*GO*",
        "select": "id,name,source_track_ids",
    })

    print("GO-related rows in artist_tracks for BLACKPINK:")
    for r in rows:
        print(f"  id={r['id']}  name={r['name']!r}  source_track_ids={r['source_track_ids']}")

    # Find rows that don't contain the canonical GO track ID -> these are the duplicates
    duplicates = [r for r in rows if CANONICAL_GO_ID not in (r["source_track_ids"] or [])]
    canonical = [r for r in rows if CANONICAL_GO_ID in (r["source_track_ids"] or [])]

    if not duplicates:
        print("No duplicate GO rows found — nothing to delete.")
        return

    print(f"\nCanonical row(s): {[r['id'] for r in canonical]}")
    print(f"Duplicate row(s) to remove: {[r['id'] for r in duplicates]}")

    for dup in duplicates:
        dup_id = dup["id"]
        # Delete track_daily_stats first (foreign key)
        deleted_stats = sb("DELETE", "/track_daily_stats",
            params={"track_ref": f"eq.{dup_id}"},
            headers={"Prefer": "return=representation"},
        )
        print(f"  Deleted {len(deleted_stats or [])} track_daily_stats rows for track_ref={dup_id}")

        # Delete the artist_tracks row itself
        sb("DELETE", "/artist_tracks", params={"id": f"eq.{dup_id}"})
        print(f"  Deleted artist_tracks row id={dup_id} ({dup['name']!r})")

    print("\nDone. BLACKPINK GO is now counted once.")
    print("Re-run fetch-artist-streams to recalculate the artist total.")

main()
