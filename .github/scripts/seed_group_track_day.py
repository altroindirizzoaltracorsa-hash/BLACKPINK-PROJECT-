"""Seed group_track_daily_stats with the per-track snapshot we already hold.

One-shot. data/group_streams/last_tracks.json is the per-track state of each
group's LAST COMPLETE day — fetch_group_streams.py advances it only on a day it
actually records — so the day it belongs to is simply that group's newest day in
history.json. Those are real observed numbers, already committed; this just puts
them in the table so the series has a starting row.

Why bother instead of waiting: daily_delta is computed against the previous
per-track values, so without a seed row the first day Spotify publishes after the
table exists would land with a NULL delta and the first usable rate would be two
publishes away. With it, the very next publish produces a real per-track daily
figure. The seed row's own delta is NULL — there is no earlier per-track snapshot
to subtract, and inventing one would be worse than an honest gap.

Refuses to run unless the snapshot and the history agree on track counts, and
refuses any group whose newest day is marked provisional or carries a
"last-known" note — in both of those cases some values are not that day's.

Writes nothing unless WRITE=1. Needs SUPABASE_URL / SUPABASE_SERVICE_KEY.
"""

import json
import os
import sys

import httpx

CATALOG_DIR = "data/group_catalogs"
HISTORY = "data/group_streams/history.json"
LAST_TRACKS = "data/group_streams/last_tracks.json"
WRITE = os.environ.get("WRITE", "0") == "1"
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
MERGE_MIN = 1_000_000


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
    if not (SUPABASE_URL and SUPABASE_KEY):
        sys.exit("SUPABASE_URL / SUPABASE_SERVICE_KEY required")
    history = json.load(open(HISTORY))
    last_tracks = json.load(open(LAST_TRACKS))

    for fn in sorted(os.listdir(CATALOG_DIR)):
        if not fn.endswith(".json"):
            continue
        cat = json.load(open(os.path.join(CATALOG_DIR, fn)))
        aid, name, tracks = cat["artist_id"], cat["name"], cat["tracks"]
        snap = last_tracks.get(aid) or {}
        days = sorted(d for d, groups in history.items() if aid in groups)
        print(f"\n=== {name} [{aid}]")
        if not days or not snap:
            print("  no recorded day or no snapshot — skipping")
            continue
        day = days[-1]
        rec = history[day][aid]
        if rec.get("provisional"):
            print(f"  {day} is provisional — skipping (its values are not one day's)")
            continue
        if "last-known" in (rec.get("note") or ""):
            print(f"  {day} note says {rec['note']!r} — skipping, some values are "
                  f"carried from an earlier day and we cannot say which")
            continue
        if len(snap) != rec["tracks"]:
            print(f"  snapshot has {len(snap)} tracks, {day} recorded "
                  f"{rec['tracks']} — skipping, they are not the same measurement")
            continue
        total = sum(snap.values())
        if total != rec["total_streams"]:
            print(f"  snapshot sums to {total:,} but {day} recorded "
                  f"{rec['total_streams']:,} — skipping, the snapshot is not this day")
            continue

        by_value = {}
        for tid, v in snap.items():
            if v >= MERGE_MIN:
                by_value.setdefault(v, []).append(tid)
        merged = {v: ids for v, ids in by_value.items() if len(ids) > 1}

        track_rows = [{"artist_id": aid, "track_id": t["id"], "name": t.get("name"),
                       "feature": bool(t.get("feature"))} for t in tracks]
        print(f"  {day}: {len(snap)} tracks, {total:,} total, "
              f"{len(merged)} merged value-group(s)")
        if not WRITE:
            print("  WRITE != 1 — nothing written")
            continue

        refs = {r["track_id"]: r["id"] for r in sb(
            "POST", "/group_tracks",
            params={"on_conflict": "track_id"},
            headers={"Prefer": "resolution=merge-duplicates,return=representation"},
            json=track_rows)}
        rows = []
        for tid, v in snap.items():
            ref = refs.get(tid)
            if ref is None:
                print(f"  ⚠ {tid} is in the snapshot but not the catalogue — skipped")
                continue
            rows.append({
                "track_ref": ref, "date": day, "streams": v,
                "daily_delta": None,          # no earlier per-track snapshot exists
                "merged_with": len(merged.get(v, [])) - 1 if v in merged else 0,
                "stale": False,               # the guards above rule staleness out
            })
        for i in range(0, len(rows), 200):
            sb("POST", "/group_track_daily_stats",
               params={"on_conflict": "track_ref,date"},
               headers={"Prefer": "resolution=merge-duplicates"},
               json=rows[i:i + 200])
        print(f"  wrote {len(rows)} per-track row(s) for {day}")


if __name__ == "__main__":
    main()
