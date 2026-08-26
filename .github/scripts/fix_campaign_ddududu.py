"""
Diagnose (and optionally fix) the DDU-DU DDU-DU campaign-track card after the
Aug-17 Spotify version-merge spiked its live count to ~966M. Because the card's
history is only-up + immutable, the real value falling back to ~886M froze it:
every fetch since sees 886M < the stored 966M `prev` and refuses to record, so the
card is stuck on 17/08 with a bogus +81M day.

This reads /api/streams (public) to snapshot the track, then (APPLY=1 only):
  1. Deletes every anomalous daily entry (streams > SPIKE_MIN) — the merge spike.
  2. Re-anchors prev/live to the real current live total on a recent date via
     ?action=set-entry, so the only-up gate reopens and normal daily recording
     resumes with correct labels.

Env: ADMIN_KEY (required). APPLY=1 to write (default dry-run). Reads/writes only
the `ddududu` track.
"""

import os
import sys
import json
import urllib.request
import urllib.parse
import urllib.error

BASE = "https://blinksunited.com/api/streams"
KEY = os.environ["ADMIN_KEY"]
APPLY = os.environ.get("APPLY") == "1"
TRACK = "ddududu"
SPIKE_MIN = 15_000_000   # DDU-DU gains ~200k-1M/day; anything above this is a merge glitch


def call(url):
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.load(e)
        except Exception:
            return {"httperror": e.code}
    except Exception as e:
        return {"error": str(e)}


def snapshot(label):
    d = call(BASE)
    tr = d.get(TRACK, {}) or {}
    hist = tr.get("history", []) or []
    prev = tr.get("prev")
    total = tr.get("total")
    print(f"\n===== {label} =====")
    print(f"  live total = {total:,}" if isinstance(total, int) else f"  live total = {total}")
    print(f"  prev = {prev}")
    print(f"  history ({len(hist)} entries), last 15:")
    for e in hist[-15:]:
        flag = "  <== SPIKE" if isinstance(e.get('streams'), int) and e['streams'] > SPIKE_MIN else ""
        print(f"    {e['date']} = {e['streams']:,}{flag}")
    return tr, hist, prev, total


def main():
    print(f"MODE: {'APPLY (writing)' if APPLY else 'DRY-RUN (read-only)'}   track={TRACK}")
    tr, hist, prev, total = snapshot("BEFORE")

    spikes = [e for e in hist if isinstance(e.get("streams"), int) and e["streams"] > SPIKE_MIN]
    good = [e for e in hist if not (isinstance(e.get("streams"), int) and e["streams"] > SPIKE_MIN)]
    print("\n----- plan -----")
    if spikes:
        print("  delete spike entries: " + ", ".join(f"{e['date']}={e['streams']:,}" for e in spikes))
    else:
        print("  no spike entries found")
    last_good = good[-1] if good else None
    if last_good:
        print(f"  last good entry: {last_good['date']} = {last_good['streams']:,}")
    if isinstance(total, int):
        print(f"  re-anchor prev/live -> total={total:,} on the last good date "
              f"so the next real bump records as the following day")
    if prev:
        print(f"  (current prev.total={prev.get('total'):,} on {prev.get('date')} is what's blocking new days)")

    if not APPLY:
        print("\nDRY-RUN — no writes. Set APPLY=1 to apply.")
        return

    if not isinstance(total, int) or total <= 0:
        print("ERROR: no usable live total; aborting write.", file=sys.stderr)
        sys.exit(1)

    # 1) delete spikes
    for e in spikes:
        u = f"{BASE}?action=delete-history-entry&track={TRACK}&date={urllib.parse.quote(e['date'])}&key={urllib.parse.quote(KEY)}"
        res = call(u)
        print(f"  deleted {e['date']}: ok={res.get('ok')} removed={res.get('removed')}")

    # 2) re-anchor prev/live to the real live total on the last good date (rewriting
    #    that entry unchanged), so the only-up gate reopens and labels stay correct.
    if last_good:
        anchor_date = last_good["date"]
        anchor_streams = last_good["streams"]
        u = (f"{BASE}?action=set-entry&track={TRACK}"
             f"&date={urllib.parse.quote(anchor_date)}&streams={anchor_streams}"
             f"&total={total}&prevDate={urllib.parse.quote(anchor_date)}&key={urllib.parse.quote(KEY)}")
        res = call(u)
        print(f"  re-anchored prev/live to {total:,} on {anchor_date}: ok={res.get('ok')}")
    else:
        print("  no good entry to anchor on — skipped re-anchor", file=sys.stderr)

    snapshot("AFTER")


if __name__ == "__main__":
    main()
