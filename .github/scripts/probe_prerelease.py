"""Read-only prototype: can we read Spotify pre-release (upcoming) data — the
pre-save count / countdown shown on open.spotify.com/upcoming-releases — via the
anonymous pathfinder API our play-count scraper already uses?

Strategy: bootstrap an anonymous token with spotifyscraper, then call
queryArtistOverview with includePrerelease=True for LISA and a search for
"PRESS PLAY", and dump any prerelease / pre-save / countdown fields. Writes
nothing to Spotify; just prints what comes back.
"""
import json, re, sys, requests
from spotify_scraper import SpotifyClient
from spotify_scraper.api import pathfinder

LISA = "5L1lO4eRHmJ7a0Q6csE5cT"

client = SpotifyClient()

def find_token(root):
    seen = set()
    def walk(o, depth=0):
        if o is None or depth > 4 or id(o) in seen:
            return None
        seen.add(id(o))
        tok = getattr(o, "token", None)
        if callable(tok):
            try:
                t = tok()
                if isinstance(t, str) and len(t) > 20:
                    return t
            except Exception:
                pass
        children = list(getattr(o, "__dict__", {}).values())
        for s in getattr(o, "__slots__", []):
            try: children.append(getattr(o, s))
            except Exception: pass
        for ch in children:
            r = walk(ch, depth + 1)
            if r:
                return r
        return None
    return walk(root)

token = find_token(client)
print("token acquired:", bool(token))
if not token:
    print("FAILED to get anonymous token — cannot probe.")
    sys.exit(0)

def raw(url):
    h = {
        **pathfinder.auth_headers(token),
        "accept": "application/json",
        "app-platform": "WebPlayer",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "origin": "https://open.spotify.com",
        "referer": "https://open.spotify.com/",
    }
    r = requests.get(url, headers=h, timeout=30)
    return r.status_code, r.text

def scan(label, body):
    print(f"\n===== {label} (len={len(body)}) =====")
    try:
        j = json.loads(body)
    except Exception as e:
        print("  not JSON:", str(e)[:120], "| head:", body[:200])
        return
    s = json.dumps(j)
    # 1) any key mentioning prerelease / presave / countdown / reveal
    keys = sorted(set(re.findall(r'"([a-zA-Z_]*(?:[Pp]re[Rr]elease|[Pp]re[Ss]ave|[Cc]ountdown|[Rr]eveal|preSave|presave)[a-zA-Z_]*)"', s)))
    print("  matching keys:", keys or "(none)")
    # 2) snippets of interest
    low = s.lower()
    for kw in ["prerelease", "presavecount", "pre_save", "countdown", "reveal", "earliestreleasedate", "releasedate"]:
        i = low.find(kw)
        if i >= 0:
            print(f"  [{kw}] …{s[max(0,i-60):i+200]}…")
    # 3) any large integer that could be a pre-save count near a prerelease node
    if "prerelease" in low:
        i = low.find("prerelease")
        print("  prerelease context:", s[max(0,i-40):i+500])

# 1) Artist overview with prerelease flag on
try:
    url = pathfinder.build_url("artist", LISA, variable_overrides={"includePrerelease": True})
    sc, body = raw(url)
    print("ARTIST OVERVIEW http:", sc)
    scan("queryArtistOverview includePrerelease=True (LISA)", body)
    open("artist_overview.json", "w").write(body)
except Exception as e:
    print("artist overview error:", type(e).__name__, str(e)[:200])

# 2) Search for the release name
try:
    surl = pathfinder.build_search_url("PRESS PLAY LISA")
    sc2, body2 = raw(surl)
    print("\nSEARCH http:", sc2)
    scan("searchDesktop 'PRESS PLAY LISA'", body2)
    open("search.json", "w").write(body2)
except Exception as e:
    print("search error:", type(e).__name__, str(e)[:200])
