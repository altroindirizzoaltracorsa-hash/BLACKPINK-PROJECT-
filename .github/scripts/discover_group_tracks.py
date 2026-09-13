"""Read-only: list a girl group's tracks in the live Spotify discography that are
NOT in our pinned catalog (data/group_catalogs/<id>.json) — i.e. comeback / new
tracks we'd need to add so the daily-log total keeps matching kworb. Prints
release date, album, id, name + play_count (so we can see the one-time step-up),
and writes group_new_tracks.json for an easy catalog merge. Writes nothing to the
catalog itself."""
import json, os, re, sys
from spotify_scraper import SpotifyClient

ARTIST = os.environ.get("ARTIST_ID", "4SpbR6yFEvexJuaBpgAU5p")  # LE SSERAFIM default
CATALOG = f"data/group_catalogs/{ARTIST}.json"
MAX_RELEASES = int(os.environ.get("MAX_RELEASES", "20"))

def norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())

cat = json.load(open(CATALOG))
known_ids = {t["id"] for t in cat["tracks"]}
known_names = {norm(t["name"]) for t in cat["tracks"]}
print(f"catalog: {cat['name']} — {len(known_ids)} tracks (seeded {cat.get('seeded_kworb_day')})")

client = SpotifyClient()
try:
    releases = client.get_discography(ARTIST, max_releases=MAX_RELEASES)
except Exception as e:
    print("discography fetch failed:", e, file=sys.stderr)
    sys.exit(1)

candidates = []  # (rd_s, album, tid, name, credited)
seen = set()
for rel in releases:
    aid = getattr(rel, "id", None)
    if not aid:
        continue
    try:
        album = client.get_album(aid)
    except Exception as e:
        print("album fetch failed", aid, e, file=sys.stderr)
        continue
    rd = getattr(album, "release_date", None)
    rd_s = rd.date().isoformat() if hasattr(rd, "date") else (str(rd) if rd else "?")
    alb_name = getattr(album, "name", "?")
    for t in (album.tracks or []):
        tid = getattr(t, "id", None)
        if not tid or tid in seen:
            continue
        seen.add(tid)
        name = getattr(t, "name", "")
        if tid in known_ids or norm(name) in known_names:
            continue  # already tracked (by id or title)
        aids = [a.id for a in (t.artists or []) if getattr(a, "id", None)]
        credited = (not aids) or (ARTIST in aids)  # is the group a credited artist?
        candidates.append((rd_s, alb_name, tid, name, credited))

# Play counts for the candidates (to size the step-up).
ids = [c[2] for c in candidates]
counts = {}
for i in range(0, len(ids), 50):
    chunk = ids[i:i + 50]
    try:
        for tid, item in zip(chunk, client.get_tracks(chunk)):
            if item.ok and item.result.play_count is not None:
                counts[tid] = item.result.play_count
    except Exception as e:
        print("playcount batch failed", e, file=sys.stderr)

print(f"\n=== {len(candidates)} track(s) in the discography NOT in the catalog (newest first) ===")
total_new = 0
for rd_s, alb, tid, name, credited in sorted(candidates, reverse=True):
    pc = counts.get(tid)
    if credited and isinstance(pc, int):
        total_new += pc
    pcs = f"{pc:,}" if isinstance(pc, int) else "?"
    print(f"  {rd_s}  {name[:38]:38}  plays={pcs:>13}  credited={credited}  album={alb[:28]!r}  id={tid}")
print(f"\nIf every CREDITED candidate were added, one-time step-up ≈ +{total_new:,} streams")

out = [{"id": tid, "name": name, "feature": (not credited),
        "release_date": rd_s, "album": alb, "plays": counts.get(tid)}
       for rd_s, alb, tid, name, credited in sorted(candidates, reverse=True)]
json.dump(out, open("group_new_tracks.json", "w"), ensure_ascii=False, indent=2)
print(f"\nwrote group_new_tracks.json ({len(out)} candidates)")
