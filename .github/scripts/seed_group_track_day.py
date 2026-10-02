"""Backfill group_track_daily_stats from git history. One-shot.

data/group_streams/last_tracks.json is the per-track state of a group's last
COMPLETE day — fetch_group_streams.py advances it only on a day it actually
records — and it is COMMITTED on every such day. So every past snapshot is still
in git, and with it every past per-track daily delta. Nothing has to be
re-fetched or estimated: this walks the file's commits oldest-first, pairs each
snapshot with the day it belongs to (that commit's newest recorded day for the
group, read from the history.json beside it), and writes the rows.

Why it matters beyond tidiness: without any seed, the first day Spotify publishes
after the table exists has no earlier per-track values to subtract, so it lands
with a NULL delta and the first usable per-track rate is two publishes away. With
the backfill there are real deltas on day one — e.g. ILLIT's "Magnetic" at
+580,979 / +549,747 / +524,542 across 27–29 Sep, which is the number this whole
table exists to make answerable.

Guards, applied per snapshot rather than once:
  - a day marked provisional is skipped (its values are not one day's)
  - a day whose note says "last-known" is skipped (some values are carried
    forward from an earlier day and we cannot say which ones)
  - a snapshot that does not sum to the total recorded for that day is skipped
    (then it is not that day's snapshot)
  - daily_delta is written ONLY between consecutive days; across a gap it is
    NULL, because a two-day jump recorded as a daily figure is worse than none

Needs full history: actions/checkout@v4 with fetch-depth: 0.
Writes nothing unless WRITE=1. Needs SUPABASE_URL / SUPABASE_SERVICE_KEY.
"""

import json
import os
import subprocess
import sys
from datetime import date, timedelta

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


def git(*args):
    r = subprocess.run(("git",) + args, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr.strip())
    return r.stdout


def show_json(sha, path):
    return json.loads(git("show", f"{sha}:{path}"))


def snapshots():
    """[(sha, {artist_id: (day, {track_id: streams})})] oldest commit first.

    Includes the working tree as the final entry: the newest recorded day may
    not have been committed yet when this runs, and it is the one the next day's
    delta will be measured against."""
    shas = git("log", "--format=%H", "--reverse", "--", LAST_TRACKS).split()
    out = []
    for sha in shas:
        try:
            out.append((sha[:8], show_json(sha, LAST_TRACKS), show_json(sha, HISTORY)))
        except Exception as e:
            print(f"  ⚠ {sha[:8]}: unreadable ({e}) — skipped")
    out.append(("worktree", json.load(open(LAST_TRACKS)), json.load(open(HISTORY))))
    return out


def main():
    if not (SUPABASE_URL and SUPABASE_KEY):
        sys.exit("SUPABASE_URL / SUPABASE_SERVICE_KEY required")

    cats = {}
    for fn in sorted(os.listdir(CATALOG_DIR)):
        if fn.endswith(".json"):
            c = json.load(open(os.path.join(CATALOG_DIR, fn)))
            cats[c["artist_id"]] = c

    # artist_id -> {day: snapshot}. A later commit wins for the same day, which
    # is what we want: a day rewritten while it was open ends up with its
    # finished values rather than its first partial ones.
    per_group = {aid: {} for aid in cats}
    for label, snap, hist in snapshots():
        for aid in cats:
            s = snap.get(aid)
            if not s:
                continue
            days = [d for d, g in hist.items() if aid in g]
            if not days:
                continue
            day = max(days)
            rec = hist[day][aid]
            why = None
            if rec.get("provisional"):
                why = f"{day} is provisional"
            elif "last-known" in (rec.get("note") or ""):
                why = f"{day} note: {rec['note']!r}"
            elif sum(s.values()) != rec["total_streams"]:
                why = (f"snapshot sums to {sum(s.values()):,}, {day} recorded "
                       f"{rec['total_streams']:,}")
            if why:
                print(f"  ⚠ {cats[aid]['name']} @{label}: skipped — {why}")
                continue
            per_group[aid][day] = s

    total_rows = 0
    for aid, cat in cats.items():
        days = sorted(per_group[aid])
        print(f"\n=== {cat['name']} [{aid}] — {len(days)} usable snapshot(s)")
        if not days:
            print("  nothing to write")
            continue
        names = {t["id"]: t for t in cat["tracks"]}
        rows, prev_day, prev = [], None, {}
        for day in days:
            snap = per_group[aid][day]
            consecutive = (prev_day is not None
                           and date.fromisoformat(day) - date.fromisoformat(prev_day)
                           == timedelta(days=1))
            by_value = {}
            for tid, v in snap.items():
                if v >= MERGE_MIN:
                    by_value.setdefault(v, []).append(tid)
            merged = {v: ids for v, ids in by_value.items() if len(ids) > 1}
            n_delta = 0
            for tid, v in snap.items():
                if tid not in names:
                    continue
                delta = None
                if consecutive and tid in prev:
                    delta = v - prev[tid]
                    n_delta += 1
                rows.append({
                    "track_id": tid, "date": day, "streams": v, "daily_delta": delta,
                    "merged_with": len(merged.get(v, [])) - 1 if v in merged else 0,
                    "stale": False,
                })
            gap = ("" if prev_day is None else
                   "" if consecutive else f" [gap after {prev_day} — deltas NULL]")
            print(f"  {day}: {len(snap)} tracks, {sum(snap.values()):,} total, "
                  f"{len(merged)} merged group(s), {n_delta} delta(s){gap}")
            prev_day, prev = day, snap

        # Show the per-track series this unlocks for the group's biggest tracks,
        # before writing anything — the point of a dry run is to read the numbers
        # rather than the row count.
        newest = max(days)
        top = sorted((r for r in rows if r["date"] == newest),
                     key=lambda r: -r["streams"])[:3]
        for t in top:
            series = [r for r in rows
                      if r["track_id"] == t["track_id"] and r["daily_delta"] is not None]
            ds = ", ".join(f"{r['date']} {r['daily_delta']:+,}" for r in series[-3:])
            label = names[t["track_id"]].get("name") or t["track_id"]
            print(f"    {label}: {t['streams']:,} — {ds or 'no delta yet'}")

        if not WRITE:
            total_rows += len(rows)
            print(f"  WRITE != 1 — would write {len(rows)} row(s)")
            continue

        refs = {r["track_id"]: r["id"] for r in sb(
            "POST", "/group_tracks",
            params={"on_conflict": "track_id"},
            headers={"Prefer": "resolution=merge-duplicates,return=representation"},
            json=[{"artist_id": aid, "track_id": t["id"], "name": t.get("name"),
                   "feature": bool(t.get("feature"))} for t in cat["tracks"]])}
        payload = [{"track_ref": refs[r["track_id"]], "date": r["date"],
                    "streams": r["streams"], "daily_delta": r["daily_delta"],
                    "merged_with": r["merged_with"], "stale": r["stale"]}
                   for r in rows if r["track_id"] in refs]
        for i in range(0, len(payload), 200):
            sb("POST", "/group_track_daily_stats",
               params={"on_conflict": "track_ref,date"},
               headers={"Prefer": "resolution=merge-duplicates"},
               json=payload[i:i + 200])
        total_rows += len(payload)
        print(f"  wrote {len(payload)} row(s)")

    print(f"\n{'wrote' if WRITE else 'would write'} {total_rows} row(s) in total")


if __name__ == "__main__":
    main()
