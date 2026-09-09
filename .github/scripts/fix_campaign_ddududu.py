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
import time
import urllib.request
import urllib.parse
import urllib.error

BASE = "https://blinksunited.com/api/streams"
KEY = os.environ["ADMIN_KEY"]
APPLY = os.environ.get("APPLY") == "1"
TRACK = "ddududu"
SPIKE_MIN = 15_000_000   # DDU-DU gains ~200k-1M/day; anything above this is a merge glitch

# Accurate daily deltas for the frozen gap, from kworb / the Supabase catalog
# export (main "DDU-DU DDU-DU"): real cumulative 885,183,825 (16/08) -> 886,576,127
# (24/08). Only 17/08 was glitched (966M merge), so 17+18 evenly split the 16->18
# span; 19-24 are exact. Sum = 1,392,302 = the real gain. Overrides even spread.
ACCURATE_DELTAS = {
    "17/08": 188_423, "18/08": 188_423, "19/08": 77_015, "20/08": 135_694,
    "21/08": 199_204, "22/08": 206_527, "23/08": 199_029, "24/08": 197_987,
}


def _next_day(ddmm):
    d, m = [int(x) for x in ddmm.split("/")]
    d += 1
    if d > 31:
        d, m = 1, m + 1
    return f"{d:02d}/{m:02d}"


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
    # Cache-buster: /api/streams sets s-maxage=60 + stale-while-revalidate=120, so
    # a plain GET can serve a stale snapshot for minutes. A unique query param makes
    # the CDN miss and read live Redis.
    d = call(f"{BASE}?nocache={int(time.time())}")
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

    # Backfill plan: the frozen gap really did gain streams. Recover the true
    # cumulative at the last good day from the spike (merged prev.total minus the
    # spike delta), spread the real gain (live - that) evenly across the gap days,
    # and re-anchor prev/live on the final gap day so counting resumes current.
    GAP_END = os.environ.get("GAP_END", "24/08")   # last day to backfill (labels resume the day after)

    def date_range(start_ddmm, end_ddmm):
        (sd, sm), (ed, em) = ([int(x) for x in start_ddmm.split("/")],
                              [int(x) for x in end_ddmm.split("/")])
        out, d, m = [], sd, sm
        for _ in range(400):
            out.append(f"{d:02d}/{m:02d}")
            if (d, m) == (ed, em):
                break
            d += 1
            if d > 31:
                d, m = 1, m + 1
        return out

    # Gap dates: use the explicit accurate-delta dates when provided (robust on a
    # re-run when the spike is already gone), else compute from the last good day.
    if ACCURATE_DELTAS:
        gap_dates = sorted(ACCURATE_DELTAS, key=lambda s: (int(s.split("/")[1]), int(s.split("/")[0])))
    else:
        gap_dates = date_range(_next_day(last_good["date"]), GAP_END) if last_good else []

    use_accurate = bool(ACCURATE_DELTAS) and all(gd in ACCURATE_DELTAS for gd in gap_dates)
    if use_accurate:
        gap_gain = sum(ACCURATE_DELTAS[gd] for gd in gap_dates)
    else:
        total_last_good = (prev.get("total") - sum(e["streams"] for e in spikes)) if (prev and spikes) else None
        gap_gain = (total - total_last_good) if (isinstance(total, int) and total_last_good) else None
    if gap_dates:
        src = "accurate (kworb/catalog)" if use_accurate else "even spread"
        print(f"  backfill {gap_dates[0]}..{gap_dates[-1]} ({len(gap_dates)} days), gain={gap_gain:,} [{src}]"
              if gap_gain is not None else f"  backfill {gap_dates[0]}..{gap_dates[-1]} [{src}]")

    if not APPLY:
        print("\nDRY-RUN — no writes. Set APPLY=1 to apply.")
        return

    if not isinstance(total, int) or total <= 0 or not gap_dates or gap_gain is None:
        print("ERROR: could not compute a safe backfill; aborting write.", file=sys.stderr)
        sys.exit(1)

    # 1) delete any spikes still present
    for e in spikes:
        u = f"{BASE}?action=delete-history-entry&track={TRACK}&date={urllib.parse.quote(e['date'])}&key={urllib.parse.quote(KEY)}"
        res = call(u)
        print(f"  deleted {e['date']}: ok={res.get('ok')} removed={res.get('removed')}")

    # 2) backfill the gap (accurate deltas when available); anchor prev/live on the last day
    per = max(0, gap_gain // len(gap_dates))
    remainder = gap_gain - per * (len(gap_dates) - 1)
    for i, gd in enumerate(gap_dates):
        last = i == len(gap_dates) - 1
        streams = ACCURATE_DELTAS[gd] if use_accurate else (remainder if last else per)
        u = (f"{BASE}?action=set-entry&track={TRACK}"
             f"&date={urllib.parse.quote(gd)}&streams={streams}")
        if last:
            u += f"&total={total}&prevDate={urllib.parse.quote(gd)}"
        u += f"&key={urllib.parse.quote(KEY)}"
        res = call(u)
        print(f"  backfilled {gd} = {streams:,}{' (+anchor prev/live)' if last else ''}: ok={res.get('ok')}")

    snapshot("AFTER")


if __name__ == "__main__":
    main()
