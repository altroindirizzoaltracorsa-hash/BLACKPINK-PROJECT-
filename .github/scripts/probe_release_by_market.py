"""Is PRESS PLAY out yet in the countries where it is ALREADY the 23rd?

This settles "one global instant vs midnight local time" by observation rather
than by reading a field, and it can only be run in the hours before the drop —
which is exactly now.

The release day is 2026-10-23. Midnight has already passed in the far side of
the date line (Kiritimati +14, New Zealand +13, Fiji +12) while the Americas are
still on the 22nd. So:

  * midnight local  → the EP is ON Spotify in NZ right now, and not in the US;
  * one instant     → it is nowhere until 2026-10-23T04:00:00Z, and NZ looks
                      exactly like the US.

One query per market, asking what that market can see. Read-only.

A market that has NOT yet passed midnight tells us nothing either way, so it is
reported but never counted as evidence — the whole question is what the markets
PAST midnight can see.
"""
import datetime
import json
import os
import sys
from zoneinfo import ZoneInfo

import requests
from spotify_scraper import SpotifyClient
from spotify_scraper.api import pathfinder

LISA = "5L1lO4eRHmJ7a0Q6csE5cT"
TITLE = "press play"
RELEASE_DAY = datetime.date(2026, 10, 23)
GLOBAL_INSTANT = "2026-10-23T04:00:00Z"

# Spread across the date line, from furthest ahead to furthest behind.
MARKETS = [
    ("KI", "Pacific/Kiritimati", "Kiribati"),
    ("NZ", "Pacific/Auckland", "New Zealand"),
    ("FJ", "Pacific/Fiji", "Fiji"),
    ("AU", "Australia/Sydney", "Australia"),
    ("JP", "Asia/Tokyo", "Japan"),
    ("KR", "Asia/Seoul", "Korea"),
    ("TH", "Asia/Bangkok", "Thailand"),
    ("GB", "Europe/London", "UK"),
    ("US", "America/New_York", "US East"),
]

notices = []
verdict = []


def note(m):
    print(m)
    notices.append(m)


def decisive(m):
    note(m)
    verdict.append(m)


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


now = datetime.datetime.now(datetime.timezone.utc)
decisive(f"asked at {now.strftime('%Y-%m-%dT%H:%M:%SZ')}; "
         f"the global instant on the card is {GLOBAL_INSTANT}")

client = SpotifyClient()
token = find_token(client)
if not token:
    decisive("ERROR: no anonymous Spotify token — nothing could be asked")
    sys.exit(1)

headers = {
    "authorization": f"Bearer {token}",
    "accept": "application/json",
    "app-platform": "WebPlayer",
    "user-agent": "Mozilla/5.0",
    "origin": "https://open.spotify.com",
    "referer": "https://open.spotify.com/",
}

past_midnight_seen = []
past_midnight_unseen = []
raw = {}

for code, tz, label in MARKETS:
    local = now.astimezone(ZoneInfo(tz))
    past = local.date() >= RELEASE_DAY
    found, detail = None, ""
    try:
        r = requests.get(
            f"https://api.spotify.com/v1/artists/{LISA}/albums",
            params={"market": code, "limit": 50, "include_groups": "album,single"},
            headers=headers, timeout=30)
        if r.status_code != 200:
            detail = f"HTTP {r.status_code}"
        else:
            items = (r.json() or {}).get("items") or []
            raw[code] = [{"name": i.get("name"), "release_date": i.get("release_date"),
                          "id": i.get("id")} for i in items]
            hits = [i for i in items if TITLE in (i.get("name") or "").lower()]
            found = bool(hits)
            if hits:
                detail = ", ".join(f"{h.get('name')} ({h.get('release_date')})" for h in hits)
            else:
                detail = f"{len(items)} releases, none called PRESS PLAY"
    except Exception as e:
        detail = f"failed: {e}"

    mark = "PAST midnight" if past else "not yet midnight"
    note(f"{label} ({code}) — local {local.strftime('%a %d %H:%M')}, {mark} — "
         f"{'OUT' if found else 'not out' if found is False else '?'} — {detail}")
    if past and found is True:
        past_midnight_seen.append(label)
    elif past and found is False:
        past_midnight_unseen.append(label)

with open("albums_by_market.json", "w") as f:
    json.dump(raw, f, indent=2)

decisive("--- verdict ---")
if past_midnight_seen:
    decisive(f"OUT already in: {', '.join(past_midnight_seen)} — these are past their "
             f"own midnight and can see it, so the EP arrives at MIDNIGHT LOCAL and a "
             f"single countdown is wrong for everyone outside US Eastern.")
elif past_midnight_unseen:
    decisive(f"NOT out in {', '.join(past_midnight_unseen)}, and it is already the 23rd "
             f"there. Midnight local would have delivered it; it did not, so the EP "
             f"lands at ONE instant worldwide and the card's countdown is right.")
else:
    decisive("INCONCLUSIVE: no market has passed its own midnight yet (or every query "
             "failed), so nothing here separates the two. Run it again later.")

with open(os.environ.get("GITHUB_STEP_SUMMARY", os.devnull), "a") as f:
    f.write("```\n" + "\n".join(notices) + "\n```\n")

blob = "%0A".join(l.replace("%", "%25").replace("\r", "") for l in verdict)
print(f"::notice title=by-market::{blob[:60000]}")
