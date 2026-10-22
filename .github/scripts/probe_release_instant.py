"""Does PRESS PLAY drop at ONE instant worldwide, or at midnight wherever you are?

The countdown card counts to a single instant, 2026-10-23T04:00:00Z, which is
what fetch_prereleases.py read off Spotify's pre-release node. But 04:00Z is
also exactly midnight US Eastern — and GitHub's runners live in US East. So the
number we have is consistent with BOTH stories, and the one that is true decides
whether the card can keep a single countdown at all:

  * one global instant  → every fan sees the same clock, today's card is right;
  * midnight local      → Seoul gets it 13 hours before Los Angeles and a single
                          countdown is wrong for nearly everyone.

This asks Spotify and prints what it says. Read-only. Three things settle it:

  1. WHERE THIS RUNNER IS. If the runner is not in US Eastern and Spotify still
     says 04:00Z, the instant does not follow the caller, and it is global. If
     the runner IS US Eastern, this run cannot tell the two apart and says so
     rather than guessing.
  2. THE PRECISION Spotify attaches to the date. A release pinned to a moment
     carries an hour/minute/second precision; one that is merely dated carries
     DAY, and a client showing a countdown for a DAY-precision release has
     nothing to count to but the viewer's own midnight.
  3. WHAT THE PRE-RELEASE PAGE ITSELF COUNTS TO — the page open.spotify.com
     shows fans, with every timestamp in it printed.

Every field of the node is dumped rather than the one we already parse: the
answer may well be in a field this repo has never looked at.
"""
import json
import os
import re
import sys
import datetime

import requests
from spotify_scraper import SpotifyClient
from spotify_scraper.api import pathfinder

LISA = "5L1lO4eRHmJ7a0Q6csE5cT"
PRERELEASE_ID = "5jAv4CUEptHKQj6HSTMosH"
STORED = "2026-10-23T04:00:00Z"   # what the card counts to today

notices = []


def note(msg):
    """Job logs are served from blob storage this session cannot read, so every
    line worth having comes back as an annotation."""
    print(msg)
    notices.append(msg)


def find_token(root):
    seen = set()

    def walk(o, d=0):
        if o is None or d > 4 or id(o) in seen:
            return None
        seen.add(id(o))
        t = getattr(o, "token", None)
        if callable(t):
            try:
                v = t()
                if isinstance(v, str) and len(v) > 20:
                    return v
            except Exception:
                pass
        kids = list(getattr(o, "__dict__", {}).values())
        for s in getattr(o, "__slots__", []):
            try:
                kids.append(getattr(o, s))
            except Exception:
                pass
        for k in kids:
            r = walk(k, d + 1)
            if r:
                return r
        return None

    return walk(root)


# ── 1. where this runner is ────────────────────────────────────────────────
runner_offset = None
runner_tz = None
try:
    g = requests.get("https://ipinfo.io/json", timeout=20).json()
    runner_tz = g.get("timezone")
    note(f"runner: {g.get('city')}, {g.get('region')}, {g.get('country')} — tz {runner_tz}")
    if runner_tz:
        try:
            from zoneinfo import ZoneInfo
            drop_day = datetime.datetime(2026, 10, 23, tzinfo=ZoneInfo(runner_tz))
            runner_offset = drop_day.utcoffset()
            local_midnight = drop_day.astimezone(datetime.timezone.utc)
            note(f"runner's own midnight on release day = "
                 f"{local_midnight.strftime('%Y-%m-%dT%H:%M:%SZ')}")
        except Exception as e:
            note(f"runner: could not resolve its timezone ({e})")
except Exception as e:
    note(f"runner: could not locate it ({e})")

# ── 2. the pre-release node, every field of it ─────────────────────────────
client = SpotifyClient()
token = find_token(client)
if not token:
    note("ERROR: no anonymous Spotify token; nothing below could be asked")
    sys.exit(1)

headers = {
    **pathfinder.auth_headers(token),
    "accept": "application/json",
    "app-platform": "WebPlayer",
    "user-agent": "Mozilla/5.0",
    "origin": "https://open.spotify.com",
    "referer": "https://open.spotify.com/",
}

node = None
try:
    url = pathfinder.build_url("artist", LISA, variable_overrides={"includePrerelease": True})
    r = requests.get(url, headers=headers, timeout=30)
    note(f"artist-overview: HTTP {r.status_code}")
    if r.status_code == 200:
        data = r.json()
        with open("artist_overview.json", "w") as f:
            json.dump(data, f, indent=2)
        node = ((data.get("data") or {}).get("artistUnion") or {}).get("preRelease")
except Exception as e:
    note(f"artist-overview failed: {e}")

if node:
    with open("prerelease_node.json", "w") as f:
        json.dump(node, f, indent=2)
    note("--- the whole preRelease node ---")
    for line in json.dumps(node, indent=2).splitlines():
        note("  " + line)
    rd = node.get("releaseDate") or {}
    iso = rd.get("isoString")
    prec = rd.get("precision") or rd.get("__typename") or "(no precision field)"
    note(f"releaseDate.isoString = {iso}")
    note(f"releaseDate.precision = {prec}")
else:
    note("no preRelease node came back for LISA (it may be out already)")

# ── 3. the page fans actually see ──────────────────────────────────────────
try:
    pr = requests.get(f"https://open.spotify.com/prerelease/{PRERELEASE_ID}",
                      headers={"user-agent": "Mozilla/5.0",
                               "accept-language": "en-US,en;q=0.9"}, timeout=30)
    note(f"prerelease page: HTTP {pr.status_code}, {len(pr.text)} bytes")
    with open("prerelease_page.html", "w") as f:
        f.write(pr.text)
    stamps = sorted(set(re.findall(r"\d{4}-\d{2}-\d{2}T[\d:.]+Z?", pr.text)))
    note(f"every timestamp on that page: {stamps if stamps else '(none)'}")
    for word in ("precision", "releaseDate", "timezone", "localRelease", "midnight"):
        hits = len(re.findall(word, pr.text, re.I))
        if hits:
            note(f"  page mentions {word!r} {hits}x")
except Exception as e:
    note(f"prerelease page failed: {e}")

# ── 4. what that adds up to ────────────────────────────────────────────────
note("--- verdict ---")
iso = ((node or {}).get("releaseDate") or {}).get("isoString")
if not iso:
    note("INCONCLUSIVE: Spotify returned no release instant to reason about.")
elif runner_tz is None:
    note(f"Spotify says {iso}, but this runner's own timezone is unknown, so it "
         f"cannot be told apart from the caller's local midnight.")
else:
    parsed = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    # Is the instant Spotify gave us this runner's own local midnight?
    try:
        from zoneinfo import ZoneInfo
        here = parsed.astimezone(ZoneInfo(runner_tz))
        note(f"that instant, in the runner's own timezone, is {here.strftime('%Y-%m-%d %H:%M')}")
        if (here.hour, here.minute) == (0, 0):
            note("IT IS THIS RUNNER'S LOCAL MIDNIGHT — consistent with a midnight-local "
                 "release, and also with a global instant that happens to land there. "
                 "Not decisive on its own; see whether the runner sits in US Eastern.")
        else:
            note("NOT this runner's local midnight. The instant does not follow the "
                 "caller, so it is a single global moment and the card's countdown "
                 "is right for everyone.")
    except Exception as e:
        note(f"could not re-express the instant locally ({e})")
    if iso != STORED:
        note(f"NOTE: Spotify has MOVED it — card counts to {STORED}, Spotify now says {iso}")
    else:
        note(f"unchanged from what the card counts to ({STORED})")

with open(os.environ.get("GITHUB_STEP_SUMMARY", os.devnull), "a") as f:
    f.write("```\n" + "\n".join(notices) + "\n```\n")
for line in notices:
    safe = line.replace("%", "%25").replace("\r", "").replace("\n", "%0A")
    print(f"::notice title=release-instant::{safe}")
