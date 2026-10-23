"""
Read-only preview of auto-discovery: for each tracked artist, list the recent
releases discover_new_tracks() would ADD (tracks credited to the member, dated
within the window, not already in FIXED_TRACKS or artist_tracks). Writes nothing.

Run this after a new drop (e.g. SaWaDiKa / CLICK) to confirm it's caught, or any
time to confirm discovery isn't about to add anything unexpected.
WITHIN_DAYS env overrides the recency window (default 75).
"""

import os
import sys

from spotify_scraper import SpotifyClient

import fetch_artist_streams as F


def known_for(artist_id):
    ids = {tid for _, tid in F.FIXED_TRACKS.get(artist_id, [])}
    names = {F._norm_track_name(n) for n, _ in F.FIXED_TRACKS.get(artist_id, [])}
    rows = F.sb("GET", "/artist_tracks", params={
        "artist_id": f"eq.{artist_id}", "select": "name,source_track_ids",
    }) or []
    for r in rows:
        names.add(F._norm_track_name(r.get("name")))
        for s in (r.get("source_track_ids") or []):
            ids.add(s)
    return ids, names


def main():
    within = int(os.environ.get("WITHIN_DAYS", "75"))
    artists = F.sb("GET", "/tracked_artists",
                   params={"active": "eq.true", "select": "spotify_artist_id,name"})
    print(f"Recency window: last {within} days\n")
    with SpotifyClient() as client:
        for a in artists:
            aid, name = a["spotify_artist_id"], a["name"]
            known_ids, known_names = known_for(aid)
            recent = list(F.scan_recent_tracks(client, aid, within_days=within))
            new_count = 0
            print(f"=== {name} ({aid}) — already tracking {len(known_ids)} ===")
            if not recent:
                print("   (no releases in window)")
            for n, tid, rd in recent:
                if tid in known_ids:
                    label = "already in catalogue"
                elif F._norm_track_name(n) in known_names:
                    label = "already in catalogue (reissue under new ID — not re-counted)"
                else:
                    label = "🆕 NEW — will be added"
                    new_count += 1
                print(f"   [{label}]  {n!r}  [{tid}]  released {rd}")
            print(f"   → {new_count} new to add\n")


def _report(lines):
    """Hand the preview back where it can actually be read.

    The job log is served from blob storage a Claude Code session cannot
    fetch, so a run that only prints is a run whose answer never arrives.
    Everything goes to the step summary, and the lines that decide the
    question — the new tracks, and the per-artist totals — come back as one
    annotation."""
    import os
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as f:
            f.write("```\n" + "\n".join(lines) + "\n```\n")
    keep = [l for l in lines
            if "NEW" in l or l.startswith("===") or "new to add" in l
            or "no releases in window" in l or l.startswith("Recency window")]
    # A literal newline ENDS a workflow command: everything after it becomes
    # ordinary log output, which on this repo means it is gone, since the log
    # is served from blob storage a Claude Code session cannot fetch. The very
    # first kept line here ends in \n, so the annotation was one line long and
    # read exactly like "discovery found no artists" — which is how the
    # auto-discovery of a release night came to look broken when it was not.
    # %0A is the only line break a command carries; 4096 is the message cap.
    blob = "%0A".join(
        l.replace("%", "%25").replace("\r", "").replace("\n", " ")
        for l in keep)
    print(f"::notice title=discovery::{blob[:3500]}")


if __name__ == "__main__":
    import builtins, io
    _lines = []
    _print = builtins.print
    builtins.print = lambda *a, **k: (_lines.append(" ".join(str(x) for x in a)), _print(*a, **k))[1]
    try:
        main()
    finally:
        builtins.print = _print
        _report(_lines)
