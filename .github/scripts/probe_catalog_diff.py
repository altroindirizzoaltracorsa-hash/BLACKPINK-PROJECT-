"""Read-only: WHICH tracks does kworb count that our discography walk doesn't,
and vice versa?

The catalog probe reported a -9.49% gap for BLACKPINK as a single number, which
names nothing and diagnoses nothing. kworb's _songs.html lists every track with
its own stream count, so the gap can be resolved into an actual list of titles.

Three things this separates that the total conflates:
  1. tracks kworb counts and we never found     (under-fetch / scope)
  2. tracks we count and kworb doesn't          (over-reach / dupes)
  3. tracks BOTH count but with different values (a fetch or merge problem)

Writes nothing.
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
DEDUPE_TITLES = os.environ.get("DEDUPE_TITLES", "0") == "1"
SHOW = int(os.environ.get("SHOW", "40"))
BATCH = 40


def norm(name):
    n = unicodedata.normalize("NFKD", name or "")
    n = "".join(c for c in n if not unicodedata.combining(c)).lower()
    n = re.sub(r"[\(\[].*?[\)\]]", " ", n)
    n = re.sub(r"\s*-\s*(from|feat|with).*$", " ", n)
    n = re.sub(r"[^a-z0-9]+", " ", n)
    return " ".join(n.split())


def strip_tags(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s)).strip()


def kworb_songs(artist_id):
    """-> (rows, summary_total, day). rows: [{id, name, streams}] straight off
    kworb's per-track table — every track ID it counts, not deduped, because
    replicating its scope means seeing exactly what it includes."""
    url = f"https://kworb.net/spotify/artist/{artist_id}_songs.html"
    r = httpx.get(url, timeout=60, headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    html = r.text

    day = None
    m = re.search(r"Last updated:\s*(\d{4}/\d{2}/\d{2})", html)
    if m:
        day = m.group(1)

    total = None
    rows = []
    sample = [l for l in re.findall(r"<tr[^>]*>.*?</tr>", html, re.S)[:4]]
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S):
        cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S)
        if not cells:
            continue
        texts = [strip_tags(c) for c in cells]

        # Summary block: first cell labels the row, column 1 is the Total.
        if texts[0].startswith("Streams") and len(texts) > 1 and total is None:
            digits = re.sub(r"[^\d]", "", texts[1])
            if digits:
                total = int(digits)
            continue

        # kworb has used several href shapes for a track over time
        # (../track/ID.html, /spotify/track/ID.html, an open.spotify.com link).
        # Match the ID wherever it sits rather than pinning one path, because a
        # parser that silently yields zero rows reads exactly like "kworb and we
        # agree on nothing" — which is what the first run of this reported.
        tm = re.search(r'track/([0-9A-Za-z]{22})', cells[0])
        if not tm:
            continue
        nums = []
        for t in texts[1:]:
            d = re.sub(r"[^\d]", "", t)
            nums.append(int(d) if d else None)
        streams = next((n for n in nums if n is not None), None)
        if streams is None:
            continue
        rows.append({"id": tm.group(1), "name": texts[0].lstrip("*").strip(), "streams": streams})
    return rows, total, day, sample


def build_catalog(client, artist_id):
    try:
        releases = client.get_discography(artist_id, max_releases=MAX_RELEASES)
    except Exception as e:
        print(f"  discography failed: {e}", file=sys.stderr)
        return [], 0
    by_id, by_name = {}, set()
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
                continue
            nm = getattr(t, "name", "") or ""
            if DEDUPE_TITLES:
                k = norm(nm)
                if k and k in by_name:
                    continue
                by_name.add(k)
            by_id[tid] = nm
    return list(by_id.items()), len(releases)


def playcounts(client, tracks):
    counted, failed = {}, 0
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
            counted[tid] = {"name": names.get(tid, tid), "streams": item.result.play_count}
    return counted, failed


def report(name, aid, client):
    print(f"\n{'=' * 70}\n=== {name} [{aid}]\n{'=' * 70}", flush=True)

    krows, ktotal, kday, sample = kworb_songs(aid)
    if not krows:
        print("PARSE FAILED — no per-track rows matched. Raw sample of the page:")
        for line in sample:
            print("   ", line[:300])
        return
    ksum = sum(r["streams"] for r in krows)
    print(f"kworb: {len(krows)} tracks, rows sum to {ksum:,}, summary says {ktotal:,} (updated {kday})")
    if ktotal and abs(ksum - ktotal) > 1000:
        print(f"  note: rows and summary differ by {ksum - ktotal:+,} — kworb's own table is truncated or scoped differently")

    tracks, n_rel = build_catalog(client, aid)
    ours, failed = playcounts(client, tracks)
    osum = sum(v["streams"] for v in ours.values())
    print(f"ours : {len(ours)} tracks from {n_rel} releases, summing {osum:,} (failed {failed}, title-dedupe {'ON' if DEDUPE_TITLES else 'OFF'})")

    # Spotify merges alternate versions: "How You Like That - Live" and "How You
    # Like That" return the SAME play_count, so summing both counts the song
    # twice. Group by identical value and keep one per group — the live catalog
    # job's rule. Report it alongside the raw sum, since the difference between
    # them IS the double-counting.
    groups = {}
    for tid, v in ours.items():
        groups.setdefault(v["streams"], []).append(v["name"])
    dup_cost = sum(val * (len(names) - 1) for val, names in groups.items()
                   if len(names) > 1 and val >= 1_000_000)
    print(f"       merge-collapsed: {osum - dup_cost:,}   (double-counting removed: {dup_cost:,})")
    multi = sorted(((v, n) for v, n in groups.items() if len(n) > 1 and v >= 1_000_000),
                   key=lambda x: -x[0] * (len(x[1]) - 1))
    print(f"       {len(multi)} merged groups, e.g.:")
    for val, names in multi[:6]:
        print(f"         {val:>14,} x{len(names)}  {' | '.join(n[:34] for n in names)}")

    kby = {r["id"]: r for r in krows}
    only_k = [r for tid, r in kby.items() if tid not in ours]
    only_o = [{"id": tid, **v} for tid, v in ours.items() if tid not in kby]
    both = [tid for tid in ours if tid in kby]

    mism = [(kby[t]["name"], ours[t]["streams"], kby[t]["streams"])
            for t in both if ours[t]["streams"] != kby[t]["streams"]]

    print(f"\nmatched by track ID: {len(both)}")
    print(f"  of those, values differing: {len(mism)}")
    print(f"only in kworb: {len(only_k)}  worth {sum(r['streams'] for r in only_k):,}")
    print(f"only in ours : {len(only_o)}  worth {sum(r['streams'] for r in only_o):,}")

    only_k.sort(key=lambda r: -r["streams"])
    print(f"\n-- top {SHOW} kworb counts and we don't --")
    for r in only_k[:SHOW]:
        print(f"  {r['streams']:>14,}  {r['name'][:60]}")

    only_o.sort(key=lambda r: -r["streams"])
    print(f"\n-- top {SHOW} we count and kworb doesn't --")
    for r in only_o[:SHOW]:
        print(f"  {r['streams']:>14,}  {r['name'][:60]}")

    if mism:
        mism.sort(key=lambda x: -abs(x[1] - x[2]))
        print(f"\n-- top {SHOW} same track ID, different value (ours vs kworb) --")
        for nm, o, k in mism[:SHOW]:
            print(f"  {o - k:>+14,}  ours {o:>14,}  kworb {k:>14,}  {nm[:44]}")

    # Titles kworb has that we have under a DIFFERENT track ID: a re-release, not
    # a missing song. Separating these matters — one is a scope choice, the other
    # is a fetch failure, and they need opposite fixes.
    o_names = {}
    for tid, v in ours.items():
        o_names.setdefault(norm(v["name"]), []).append(v["streams"])
    same_title = [r for r in only_k if norm(r["name"]) in o_names]
    print(f"\nof the {len(only_k)} kworb-only tracks, {len(same_title)} share a title with something we already have"
          f" (worth {sum(r['streams'] for r in same_title):,}) — different ID, same song")
    print(f"genuinely absent from our walk: {len(only_k) - len(same_title)}"
          f"  worth {sum(r['streams'] for r in only_k) - sum(r['streams'] for r in same_title):,}")


def main():
    only = os.environ.get("ONLY", "").strip()
    targets = [g for g in GROUPS if not only or g[0].lower() in only.lower()]
    with SpotifyClient() as client:
        for name, aid in targets:
            try:
                report(name, aid, client)
            except Exception as e:
                print(f"  FAILED for {name}: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
