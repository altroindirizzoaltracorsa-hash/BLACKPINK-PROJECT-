"""
Diagnose (and optionally correct) the double-counted catalog totals caused by
Spotify "combining" alternate versions of tracks.

Background
----------
Spotify periodically merges alternate versions (Japanese / live / remix) into
their original track. After a merge, EVERY track ID in the group returns the
same combined play_count. Our catalog total was the plain sum of every tracked
ID, so a merged group got counted once per member ID — double- (or triple-)
counting those streams. On the merge day this also produced fake
+hundreds-of-millions per-track "daily gains".

The going-forward fix lives in fetch_artist_streams.py (collapse_merged): each
merged group is now counted once for the artist total + track_count, and it
self-heals when Spotify later re-splits a pair. This script repairs the days
ALREADY recorded in artist_daily_stats, recomputing each day's total_streams and
track_count from that day's own per-track rows using the same collapse rule, and
re-chaining daily_delta against the corrected previous day.

Usage
-----
  # read-only diagnosis of every tracked artist, most recent days:
  python .github/scripts/fix_merged_double_count.py

  # limit to one artist and/or a start date, then apply:
  ARTIST=41MozSoPIsD1dJM0CLPjZF FROM=2026-08-15 APPLY=1 \
      python .github/scripts/fix_merged_double_count.py

Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (required). ARTIST, FROM, APPLY optional.
A day is only rewritten when it carries a reasonably complete set of per-track
rows (>= MIN_TRACK_ROWS), so sparse/partial days are reported but left untouched.
"""

import os
import sys
import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
APPLY = os.environ.get("APPLY") == "1"
ONLY_ARTIST = os.environ.get("ARTIST")
FROM_DATE = os.environ.get("FROM")
MERGE_MIN = 1_000_000
# Only rewrite a day whose per-track snapshot is near-complete for THAT artist
# (guards against partial days). Relative to the artist's own track count.
MIN_ROWS_FRACTION = 0.8
MIN_ROWS_FLOOR = 8

HEADERS = {"Authorization": f"Bearer {SUPABASE_KEY}", "apikey": SUPABASE_KEY,
           "Content-Type": "application/json"}

_VERSION_HINTS = (
    "japanese version", "jp ver", "- live", "live (", "(remix", "- remix",
    "remix version", "acoustic", "tokyo dome", "arena tour", "osaka", "seoul",
    "- 0.5x", "- 2x", "- bare", "- unveiled", "instrumental", "a cappella",
    "slowed", "sped up", "extended", "sam feldt", "special final",
)


def _is_version_name(name):
    n = (name or "").lower()
    return any(h in n for h in _VERSION_HINTS)


def collapse_merged(counted, merge_min=MERGE_MIN):
    """Collapse tracks sharing an identical (large) play_count to one entity.
    counted: [{name, streams}]. Returns (kept, merged_away)."""
    groups = {}
    for c in counted:
        groups.setdefault(c["streams"], []).append(c)
    kept, merged_away = [], []
    for streams, grp in groups.items():
        if len(grp) > 1 and streams >= merge_min:
            grp = sorted(grp, key=lambda c: (_is_version_name(c["name"]), len(c["name"]), c["name"]))
            kept.append(grp[0])
            merged_away.extend(grp[1:])
        else:
            kept.extend(grp)
    return kept, merged_away


def sb(method, path, **kwargs):
    r = httpx.request(method, f"{SUPABASE_URL}/rest/v1{path}",
                      headers={**HEADERS, **kwargs.pop("headers", {})}, timeout=60, **kwargs)
    if r.is_error:
        print(f"  Supabase error: {r.text}", file=sys.stderr)
    r.raise_for_status()
    return r.json() if r.content else None


def artists():
    rows = sb("GET", "/tracked_artists", params={"active": "eq.true", "select": "spotify_artist_id,name"})
    if ONLY_ARTIST:
        rows = [a for a in rows if a["spotify_artist_id"] == ONLY_ARTIST]
    return rows


def track_names(artist_id):
    rows = sb("GET", "/artist_tracks", params={"artist_id": f"eq.{artist_id}", "select": "id,name"})
    return {r["id"]: r["name"] for r in rows}


def process(artist_id, name):
    print(f"\n=== {name} ({artist_id}) ===")
    id_to_name = track_names(artist_id)
    ref_ids = list(id_to_name.keys())
    if not ref_ids:
        print("  no artist_tracks; skipping")
        return

    params = {"artist_id": f"eq.{artist_id}", "order": "date.asc",
              "select": "date,total_streams,daily_delta,track_count"}
    if FROM_DATE:
        params["date"] = f"gte.{FROM_DATE}"
    days = sb("GET", "/artist_daily_stats", params=params)
    if not days:
        print("  no artist_daily_stats in range")
        return

    ref_list = ",".join(str(r) for r in ref_ids)
    prev_corrected = None  # corrected total of the previous processed day
    for row in days:
        d = row["date"]
        tds = sb("GET", "/track_daily_stats", params={
            "track_ref": f"in.({ref_list})", "date": f"eq.{d}", "select": "track_ref,streams",
        })
        counted = [{"name": id_to_name.get(t["track_ref"], str(t["track_ref"])), "streams": t["streams"]}
                   for t in tds if t["streams"] is not None]
        n_rows = len(counted)
        kept, merged_away = collapse_merged(counted)
        new_total = sum(k["streams"] for k in kept)
        new_count = len(kept)

        min_rows = max(MIN_ROWS_FLOOR, int(len(ref_ids) * MIN_ROWS_FRACTION))
        complete = n_rows >= min_rows
        drift = row["total_streams"] - new_total if new_total else 0
        flag = ""
        if not complete:
            flag = f"  (only {n_rows}/{len(ref_ids)} track rows — SKIP, left as-is)"
        elif merged_away:
            flag = f"  ⤷ {len(merged_away)} merged dup(s), −{drift:,}"

        new_delta = (new_total - prev_corrected) if (prev_corrected is not None and complete) else row.get("daily_delta")
        print(f"  {d}  stored total={row['total_streams']:,} (tracks={row.get('track_count')})"
              + (f"  ->  {new_total:,} (tracks={new_count}) delta={new_delta:,}" if complete and merged_away else "")
              + flag)

        if complete:
            if merged_away and APPLY:
                sb("PATCH", "/artist_daily_stats",
                   params={"artist_id": f"eq.{artist_id}", "date": f"eq.{d}"},
                   json={"total_streams": new_total, "track_count": new_count,
                         **({"daily_delta": new_delta} if new_delta is not None else {})})
            prev_corrected = new_total


def main():
    print(f"MODE: {'APPLY (writing)' if APPLY else 'DRY-RUN (no writes)'}"
          + (f"  ARTIST={ONLY_ARTIST}" if ONLY_ARTIST else "")
          + (f"  FROM={FROM_DATE}" if FROM_DATE else ""))
    for a in artists():
        process(a["spotify_artist_id"], a["name"])
    if not APPLY:
        print("\nDRY-RUN complete — no writes. Set APPLY=1 to apply the corrections above.")


if __name__ == "__main__":
    main()
