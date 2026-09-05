"""Read-only diagnostic: dump JISOO/LISA artist_daily_stats around the Sep 3-4
window plus the CLICK / SaWaDiKa per-track rows, so we can see exactly how the
new releases landed on the Sep 3 snapshot before correcting it. Writes nothing."""
import os, json, urllib.request, urllib.parse

BASE = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1"
KEY  = os.environ["SUPABASE_SERVICE_KEY"]

def sb(path, params):
    url = BASE + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {KEY}", "apikey": KEY})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

arts = sb("/tracked_artists", {"select": "spotify_artist_id,name"})
byname = {a["name"].upper(): a["spotify_artist_id"] for a in arts}
print("tracked artists:", byname)

for name, tname in [("JISOO", "click"), ("LISA", "sawadika")]:
    aid = byname.get(name)
    print(f"\n================ {name}  ({aid}) ================")
    ads = sb("/artist_daily_stats", {
        "artist_id": f"eq.{aid}", "date": "gte.2026-08-30",
        "order": "date.desc", "select": "date,total_streams,daily_delta,track_count", "limit": "10",
    })
    print("artist_daily_stats (Aug 30 →):")
    for r in ads:
        print(f"   {r['date']}  total={r['total_streams']:>15,}  delta={str(r['daily_delta']):>14}  tracks={r['track_count']}")

    trks = sb("/artist_tracks", {"artist_id": f"eq.{aid}", "select": "id,name,album_release_date"})
    norm = lambda s: "".join(c for c in (s or "").lower() if c.isalnum())
    match = [t for t in trks if norm(tname) in norm(t["name"])]
    print(f"artist_tracks matching {tname!r}: {[t['name'] for t in match]}")
    for t in match:
        print(f"   id={t['id']}  name={t['name']!r}  album_release_date={t.get('album_release_date')}")
        tds = sb("/track_daily_stats", {
            "track_ref": f"eq.{t['id']}", "order": "date.desc",
            "select": "date,streams,daily_delta", "limit": "8",
        })
        for r in tds:
            print(f"      {r['date']}  streams={r['streams']:>13,}  delta={r['daily_delta']}")
    print(f"   (total tracked tracks for {name}: {len(trks)})")
