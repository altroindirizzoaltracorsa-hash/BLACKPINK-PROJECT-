"""
Patches track_daily_stats for all tracked songs to fix the Aug 2/3
date mislabeling.

Current state after the failed relabeling (relabel_artist_dates.py):
  2026-08-02 rows: contain Aug 3 Spotify track data (wrong label)
  2026-08-03 rows: missing (were deleted; original Aug 2 data is lost)

Strategy:
  1. Read current 2026-08-02 track rows (they are really Aug 3 data).
  2. Copy them to 2026-08-03 unchanged — those streams/delta values ARE correct.
  3. For 2026-08-02: reconstruct per-track values by proportional scaling
     from the known correct artist-level Aug 2 vs Aug 3 deltas.
     aug2_track_delta ≈ aug3_track_delta * (artist_aug2_delta / artist_aug3_delta)
     aug2_track_streams = aug3_track_streams - aug3_track_delta + aug2_track_delta

The scale factors are derived from values recovered from the 04:30 UTC Aug 4
GitHub Actions log (job 91892812656).
"""

import os
import sys
import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

# artist_aug2_delta / artist_aug3_delta
# BLACKPINK group: 4359152 / 4556004
# JISOO:           654838  / 693456
# JENNIE:          8185448 / 8769284
# ROSÉ:            3095644 / 3266184
# LISA:            2058781 / 2190257
SCALE = {
    "41MozSoPIsD1dJM0CLPjZF": 4359152 / 4556004,   # BLACKPINK
    "6UZ0ba50XreR4TM8u322gs": 654838  / 693456,     # JISOO
    "250b0Wlc5Vk0CoUsaCY84M": 8185448 / 8769284,    # JENNIE
    "3eVa5w3URK5duf6eyVDbu9": 3095644 / 3266184,    # ROSÉ
    "5L1lO4eRHmJ7a0Q6csE5cT": 2058781 / 2190257,    # LISA
}

ARTIST_AUG2_TOTAL = {
    "41MozSoPIsD1dJM0CLPjZF": 17595602852,
    "6UZ0ba50XreR4TM8u322gs": 1356134692,
    "250b0Wlc5Vk0CoUsaCY84M": 8200475759,
    "3eVa5w3URK5duf6eyVDbu9": 5659757466,
    "5L1lO4eRHmJ7a0Q6csE5cT": 5403636985,
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
    # Build track_ref → artist_id mapping from artist_tracks table
    print("Loading artist_tracks mapping...")
    all_artist_tracks = sb("GET", "/artist_tracks", params={
        "select": "id,artist_id,name",
    })
    ref_to_artist = {str(r["id"]): r["artist_id"] for r in (all_artist_tracks or [])}
    print(f"  Loaded {len(ref_to_artist)} tracks")

    # Read all current 2026-08-02 track rows (these contain Aug 3 Spotify data)
    print("\nLoading track_daily_stats for 2026-08-02...")
    aug2_rows = sb("GET", "/track_daily_stats", params={
        "date": "eq.2026-08-02",
        "select": "track_ref,streams,daily_delta",
    })
    if not aug2_rows:
        print("  No rows found for 2026-08-02. Nothing to fix.")
        sys.exit(0)
    print(f"  Found {len(aug2_rows)} rows")

    # Bucket by artist for reporting
    by_artist = {}
    unknown = []
    for row in aug2_rows:
        ref = str(row["track_ref"])
        artist_id = ref_to_artist.get(ref)
        if not artist_id:
            unknown.append(ref)
            continue
        by_artist.setdefault(artist_id, []).append(row)

    if unknown:
        print(f"  WARNING: {len(unknown)} track_refs not found in artist_tracks: {unknown[:5]}...")

    # Step 1: Copy current 2026-08-02 rows → 2026-08-03 (these ARE Aug 3 data)
    print("\nStep 1: Copying 2026-08-02 rows → 2026-08-03 (Aug 3 data)...")
    aug3_rows = [
        {
            "track_ref": row["track_ref"],
            "date": "2026-08-03",
            "streams": row["streams"],
            "daily_delta": row["daily_delta"],
        }
        for row in aug2_rows
    ]
    # Upsert in batches of 200
    batch_size = 200
    for i in range(0, len(aug3_rows), batch_size):
        batch = aug3_rows[i:i + batch_size]
        sb(
            "POST", "/track_daily_stats",
            params={"on_conflict": "track_ref,date"},
            headers={"Prefer": "resolution=merge-duplicates"},
            json=batch,
        )
    print(f"  ✓ Upserted {len(aug3_rows)} rows as 2026-08-03")

    # Step 2: Reconstruct 2026-08-02 per-track values via proportional scaling
    print("\nStep 2: Rebuilding 2026-08-02 rows via proportional scaling...")
    reconstructed = []
    for artist_id, rows in by_artist.items():
        scale = SCALE.get(artist_id)
        if scale is None:
            print(f"  WARNING: no scale factor for artist {artist_id}, skipping {len(rows)} tracks")
            continue
        for row in rows:
            aug3_streams = row["streams"]
            aug3_delta = row["daily_delta"]
            if aug3_delta is None:
                # No delta info — use stream value as-is (can't scale)
                reconstructed.append({
                    "track_ref": row["track_ref"],
                    "date": "2026-08-02",
                    "streams": aug3_streams,
                    "daily_delta": None,
                })
                continue
            aug2_delta = round(aug3_delta * scale)
            aug2_streams = aug3_streams - aug3_delta + aug2_delta
            reconstructed.append({
                "track_ref": row["track_ref"],
                "date": "2026-08-02",
                "streams": aug2_streams,
                "daily_delta": aug2_delta,
            })

    for i in range(0, len(reconstructed), batch_size):
        batch = reconstructed[i:i + batch_size]
        sb(
            "POST", "/track_daily_stats",
            params={"on_conflict": "track_ref,date"},
            headers={"Prefer": "resolution=merge-duplicates"},
            json=batch,
        )
    print(f"  ✓ Upserted {len(reconstructed)} reconstructed rows for 2026-08-02")

    # Verification summary
    print("\n=== VERIFICATION ===")
    for artist_id, rows in sorted(by_artist.items()):
        artist_name = {
            "41MozSoPIsD1dJM0CLPjZF": "BLACKPINK",
            "6UZ0ba50XreR4TM8u322gs": "JISOO",
            "250b0Wlc5Vk0CoUsaCY84M": "JENNIE",
            "3eVa5w3URK5duf6eyVDbu9": "ROSÉ",
            "5L1lO4eRHmJ7a0Q6csE5cT": "LISA",
        }.get(artist_id, artist_id)

        refs = [str(r["track_ref"]) for r in rows]
        check_aug2 = sb("GET", "/track_daily_stats", params={
            "track_ref": f"in.({','.join(refs)})",
            "date": "eq.2026-08-02",
            "select": "track_ref,streams,daily_delta",
        })
        check_aug3 = sb("GET", "/track_daily_stats", params={
            "track_ref": f"in.({','.join(refs)})",
            "date": "eq.2026-08-03",
            "select": "track_ref,streams,daily_delta",
        })
        aug2_sum = sum(r["streams"] for r in (check_aug2 or []))
        aug3_sum = sum(r["streams"] for r in (check_aug3 or []))
        expected_aug2 = ARTIST_AUG2_TOTAL.get(artist_id, "?")
        print(
            f"  {artist_name}: "
            f"2026-08-02 tracks={len(check_aug2 or [])}/{len(rows)} sum={aug2_sum:,} (artist_total={expected_aug2:,})  "
            f"| 2026-08-03 tracks={len(check_aug3 or [])}/{len(rows)} sum={aug3_sum:,}"
        )

    print("\n✓ Done")


if __name__ == "__main__":
    main()
