"""Read-only: can the Internet Archive give us each group's REAL 1 Jan 2026 total?

Everything we have collected is all-time-as-of-today. "Streams gained in 2026"
needs a starting point, and for six of the seven groups we don't have one — their
baselines are derived from a published list someone else compiled, whose scope we
have never been able to check.

kworb's artist pages are static HTML and the Archive crawls them. A snapshot from
around New Year carries that day's total, per track and in the summary — a
measurement rather than a borrowed figure. If those snapshots exist, every
group's 2026 gain becomes computable from two numbers we hold ourselves.

The date arithmetic matters: kworb's "Last updated" label runs ONE DAY AHEAD of
the streaming day it describes, so a page labelled 2026/01/01 reports the total
through 2025-12-31 — exactly the boundary we want. This prints the label found
so the choice can be checked rather than assumed.

BLACKPINK is the control again: our own board says it gained 1,406,786,129 in
2026 through Sep 4, so archive baseline + our growth has to reproduce that.

Writes nothing.
"""

import os
import re
import sys
import time

import httpx

GROUPS = [
    ("BLACKPINK",   "41MozSoPIsD1dJM0CLPjZF"),
    ("TWICE",       "7n2Ycct7Beij7Dj7meI4X0"),
    ("NewJeans",    "6HvZYsbFfjnjFrWF950C9d"),
    ("LE SSERAFIM", "4SpbR6yFEvexJuaBpgAU5p"),
    ("aespa",       "6YVMFz59CuY7ngCxTxjpxE"),
    ("ILLIT",       "36cgvBn0aadzOijnjjwqMN"),
    ("BABYMONSTER", "1SIocsqdEefUTE6XKGUiVS"),
]

FROM = os.environ.get("FROM", "20251220")
TO = os.environ.get("TO", "20260120")
UA = {"User-Agent": "Mozilla/5.0 (blinksunited catalog probe)"}


def strip_tags(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s)).strip()


def snapshots(artist_id):
    """CDX index of every archived capture of this page in the window."""
    url = (
        "https://web.archive.org/cdx/search/cdx"
        f"?url=kworb.net/spotify/artist/{artist_id}_songs.html"
        f"&from={FROM}&to={TO}&output=json&fl=timestamp,statuscode&collapse=timestamp:8"
    )
    r = httpx.get(url, timeout=90, headers=UA, follow_redirects=True)
    r.raise_for_status()
    rows = r.json()
    if not rows or len(rows) < 2:
        return []
    return [t for t, code in rows[1:] if code in ("200", "-")]


def parse_snapshot(artist_id, ts):
    """-> (total, tracks, label). `id_` asks the Archive for the ORIGINAL bytes
    without its own toolbar injected, which otherwise lands inside the markup we
    are parsing."""
    url = f"https://web.archive.org/web/{ts}id_/https://kworb.net/spotify/artist/{artist_id}_songs.html"
    r = httpx.get(url, timeout=90, headers=UA, follow_redirects=True)
    r.raise_for_status()
    html = r.text

    label = None
    m = re.search(r"Last updated:\s*(\d{4}/\d{2}/\d{2})", html)
    if m:
        label = m.group(1)

    total, n = None, 0
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S):
        cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S)
        if not cells:
            continue
        texts = [strip_tags(c) for c in cells]
        if texts[0].startswith("Streams") and len(texts) > 1 and total is None:
            d = re.sub(r"[^\d]", "", texts[1])
            if d:
                total = int(d)
        if re.search(r"track/([0-9A-Za-z]{22})", cells[0]):
            n += 1
    return total, n, label


def main():
    print(f"searching archived captures between {FROM} and {TO}\n")
    for name, aid in GROUPS:
        print(f"=== {name} [{aid}]", flush=True)
        try:
            snaps = snapshots(aid)
        except Exception as e:
            print(f"  CDX lookup failed: {e}\n", file=sys.stderr)
            continue
        if not snaps:
            print("  no captures in the window\n")
            continue
        print(f"  {len(snaps)} captures: {', '.join(snaps[:12])}{' …' if len(snaps) > 12 else ''}")

        # Try the captures nearest the New Year boundary first.
        ordered = sorted(snaps, key=lambda t: abs(int(t[:8]) - 20260101))
        for ts in ordered[:3]:
            try:
                total, n, label = parse_snapshot(aid, ts)
            except Exception as e:
                print(f"  {ts}: fetch failed: {e}")
                continue
            if total is None:
                print(f"  {ts}: page fetched but no Streams row (layout differed then?)")
                continue
            print(f"  {ts}: label {label}   total {total:,}   ({n} tracks listed)")
            break
        print(flush=True)
        time.sleep(1)   # the Archive rate-limits; this probe is not in a hurry


if __name__ == "__main__":
    main()
