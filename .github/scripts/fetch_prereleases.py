"""Auto-detect Spotify pre-releases (upcoming EPs/singles) for BLACKPINK + members
and write data/prereleases-latest.json for the site's countdown section.

Spotify exposes an artist's upcoming release via the anonymous artist-overview
pathfinder query (variable includePrerelease=True) as artistUnion.preRelease:

    {"preReleaseContent": {"name","type","coverArt"}, "releaseDate": {"isoString"},
     "uri": "spotify:prerelease:<id>"}

That's the same data the open.spotify.com/prerelease/<id> countdown page shows
(name, cover, release date). There is NO public pre-save *count* anywhere in the
anonymous API — the pre-release page only shows a countdown — so we track the
countdown (= release date) and metadata, which is all that's exposed.

The site renders a simple auto countdown card for any pre-release found here that
isn't already covered by a hand-authored bespoke card (deduped by id/name in the
frontend). This is the safety net that means a fresh drop is never missed, the
same philosophy as the streams auto-discovery in fetch_artist_streams.py.

Fail-safe: if EVERY artist query fails (transient network), the existing JSON is
left untouched rather than wiped. A member legitimately having no pre-release just
drops out of the list (its card disappears once the EP is out).
"""
import json, os, sys, datetime
import requests
from spotify_scraper import SpotifyClient
from spotify_scraper.api import pathfinder

# Same artist IDs as fetch_artist_streams.py
ARTISTS = [
    ("BLACKPINK", "41MozSoPIsD1dJM0CLPjZF"),
    ("JISOO",     "6UZ0ba50XreR4TM8u322gs"),
    ("JENNIE",    "250b0Wlc5Vk0CoUsaCY84M"),
    ("ROSÉ",      "3eVa5w3URK5duf6eyVDbu9"),
    ("LISA",      "5L1lO4eRHmJ7a0Q6csE5cT"),
]

OUT_PATH = os.path.join("data", "prereleases-latest.json")


def find_token(root):
    """Walk the SpotifyClient object graph for an anonymous access token."""
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
    return walk(root)


def best_cover(cover):
    """Pick the largest coverArt source URL."""
    try:
        srcs = cover.get("sources") or []
        srcs = [s for s in srcs if s.get("url")]
        if not srcs:
            return None
        return max(srcs, key=lambda s: s.get("width") or 0)["url"]
    except Exception:
        return None


def prerelease_entry(member, artist_id, node):
    """Build one release dict from an artistUnion.preRelease node, or None."""
    if not isinstance(node, dict):
        return None
    content = node.get("preReleaseContent") or {}
    name = content.get("name")
    uri = node.get("uri") or ""
    if not name or "prerelease" not in uri:
        return None
    prerelease_id = uri.split(":")[-1]
    iso = (node.get("releaseDate") or {}).get("isoString")
    entry = {
        "member": member,
        "artistId": artist_id,
        "prereleaseId": prerelease_id,
        "name": name,
        "type": (content.get("type") or "").upper(),   # EP / SINGLE / ALBUM
        "cover": best_cover(content.get("coverArt") or {}),
        "releaseDate": iso,
        "spotifyUrl": f"https://open.spotify.com/prerelease/{prerelease_id}",
    }
    return entry


def main():
    client = SpotifyClient()
    token = find_token(client)
    if not token:
        print("ERROR: could not bootstrap anonymous token", file=sys.stderr)
        sys.exit(1)

    headers = {
        **pathfinder.auth_headers(token),
        "accept": "application/json",
        "app-platform": "WebPlayer",
        "user-agent": "Mozilla/5.0",
        "origin": "https://open.spotify.com",
        "referer": "https://open.spotify.com/",
    }

    releases = []
    ok = 0
    for member, artist_id in ARTISTS:
        try:
            url = pathfinder.build_url("artist", artist_id,
                                       variable_overrides={"includePrerelease": True})
            r = requests.get(url, headers=headers, timeout=30)
            if r.status_code != 200:
                print(f"  ⚠ {member}: HTTP {r.status_code}", file=sys.stderr)
                continue
            data = r.json()
            ok += 1
            node = (((data.get("data") or {}).get("artistUnion") or {}).get("preRelease"))
            entry = prerelease_entry(member, artist_id, node)
            if entry:
                print(f"  ✓ {member}: {entry['name']} ({entry['type']}) → {entry['releaseDate']}")
                releases.append(entry)
            else:
                print(f"  · {member}: no pre-release")
        except Exception as e:
            print(f"  ⚠ {member}: {e}", file=sys.stderr)

    if ok == 0:
        print("ERROR: every artist query failed — leaving existing JSON untouched",
              file=sys.stderr)
        sys.exit(1)

    # Dedupe by prerelease id, soonest release first.
    seen = set()
    deduped = []
    for e in sorted(releases, key=lambda x: x.get("releaseDate") or "9999"):
        if e["prereleaseId"] in seen:
            continue
        seen.add(e["prereleaseId"])
        deduped.append(e)

    out = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc)
                              .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "releases": deduped,
    }
    os.makedirs("data", exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"Wrote {OUT_PATH}: {len(deduped)} pre-release(s) from {ok}/{len(ARTISTS)} artists")


if __name__ == "__main__":
    main()
