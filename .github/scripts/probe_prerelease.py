"""Read-only prototype v2: pull LISA's PRESS PLAY pre-release node and print its
fields, to see if a pre-save count / countdown / reveal date is exposed."""
import json, re, sys, requests
from spotify_scraper import SpotifyClient
from spotify_scraper.api import pathfinder

LISA = "5L1lO4eRHmJ7a0Q6csE5cT"
client = SpotifyClient()

def find_token(root):
    seen=set()
    def walk(o,d=0):
        if o is None or d>4 or id(o) in seen: return None
        seen.add(id(o))
        t=getattr(o,"token",None)
        if callable(t):
            try:
                v=t()
                if isinstance(v,str) and len(v)>20: return v
            except Exception: pass
        kids=list(getattr(o,"__dict__",{}).values())
        for s in getattr(o,"__slots__",[]):
            try: kids.append(getattr(o,s))
            except Exception: pass
        for k in kids:
            r=walk(k,d+1)
            if r: return r
    return walk(root)

token=find_token(client)
print("token:", bool(token))

def raw(url):
    h={**pathfinder.auth_headers(token),"accept":"application/json","app-platform":"WebPlayer",
       "user-agent":"Mozilla/5.0","origin":"https://open.spotify.com","referer":"https://open.spotify.com/"}
    r=requests.get(url,headers=h,timeout=30); return r.status_code,r.text

# Recursively find dicts that look like a pre-release
def find_prereleases(obj, path=""):
    hits=[]
    if isinstance(obj,dict):
        tn=str(obj.get("__typename",""))
        if "rerelease" in tn.lower() or ("preSave" in json.dumps(obj)[:0]):
            hits.append((path,obj))
        # also detect by presence of tell-tale keys
        keyset=set(obj.keys())
        if any("presave" in k.lower() or "prerelease" in k.lower() or k in ("earliestReleaseDate","revealDate") for k in keyset):
            hits.append((path,obj))
        for k,v in obj.items():
            hits+=find_prereleases(v,path+"."+k)
    elif isinstance(obj,list):
        for i,v in enumerate(obj):
            hits+=find_prereleases(v,f"{path}[{i}]")
    return hits

def summarize(label, body):
    print(f"\n===== {label} =====")
    try: j=json.loads(body)
    except Exception as e: print("not json:",e, body[:150]); return
    hits=find_prereleases(j)
    print("prerelease-ish nodes found:", len(hits))
    seen_types=set()
    for path,node in hits[:8]:
        tn=node.get("__typename","?")
        print(f"\n  @ {path}  __typename={tn}")
        print("  keys:", sorted(node.keys()))
        # print any field whose name or value hints at a count/date
        for k,v in node.items():
            kl=k.lower()
            if any(w in kl for w in ("save","count","date","reveal","reserve","preorder","type")) and not isinstance(v,(dict,list)):
                print(f"    {k} = {v!r}")
        # dump small nodes fully
        s=json.dumps(node)
        if len(s)<1200: print("  full:", s)

# search for the specific release
sc,body=raw(pathfinder.build_search_url("LISA PRESS PLAY"))
print("search http:",sc)
summarize("SEARCH 'LISA PRESS PLAY'", body)

# artist overview with prerelease flag
sc2,body2=raw(pathfinder.build_url("artist",LISA,variable_overrides={"includePrerelease":True}))
print("\nartist overview http:",sc2)
summarize("ARTIST OVERVIEW includePrerelease=True", body2)
# Also: does discography expose it?
sc3,body3=raw(pathfinder.build_url("artist_discography",LISA))
print("\ndiscography http:",sc3)
summarize("DISCOGRAPHY", body3)

# ---- NEW: fetch the pre-release PAGE HTML and scan its embedded state ----
# Spotify web-player pages server-render an embedded config / initial-state blob
# that frequently carries the pre-save count + release/reveal date. If it's there
# we can read it straight off the HTML with no persisted-hash needed.
PRERELEASE_ID = "5jAv4CUEptHKQj6HSTMosH"
PAGE_HEADERS = {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
}

def scan_html(label, html):
    print(f"\n===== {label} (len={len(html)}) =====")
    # tell-tale words
    for w in ("preSave","presave","pre-save","reveal","releaseDate","earliestReleaseDate",
              "reservationCount","preSaveCount","countdown","PRESS PLAY"):
        idx=html.lower().find(w.lower())
        if idx>=0:
            print(f"  found {w!r} @ {idx}: ...{html[max(0,idx-60):idx+120]!r}...")
    # embedded JSON script blocks
    for m in re.finditer(r'<script[^>]*id="([^"]+)"[^>]*>(.*?)</script>', html, re.S):
        sid, blob = m.group(1), m.group(2).strip()
        if len(blob)>40 and (blob[0] in "{[" or "json" in sid.lower() or "state" in sid.lower()):
            print(f"\n  <script id={sid!r}> len={len(blob)}")
            try:
                j=json.loads(blob)
                hits=find_prereleases(j)
                print("    prerelease-ish nodes:", len(hits))
                for path,node in hits[:6]:
                    print("     @",path,"keys:",sorted(node.keys())[:20])
                    for k,v in node.items():
                        if not isinstance(v,(dict,list)) and any(x in k.lower() for x in ("save","count","date","reveal")):
                            print("        ",k,"=",repr(v))
            except Exception as e:
                print("    (not clean json:",e,") snippet:",blob[:200])

for url in (f"https://open.spotify.com/prerelease/{PRERELEASE_ID}",
            f"https://open.spotify.com/prerelease/{PRERELEASE_ID}?si=1"):
    try:
        r=requests.get(url,headers=PAGE_HEADERS,timeout=30,allow_redirects=True)
        print(f"\nPAGE {url} -> http {r.status_code}  final={r.url}")
        with open("prerelease_page.html","w") as f: f.write(r.text)
        scan_html("PRERELEASE PAGE HTML", r.text)
        break
    except Exception as e:
        print("page fetch failed:",e)
