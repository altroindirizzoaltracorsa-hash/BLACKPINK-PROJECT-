"""Read-only: WHICH track left a kworb artist page between two points in time?

kworb's BABYMONSTER total fell 165,427,908 between its 2026/08/01 page and its
2026/09/04 one, and the track count went 43 -> 42. The timeline probe established
THAT it happened; this establishes WHAT. Diffs an archived capture's track list
against the live page, by track ID and by title.

Knowing the answer matters because the two possible causes need opposite
responses: a track Spotify merged into another is still being counted (under a
different ID) and nothing is lost, while a track kworb simply stopped listing is
165M of real streams now missing from every figure derived from that page.

Writes nothing.
"""

import os
import re
import sys
import time

import httpx

ARTIST = os.environ.get("ARTIST", "1SIocsqdEefUTE6XKGUiVS")
CAPTURE = os.environ.get("CAPTURE", "20260803023516")   # label 2026/08/01, pre-drop
UA = {"User-Agent": "Mozilla/5.0 (blinksunited catalog probe)"}


def get(url, tries=5):
    delay = 4
    for _ in range(tries):
        r = httpx.get(url, timeout=90, headers=UA, follow_redirects=True)
        if r.status_code in (429, 503, 504):
            print(f"    {r.status_code}; waiting {delay}s", flush=True)
            time.sleep(delay)
            delay *= 2
            continue
        r.raise_for_status()
        return r
    raise RuntimeError("gave up")


def strip_tags(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s)).strip()


def parse(html):
    label = None
    m = re.search(r"Last updated:\s*(\d{4}/\d{2}/\d{2})", html)
    if m:
        label = m.group(1)
    total, rows = None, {}
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S):
        cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S)
        if not cells:
            continue
        texts = [strip_tags(c) for c in cells]
        if texts[0].startswith("Streams") and len(texts) > 1 and total is None:
            dg = re.sub(r"[^\d]", "", texts[1])
            if dg:
                total = int(dg)
            continue
        tm = re.search(r"track/([0-9A-Za-z]{22})", cells[0])
        if not tm:
            continue
        nums = [int(re.sub(r"[^\d]", "", t)) for t in texts[1:] if re.sub(r"[^\d]", "", t)]
        if not nums:
            continue
        rows[tm.group(1)] = {"name": texts[0].lstrip("*").strip(), "streams": nums[0]}
    return label, total, rows


def main():
    then_url = (f"https://web.archive.org/web/{CAPTURE}id_/"
                f"https://kworb.net/spotify/artist/{ARTIST}_songs.html")
    now_url = f"https://kworb.net/spotify/artist/{ARTIST}_songs.html"

    t_label, t_total, then = parse(get(then_url).text)
    n_label, n_total, now = parse(get(now_url).text)

    print(f"before : label {t_label}   total {t_total:,}   {len(then)} tracks")
    print(f"after  : label {n_label}   total {n_total:,}   {len(now)} tracks")
    print(f"change : {n_total - t_total:+,}   ({len(now) - len(then):+d} tracks)\n")

    gone = {k: v for k, v in then.items() if k not in now}
    added = {k: v for k, v in now.items() if k not in then}

    print(f"-- {len(gone)} track(s) present before and gone now --")
    for tid, v in sorted(gone.items(), key=lambda kv: -kv[1]["streams"]):
        # A title still present under a DIFFERENT id means a merge or re-release:
        # the streams are still counted somewhere. A title gone entirely means
        # they are not.
        same_title = [w["name"] for w in now.values() if w["name"] == v["name"]]
        where = "  (title still listed under another id)" if same_title else "  (title gone entirely)"
        print(f"  {v['streams']:>14,}  {v['name'][:52]}  [{tid}]{where}")

    print(f"\n-- {len(added)} track(s) new since --")
    for tid, v in sorted(added.items(), key=lambda kv: -kv[1]["streams"]):
        print(f"  {v['streams']:>14,}  {v['name'][:52]}  [{tid}]")

    kept = [k for k in now if k in then]
    grew = sum(now[k]["streams"] - then[k]["streams"] for k in kept)
    lost = sum(v["streams"] for v in gone.values())
    gained = sum(v["streams"] for v in added.values())
    print(f"\nreconciliation")
    print(f"  growth on the {len(kept)} tracks kept   {grew:>+15,}")
    print(f"  removed                            {-lost:>+15,}")
    print(f"  added                              {gained:>+15,}")
    print(f"  {'':<33}{'':>15}")
    print(f"  net                                {grew - lost + gained:>+15,}")
    print(f"  actual change in kworb's total     {n_total - t_total:>+15,}")


if __name__ == "__main__":
    main()
