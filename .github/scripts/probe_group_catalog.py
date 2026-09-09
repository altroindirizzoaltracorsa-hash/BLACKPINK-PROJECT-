"""Read-only: can we compute a girl group's Spotify catalog total ourselves,
without kworb?

Walks an artist's FULL discography (no recency cap — unlike discover_new_tracks,
which deliberately caps at 75 days because the established back-catalog is pinned
in FIXED_TRACKS), collects every track the artist is credited on, fetches each
play_count, and sums. Prints the total next to kworb's so the two scopes can be
compared.

Writes NOTHING. No Supabase, no Redis, no commits. Its only job is to answer
whether a self-built catalog lands close enough to kworb to replace it.
"""

import os
import re
import sys
import unicodedata

import httpx
from spotify_scraper import SpotifyClient

GROUPS = [
    ("BLACKPINK",   "41MozSoPIsD1dJM0CLPjZF"),
    ("TWICE",       "7n2Ycct7Beij7Dj7meI4X0"),
    ("NewJeans",    "6HvZYsbFfjnjFrWF950C9d"),
    ("LE SSERAFIM", "4SpbR6yFEvexJuaBpgAU5p"),
    ("aespa",       "6YVMFz59CuY7ngCxTxjpxE"),
    ("ILLIT",       "36cgvBn0aadzOijnjjwqMN"),
    ("BABYMONSTER", "1SIocsqdEefUTE6XKGUiVS"),
]

MAX_RELEASES = int(os.environ.get("MAX_RELEASES", "400"))
BATCH = 40


def norm(name):
    """Lowercase, strip accents, drop bracketed qualifiers and punctuation.

    Deduping by title is the whole ballgame here: the same song ships as a
    single, on an album, on a repackage and in a dozen 'deluxe' editions, each
    with its own track ID and its own full play_count. Summing those IDs would
    multiply a hit by five."""
    n = unicodedata.normalize("NFKD", name or "")
    n = "".join(c for c in n if not unicodedata.combining(c)).lower()
    n = re.sub(r"[\(\[].*?[\)\]]", " ", n)          # (Remix), [Japanese Ver.]
    n = re.sub(r"\s*-\s*(from|feat|with).*$", " ", n)
    n = re.sub(r"[^a-z0-9]+", " ", n)
    return " ".join(n.split())


def collapse_merged(counted, merge_min=1_000_000):
    """Same rule as the live catalog job: tracks sharing an identical large
    play_count are one Spotify-merged entity, counted once."""
    groups = {}
    for c in counted:
        groups.setdefault(c["streams"], []).append(c)
    kept, dropped = [], []
    for streams, grp in groups.items():
        if len(grp) > 1 and streams >= merge_min:
            grp = sorted(grp, key=lambda c: (len(c["name"]), c["name"]))
            kept.append(grp[0])
            dropped.extend(grp[1:])
        else:
            kept.extend(grp)
    return kept, dropped


def build_catalog(client, artist_id):
    """-> (tracks, n_albums, n_skipped_dupes). Tracks are unique by ID and by
    normalized title, keeping whichever copy we met first."""
    try:
        releases = client.get_discography(artist_id, max_releases=MAX_RELEASES)
    except Exception as e:
        print(f"  discography failed: {e}", file=sys.stderr)
        return [], 0, 0

    by_id, by_name, dupes = {}, set(), 0
    for rel in releases:
        alb_id = getattr(rel, "id", None)
        if not alb_id:
            continue
        try:
            album = client.get_album(alb_id)
        except Exception as e:
            print(f"  album {alb_id} failed: {e}", file=sys.stderr)
            continue
        for t in (album.tracks or []):
            tid = getattr(t, "id", None)
            if not tid or tid in by_id:
                continue
            aids = [a.id for a in (t.artists or []) if getattr(a, "id", None)]
            if aids and artist_id not in aids:
                continue                       # not credited — a feature on someone else's album
            nm = getattr(t, "name", "") or ""
            k = norm(nm)
            if k and k in by_name:
                dupes += 1
                continue
            by_name.add(k)
            by_id[tid] = nm
    return list(by_id.items()), len(releases), dupes


def playcounts(client, tracks):
    """-> (counted, n_failed). Batched, because one request per track across
    seven catalogs would be thousands of round trips."""
    counted, failed = [], 0
    ids = [tid for tid, _ in tracks]
    names = dict(tracks)
    for i in range(0, len(ids), BATCH):
        chunk = ids[i:i + BATCH]
        try:
            results = client.get_tracks(chunk)
        except Exception as e:
            print(f"  batch failed: {e}", file=sys.stderr)
            failed += len(chunk)
            continue
        for tid, item in zip(chunk, results):
            if not item.ok or item.result.play_count is None:
                failed += 1
                continue
            counted.append({"name": names.get(tid, tid), "streams": item.result.play_count})
    return counted, failed


def kworb_total(artist_id):
    """kworb's own 'Streams / Total' cell, for comparison only."""
    url = f"https://kworb.net/spotify/artist/{artist_id}_songs.html"
    try:
        r = httpx.get(url, timeout=45, headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
    except Exception as e:
        print(f"  kworb fetch failed: {e}", file=sys.stderr)
        return None, None
    html = r.text
    day = None
    m = re.search(r"Last updated:\s*(\d{4}/\d{2}/\d{2})", html)
    if m:
        day = m.group(1)
    for row in re.findall(r"<tr>(.*?)</tr>", html, re.S):
        cells = [re.sub(r"<[^>]+>", "", c).strip() for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S)]
        if cells and cells[0].startswith("Streams") and len(cells) > 1:
            try:
                return int(re.sub(r"[^\d]", "", cells[1])), day
            except ValueError:
                pass
    return None, day


def main():
    only = os.environ.get("ONLY", "").strip()
    targets = [g for g in GROUPS if not only or g[0].lower() in only.lower()]
    with SpotifyClient() as client:
        for name, aid in targets:
            print(f"\n=== {name} [{aid}] ===", flush=True)
            tracks, n_albums, dupes = build_catalog(client, aid)
            print(f"  releases walked: {n_albums}   unique tracks: {len(tracks)}   title-dupes skipped: {dupes}", flush=True)
            if not tracks:
                continue
            counted, failed = playcounts(client, tracks)
            raw = sum(c["streams"] for c in counted)
            kept, merged = collapse_merged(counted)
            ours = sum(c["streams"] for c in kept)
            print(f"  fetched: {len(counted)}   failed: {failed}   merge-collapsed: {len(merged)}")
            print(f"  our total : {ours:,}   (before merge-collapse: {raw:,})")
            kw, day = kworb_total(aid)
            if kw:
                d = ours - kw
                print(f"  kworb     : {kw:,}   (updated {day})")
                print(f"  difference: {d:+,}   ({d / kw * 100:+.2f}%)")
            else:
                print("  kworb     : unavailable")


if __name__ == "__main__":
    main()
