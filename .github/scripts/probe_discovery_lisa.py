"""
Read-only probe. Writes nothing, to Supabase or anywhere else.

Answers two questions that reading the code cannot settle:

1. What does PostgREST actually return for /tracked_artists? The discovery
   preview lists no artists while the nightly fetch, making the same call with
   the same secrets, processes five. One of those two readings is wrong and the
   raw status + body says which. The key is never printed.

2. Would auto-discovery pick up LISA's PRESS PLAY tracks? Answered by running
   the real scan_recent_tracks against her live discography and classifying
   each result exactly as process_artist would, rather than by inferring it
   from the release date.
"""

import os
import sys

import httpx
from spotify_scraper import SpotifyClient

import fetch_artist_streams as F

LISA = "5L1lO4eRHmJ7a0Q6csE5cT"

lines = []


def say(line):
    lines.append(line)
    print(line)


def raw_tracked_artists():
    """The same request the preview and the nightly fetch both make, with the
    status and body shown instead of parsed away."""
    url = f"{os.environ['SUPABASE_URL']}/rest/v1/tracked_artists"
    key = os.environ["SUPABASE_SERVICE_KEY"]
    for label, params in (
        ("active=eq.true&select=spotify_artist_id,name",
         {"active": "eq.true", "select": "spotify_artist_id,name"}),
        ("select=* (no filter)", {"select": "*"}),
    ):
        try:
            r = httpx.get(url, params=params,
                          headers={"Authorization": f"Bearer {key}", "apikey": key},
                          timeout=30)
        except Exception as e:
            say(f"PostgREST [{label}]: request failed: {type(e).__name__}: {e}")
            continue
        body = r.text
        say(f"PostgREST [{label}]: HTTP {r.status_code}, {len(body)} bytes")
        # The body carries artist ids and names, which are public, and no
        # credential: the key travels in the request headers, never the reply.
        say(f"  body: {body[:1200]}")


def discovery_for_lisa(within):
    known_ids, known_names = set(), set()
    for name, tid in F.FIXED_TRACKS.get(LISA, []):
        known_ids.add(tid)
        known_names.add(F._norm_track_name(name))
    try:
        rows = F.sb("GET", "/artist_tracks", params={
            "artist_id": f"eq.{LISA}", "select": "name,source_track_ids"}) or []
    except Exception as e:
        say(f"artist_tracks read failed: {type(e).__name__}: {e}")
        rows = []
    for r in rows:
        known_names.add(F._norm_track_name(r.get("name")))
        for s in (r.get("source_track_ids") or []):
            known_ids.add(s)
    say(f"LISA known: {len(known_ids)} ids, {len(known_names)} names "
        f"({len(rows)} persisted artist_tracks rows)")

    with SpotifyClient() as client:
        recent = list(F.scan_recent_tracks(client, LISA, within_days=within))
    say(f"scan_recent_tracks({within}d): {len(recent)} tracks in window")
    new = 0
    for n, tid, rd in recent:
        if tid in known_ids:
            label = "already in catalogue"
        elif F._norm_track_name(n) in known_names:
            label = "reissue under new ID — not re-counted"
        else:
            label = "NEW — discovery would add"
            new += 1
        say(f"  [{label}] {n!r} [{tid}] released {rd}")
    say(f"-> {new} new to add for LISA")


def report():
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as f:
            f.write("```\n" + "\n".join(lines) + "\n```\n")
    blob = "%0A".join(l.replace("%", "%25").replace("\r", "") for l in lines)
    print(f"::notice title=discovery-probe::{blob[:60000]}")


if __name__ == "__main__":
    within = int(os.environ.get("WITHIN_DAYS") or "75")
    try:
        raw_tracked_artists()
        discovery_for_lisa(within)
    except Exception as e:
        say(f"PROBE FAILED: {type(e).__name__}: {e}")
        report()
        sys.exit(1)
    report()
