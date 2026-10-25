#!/usr/bin/env python3
"""How much does one request to each public endpoint cost in bandwidth?

Upstash suspended this site's database on 2026-10-24 for exceeding 10 GB of
monthly bandwidth, and the first anyone knew of it was the site going down. The
cause was not a spike in traffic — it was two endpoints each answering with far
more bytes than anyone had looked at, on every single call:

  /api/youtube-history   ~2.9 MB per call, polled every 45s, no cache
  /api/leaderboard        240 KB per call, no cache, public

Neither is visible in the output. Both returned exactly the right JSON. The only
symptom was a number on a billing page nobody reads until it is too late.

So this measures the one thing that actually drives the bill — RESPONSE SIZE ×
HOW OFTEN IT CAN BE ASKED — and fails when an endpoint grows past its budget.
A budget here is not a guess at traffic: it is "this route may send this much
per request", which is a property of the code and is a fair thing to hold
steady. If a change doubles a payload, this says so while it is still a pull
request, instead of four weeks later via a suspension email.

The cache header is checked for the same reason. A big payload with an edge
cache costs the database one read per TTL no matter how many people arrive; the
same payload with no-store costs one read per VISITOR. That single difference is
what separated the two endpoints above from the rest of the site.

Read-only: one GET per endpoint.
"""
import json
import os
import re
import sys
import urllib.request

BASE = os.environ.get("BASE", "https://www.blinksunited.com")

# (path, max KB, api file that must set s-maxage — or None if the route is
# deliberately uncached)
#
# Budgets are set a little above what each route measured when it was last
# looked at, so ordinary drift is quiet and a step change is not. Raising one
# is a perfectly reasonable thing to do — but it should be a decision somebody
# makes, which is the whole point of putting a number here.
ENDPOINTS = [
    ("/api/leaderboard",                     300, "api/leaderboard.js"),   # 235 KB measured
    ("/api/streams",                         120, "api/streams.js"),       # 8.9 KB
    ("/api/playlist",                         80, "api/playlist.js"),      # 0.1 KB
    ("/api/kcharts-live",                     80, "api/kcharts-live.js"),  # 0.5 KB
    # A live vote board, intentionally no-store. Size still budgeted.
    ("/api/collabs?id=bvp-kca-2026",          60, None),                   # 7.0 KB
]

# THE CDN TTL CANNOT BE READ OFF THE RESPONSE. Vercel strips `s-maxage` and
# serves `public, max-age=0, must-revalidate` to the client, caching at the edge
# per the stripped directive. The first version of this check parsed the
# response header and got every row wrong in a different way: /api/streams and
# /api/playlist PASSED on the `max-age=0` substring while proving nothing,
# /api/kcharts-live FAILED on a bare `public` although it sets s-maxage=120, and
# /api/collabs FAILED for being uncached when it is a live vote board and is
# meant to be. So the directive is read from the source, where it is
# unambiguous, and the response supplies only the size.
CACHE_RE = re.compile(r"Cache-Control['\"],\s*['\"][^'\"]*s-maxage=\d+")


def probe(path):
    req = urllib.request.Request(BASE + path, headers={"User-Agent": "bandwidth-budget/1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
        # x-vercel-cache (HIT/MISS/STALE/BYPASS) is the one live signal that says
        # whether the edge is caching this route at all. Reported, not asserted:
        # a MISS is the normal answer for the first request after a deploy.
        return r.status, len(body), (r.headers.get("x-vercel-cache") or "-")


def main():
    fails, rows = [], []
    for path, max_kb, src in ENDPOINTS:
        try:
            status, size, vercel_cache = probe(path)
        except Exception as e:
            # Unreachable is not a pass. It is also not a budget failure — say
            # which it is rather than letting a network blip read as "fine".
            print(f"  !! {path}: unreachable ({e})", file=sys.stderr)
            fails.append(f"{path}: could not be measured")
            continue

        kb = size / 1024
        over = kb > max_kb
        bad_cache = False
        if src:
            try:
                bad_cache = not CACHE_RE.search(open(src, encoding="utf-8").read())
            except OSError as e:
                bad_cache = True
                print(f"  !! {src}: {e}", file=sys.stderr)

        flag = "FAIL" if (over or bad_cache) else " ok "
        print(f"  {flag}  {path:34s} {kb:8.1f} KB / {max_kb} KB   "
              f"s-maxage in source: {'no' if bad_cache else ('yes' if src else 'n/a')}   "
              f"edge: {vercel_cache}")
        rows.append((path, round(kb, 1), max_kb, vercel_cache))

        if status != 200:
            fails.append(f"{path}: HTTP {status}")
        if over:
            # The arithmetic that matters, spelled out, because "over budget"
            # on its own never conveyed why anyone should care.
            calls = int(10 * 1024 * 1024 / kb) if kb else 0
            fails.append(
                f"{path}: {kb:.1f} KB per request exceeds its {max_kb} KB budget "
                f"— about {calls:,} requests would spend a 10 GB month on this route alone"
            )
        if bad_cache:
            fails.append(
                f"{path}: {src} sets no s-maxage, so this payload is re-read from the "
                f"store for EVERY visitor rather than once per edge TTL"
            )

    print("\n" + json.dumps({"base": BASE, "measured": rows}, indent=2))

    if fails:
        print()
        for f in fails:
            print(f"::error::{f}")
        print(f"\n{len(fails)} endpoint budget(s) exceeded.")
        return 1
    print("\nevery endpoint is inside its budget, and every cacheable one sets s-maxage.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
