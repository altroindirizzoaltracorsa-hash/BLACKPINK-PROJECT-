"""Release dates for the group tracks that are in range of 1 billion streams.

The 1B comparison is measured in DAYS FROM RELEASE, so the release date is the
one term we fetch everything else for and never stored. This fills it.

Scoped by streams rather than run over all ~870 tracks: a track at 40M is not in
a race to 1B for years, and its date can be fetched when it is. FLOOR (default
300,000,000) is read against each track's newest recorded figure in
group_track_daily_stats, so the scope widens on its own as tracks grow.

Idempotent and additive: tracks that already have a date are skipped unless
REFETCH=1. Writes nothing unless WRITE=1.

Env: SUPABASE_URL, SUPABASE_SERVICE_KEY. Optional FLOOR, WRITE, REFETCH, BATCH.
"""

import os
import sys

import httpx
from spotify_scraper import SpotifyClient

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
FLOOR = int(os.environ.get("FLOOR", "300000000"))
WRITE = os.environ.get("WRITE", "0") == "1"
REFETCH = os.environ.get("REFETCH", "0") == "1"
BATCH = int(os.environ.get("BATCH", "40"))


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


def in_range():
    """[(ref, track_id, name, streams)] — tracks at or above FLOOR on their
    newest recorded day, newest-first by streams."""
    tracks = sb("GET", "/group_tracks",
                params={"select": "id,track_id,name,release_date", "limit": "5000"})
    by_ref = {t["id"]: t for t in tracks}
    # One query for the whole table rather than per track: 870 tracks x 25 days
    # is still a small read, and 870 round trips is not.
    stats = sb("GET", "/group_track_daily_stats",
               params={"select": "track_ref,date,streams", "order": "date.desc",
                       "streams": f"gte.{FLOOR}", "limit": "20000"})
    newest = {}
    for s in stats:                     # already newest-first
        newest.setdefault(s["track_ref"], s)
    out = []
    for ref, s in newest.items():
        t = by_ref.get(ref)
        if not t:
            continue
        if t.get("release_date") and not REFETCH:
            continue
        out.append((ref, t["track_id"], t.get("name"), s["streams"]))
    out.sort(key=lambda r: -r[3])
    return out, len(by_ref), sum(1 for t in tracks if t.get("release_date"))


def main():
    if not (SUPABASE_URL and SUPABASE_KEY):
        sys.exit("SUPABASE_URL / SUPABASE_SERVICE_KEY required")

    todo, n_tracks, n_dated = in_range()
    print(f"group_tracks: {n_tracks} rows, {n_dated} already dated")
    print(f"at or above {FLOOR:,} streams and still undated: {len(todo)}")
    if not todo:
        print("nothing to do")
        return

    found, missing = [], []
    with SpotifyClient() as client:
        for i in range(0, len(todo), BATCH):
            chunk = todo[i:i + BATCH]
            try:
                results = client.get_tracks([t[1] for t in chunk])
            except Exception as e:
                print(f"  batch failed: {e}", file=sys.stderr)
                missing.extend(chunk)
                continue
            for (ref, tid, name, streams), item in zip(chunk, results):
                rd = getattr(item.result, "release_date", None) if item.ok else None
                if not rd:
                    missing.append((ref, tid, name, streams))
                    continue
                iso = rd.date().isoformat() if hasattr(rd, "date") else str(rd)[:10]
                # Spotify serves some dates as year-only, which arrives as 1
                # January. Recorded as 'year' so a coarse date can be shown as
                # coarse rather than read as a New Year's Day release — a
                # days-from-release figure built on it is out by up to a year.
                prec = getattr(item.result, "release_date_precision", None)
                if not prec:
                    prec = "year" if iso.endswith("-01-01") else "day"
                found.append({"ref": ref, "track_id": tid, "name": name,
                              "streams": streams, "release_date": iso,
                              "precision": prec})

    print(f"\nresolved {len(found)}, unresolved {len(missing)}")
    for f in found:
        flag = "  ← year-only, treat as approximate" if f["precision"] == "year" else ""
        print(f"  {f['streams']:>14,}  {f['release_date']}  {f['name']}{flag}")
    for ref, tid, name, streams in missing:
        print(f"  {streams:>14,}  {'—':>10}  {name} [{tid}] — no release date returned")

    if not WRITE:
        print(f"\nWRITE != 1 — would set {len(found)} release date(s)")
        return
    for f in found:
        sb("PATCH", "/group_tracks",
           params={"id": f"eq.{f['ref']}"},
           json={"release_date": f["release_date"], "release_precision": f["precision"]})
    print(f"\nset {len(found)} release date(s)")


if __name__ == "__main__":
    main()
