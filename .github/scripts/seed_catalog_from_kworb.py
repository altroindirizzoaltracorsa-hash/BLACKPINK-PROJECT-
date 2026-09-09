"""Seed each group's monitored track list from kworb's own song table, once.

The point of this is NOT that kworb is authoritative. It's that kworb's
_songs.html publishes the track IDs behind the total it reports, so seeding from
it gives us its curation without reverse-engineering it — and the diff probe
established that our per-track play_counts are IDENTICAL to kworb's on every
shared track (103/103, zero differing). Same numbers, so the only thing we were
ever missing was the list.

Once seeded, the list is a committed JSON file per group: what is monitored stops
being a number to trust and becomes a file to read. Daily fetching is then ours,
on our schedule, and kworb is out of the loop.

The check that makes it trustworthy: re-fetch every seeded ID ourselves and
compare the sum to kworb's own published total. For BLACKPINK, whose catalog we
already know is right, that must land exactly.

Writes JSON only when WRITE=1, and never touches Supabase or Redis.
"""

import json
import os
import re
import sys

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

OUT_DIR = "data/group_catalogs"
WRITE = os.environ.get("WRITE", "0") == "1"
LIST_TRACKS = os.environ.get("LIST_TRACKS", "0") == "1"
BATCH = 40


def strip_tags(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s)).strip()


def kworb_songs(artist_id):
    """-> (rows, summary_total, day, sample). Every track ID kworb counts, in the
    order it lists them, with the stream figure it reports for each."""
    url = f"https://kworb.net/spotify/artist/{artist_id}_songs.html"
    r = httpx.get(url, timeout=60, headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    html = r.text

    day = None
    m = re.search(r"Last updated:\s*(\d{4}/\d{2}/\d{2})", html)
    if m:
        day = m.group(1)

    total, rows = None, []
    sample = re.findall(r"<tr[^>]*>.*?</tr>", html, re.S)[:4]
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S):
        cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S)
        if not cells:
            continue
        texts = [strip_tags(c) for c in cells]
        if texts[0].startswith("Streams") and len(texts) > 1 and total is None:
            digits = re.sub(r"[^\d]", "", texts[1])
            if digits:
                total = int(digits)
            continue
        tm = re.search(r"track/([0-9A-Za-z]{22})", cells[0])
        if not tm:
            continue
        nums = [int(re.sub(r"[^\d]", "", t)) for t in texts[1:] if re.sub(r"[^\d]", "", t)]
        if not nums:
            continue
        # A leading "*" is kworb's marker for a track the artist only features on.
        rows.append({
            "id": tm.group(1),
            "name": texts[0].lstrip("*").strip(),
            "feature": texts[0].strip().startswith("*"),
            "kworb_streams": nums[0],
        })
    return rows, total, day, sample


def playcounts(client, ids):
    got, failed = {}, []
    for i in range(0, len(ids), BATCH):
        chunk = ids[i:i + BATCH]
        try:
            results = client.get_tracks(chunk)
        except Exception as e:
            print(f"  batch failed: {e}", file=sys.stderr)
            failed.extend(chunk)
            continue
        for tid, item in zip(chunk, results):
            if not item.ok or item.result.play_count is None:
                failed.append(tid)
                continue
            got[tid] = {"name": item.result.name, "streams": item.result.play_count}
    return got, failed


def seed(name, aid, client):
    print(f"\n{'=' * 72}\n=== {name} [{aid}]\n{'=' * 72}", flush=True)

    rows, ktotal, kday, sample = kworb_songs(aid)
    if not rows:
        print("PARSE FAILED — no per-track rows. Raw sample:")
        for s in sample:
            print("   ", s[:300])
        return None
    krows_sum = sum(r["kworb_streams"] for r in rows)
    n_feat = sum(1 for r in rows if r["feature"])
    print(f"kworb lists {len(rows)} tracks ({n_feat} as feature), summing {krows_sum:,}")
    print(f"kworb summary total: {ktotal:,} (updated {kday})")
    if ktotal is not None and krows_sum != ktotal:
        print(f"  ⚠ kworb's rows and its own summary disagree by {krows_sum - ktotal:+,}")

    got, failed = playcounts(client, [r["id"] for r in rows])
    ours = sum(v["streams"] for v in got.values())
    print(f"\nwe fetched {len(got)}/{len(rows)} of those IDs ourselves, summing {ours:,}")
    if failed:
        print(f"  failed to fetch {len(failed)}: {', '.join(failed[:8])}")

    # The verdict. Same IDs, same source — anything but zero means our fetch and
    # kworb's disagree about a track, which is a different problem from scope.
    diff = ours - krows_sum
    print(f"difference vs kworb's own rows: {diff:+,}" + ("   EXACT ✓" if diff == 0 else ""))
    if diff and ktotal:
        print(f"  as a share of the total: {diff / ktotal * 100:+.4f}%")

    mism = [(r["name"], got[r["id"]]["streams"], r["kworb_streams"])
            for r in rows if r["id"] in got and got[r["id"]]["streams"] != r["kworb_streams"]]
    print(f"tracks where our value differs from kworb's: {len(mism)}")
    for nm, o, k in sorted(mism, key=lambda x: -abs(x[1] - x[2]))[:15]:
        print(f"   {o - k:>+13,}  ours {o:>14,}  kworb {k:>14,}  {nm[:40]}")

    if LIST_TRACKS:
        print(f"\n-- every track monitored for {name} --")
        for i, r in enumerate(rows, 1):
            mark = "*" if r["feature"] else " "
            print(f"  {i:>3}. {mark} {r['kworb_streams']:>13,}  {r['name'][:58]}  [{r['id']}]")

    payload = {
        "artist_id": aid,
        "name": name,
        "seeded_from": f"https://kworb.net/spotify/artist/{aid}_songs.html",
        "seeded_kworb_day": kday,
        "track_count": len(rows),
        # Stream figures are deliberately NOT stored: they go stale within a day
        # and this file is the LIST, not a snapshot. Keeping them would invite
        # someone to read a month-old number as current.
        "tracks": [{"id": r["id"], "name": r["name"], "feature": r["feature"]} for r in rows],
    }
    if WRITE:
        os.makedirs(OUT_DIR, exist_ok=True)
        path = os.path.join(OUT_DIR, f"{aid}.json")
        with open(path, "w") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"\nwrote {path} ({len(rows)} tracks)")
    return payload


def main():
    # "all" rather than "" for every group: GitHub substitutes a workflow input's
    # DEFAULT when you pass an empty string, so a blank filter silently ran only
    # the default group instead of the whole set.
    only = os.environ.get("ONLY", "").strip()
    if only.lower() in ("", "all", "*"):
        targets = list(GROUPS)
    else:
        targets = [g for g in GROUPS if g[0].lower() in only.lower()]
    if not targets:
        print(f"no group matched ONLY={only!r}", file=sys.stderr)
        sys.exit(1)
    with SpotifyClient() as client:
        for name, aid in targets:
            try:
                seed(name, aid, client)
            except Exception as e:
                print(f"FAILED for {name}: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
