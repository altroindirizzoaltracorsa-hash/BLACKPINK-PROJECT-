"""
One-off backfill: inject the Fallen Angel EP release-week daily history for
JENNIE's "Fallen Angel" and "Heaven" into track_daily_stats.

Those two tracks were only pinned to FIXED_TRACKS on Sep 2, so the pipeline has
no prior rows for them and their first fetched day would read as a single "new
track" jump. The totals below are Spotify play_count snapshots for Aug 28 -
Sep 1, 2026 (from an external tracker). Each day's delta is the difference from
the prior day; the first day is null (brand-new track). We also patch the most
recent already-fetched row (if any) so its delta is measured against Sep 1
instead of 0.

Only touches these two tracks' per-track rows -- it does NOT rewrite
artist_daily_stats or the catalog total (we don't have JENNIE's full historical
per-day totals, and going forward the aggregates include the tracks anyway).

Dry-run unless APPLY=1. Requires SUPABASE_URL / SUPABASE_SERVICE_KEY; the
service_role key needs select + insert + update on track_daily_stats.
"""

import os
import sys

import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
APPLY = bool(os.environ.get("APPLY"))

JENNIE_ID = "250b0Wlc5Vk0CoUsaCY84M"
LAST_HIST_DATE = "2026-09-01"

# spotify track id -> { date: cumulative play_count }
HISTORY = {
    "75QkBCdRc5DGgcyPiVSg4b": {  # Fallen Angel
        "2026-08-28": 1_507_295,
        "2026-08-29": 2_764_813,
        "2026-08-30": 3_888_497,
        "2026-08-31": 5_113_793,
        "2026-09-01": 6_289_713,
    },
    "6uhCnqc4Tncn1vqkuGubPO": {  # Heaven
        "2026-08-28": 1_601_452,
        "2026-08-29": 2_628_088,
        "2026-08-30": 3_477_152,
        "2026-08-31": 4_441_006,
        "2026-09-01": 5_252_024,
    },
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
    tracks = sb("GET", "/artist_tracks", params={
        "artist_id": f"eq.{JENNIE_ID}", "select": "id,name,source_track_ids",
    })
    ref_by_tid = {}
    name_by_ref = {}
    for t in tracks:
        name_by_ref[t["id"]] = t["name"]
        for tid in (t["source_track_ids"] or []):
            ref_by_tid[tid] = t["id"]

    missing = [tid for tid in HISTORY if tid not in ref_by_tid]
    if missing:
        print(f"FATAL: no artist_tracks row yet for {missing} -- run the catalog "
              f"fetch (/update-streams) first so the tracks get created.", file=sys.stderr)
        sys.exit(1)

    for tid, totals in HISTORY.items():
        ref = ref_by_tid[tid]
        name = name_by_ref.get(ref, tid)
        rows = []
        prev = None
        for d in sorted(totals):
            total = totals[d]
            delta = None if prev is None else total - prev
            rows.append({"track_ref": ref, "date": d, "streams": total, "daily_delta": delta})
            prev = total

        # Patch the first already-fetched row after the backfilled history, so
        # its delta is against Sep 1 rather than 0.
        latest = sb("GET", "/track_daily_stats", params={
            "track_ref": f"eq.{ref}", "date": f"gt.{LAST_HIST_DATE}",
            "select": "date,streams,daily_delta", "order": "date.asc",
        })
        patch = None
        if latest:
            fa = latest[0]
            patch = {
                "track_ref": ref, "date": fa["date"], "streams": fa["streams"],
                "daily_delta": fa["streams"] - totals[LAST_HIST_DATE],
            }

        print(f"\n{name} ({tid}) track_ref={ref}:")
        for row in rows:
            print(f"  {row['date']}  total={row['streams']:>12,}  delta={row['daily_delta']}")
        if patch:
            print(f"  PATCH {patch['date']}  total={patch['streams']:>12,}  delta -> {patch['daily_delta']:,}")
        else:
            print(f"  (no row after {LAST_HIST_DATE} yet -- its delta will compute on the next fetch)")

        if APPLY:
            sb("POST", "/track_daily_stats",
               params={"on_conflict": "track_ref,date"},
               headers={"Prefer": "resolution=merge-duplicates"}, json=rows)
            if patch:
                sb("POST", "/track_daily_stats",
                   params={"on_conflict": "track_ref,date"},
                   headers={"Prefer": "resolution=merge-duplicates"}, json=[patch])
            print("  -> written.")
        else:
            print("  -> dry-run (set APPLY=1 to write).")

    print("\nDone." + ("" if APPLY else "  (dry-run -- nothing written)"))


if __name__ == "__main__":
    main()
