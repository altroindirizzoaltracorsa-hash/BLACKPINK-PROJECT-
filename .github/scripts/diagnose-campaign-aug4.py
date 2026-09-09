"""
Read-only diagnostic: hit the live /api/streams endpoint and dump, per campaign
track, the full daily history + the `prev` snapshot + the `_debug` block
(key counts, per-track errors, prev dates). Goal: explain why the RapidAPI
Spotify-scraper keys never recorded an Aug 4 daily entry for the 4 campaign
tracks (JUMP / Shut Down / DDU-DU DDU-DU / GO).

A track's "Aug 4" daily entry is written only when a fetch on Aug 5 (or later)
reads a higher total than `prev` whose date == Aug 4. So a missing Aug 4 entry
means either: (a) no successful fetch on Aug 4 to set prev.date=Aug 4, or
(b) no successful fetch on Aug 5 to diff against it, or (c) keys exhausted /
errored on those days (see _debug.errors + `stale`).
"""

import json
import httpx

URL = "https://www.blinksunited.com/api/streams"


def main():
    with httpx.Client(timeout=60, follow_redirects=True) as c:
        r = c.get(URL)
        print(f"HTTP {r.status_code}  {URL}\n")
        if r.is_error:
            print(r.text[:500])
            return
        data = r.json()

    dbg = data.get("_debug", {})
    print("=== _debug ===")
    print("  server ts:      ", dbg.get("ts"))
    print("  live (fetched?):", dbg.get("live"))
    print("  key counts:     ", dbg.get("keyCounts"))
    errs = dbg.get("errors") or {}
    if errs:
        print("  errors:")
        for k, v in errs.items():
            print(f"    - {k}: {v}")
    else:
        print("  errors:          (none)")
    print("  prev snapshots:")
    for k, v in (dbg.get("prev") or {}).items():
        print(f"    - {k}: {v}")

    for name in ("jump", "shutdown", "ddududdudu", "go"):
        # tolerate whatever the real keys are — print all top-level track-ish keys below too
        pass

    print("\n=== per-track history ===")
    for name, block in data.items():
        if name == "_debug" or not isinstance(block, dict):
            continue
        hist = block.get("history")
        if hist is None and "total" not in block:
            continue
        prev = block.get("prev")
        stale = block.get("stale")
        print(f"\n--- {name} ---")
        print(f"  total={block.get('total'):,}" if isinstance(block.get('total'), int) else f"  total={block.get('total')}")
        print(f"  prev={prev}")
        if stale:
            print(f"  STALE (serving last-known-good, live fetch failed)  updatedAt={block.get('updatedAt')}")
        print("  history (last 10):")
        for h in (hist or [])[-10:]:
            note = f"  [{h['note']}]" if h.get("note") else ""
            s = h.get("streams")
            s_str = f"{s:,}" if isinstance(s, int) else str(s)
            print(f"    {h.get('date'):>8}  {s_str:>14}{note}")
        # Did Aug 4 get recorded, in any common label form?
        labels = {h.get("date") for h in (hist or [])}
        aug4_forms = {"04/08"}  # history labels are DD/MM (getDateLabel)
        hit = labels & aug4_forms
        print(f"  Aug 4 entry present? {'YES ('+', '.join(hit)+')' if hit else 'NO'}")


if __name__ == "__main__":
    main()
