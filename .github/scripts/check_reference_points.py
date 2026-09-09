"""Cross-check the recorded daily totals against every independent measurement
we hold, and print the 2026 gain each one implies.

Nothing here feeds the site. api/girlgroups.js keeps its own baseline
(REFERENCE_YTD, the Sept 3 list) and this never touches it. The point is the
opposite direction: when a new figure turns up — another published list, another
streams-by-year post — this says whether it agrees with what we have been
measuring, and by how much.

Read the DRIFT column, not the gain. A drift that stays constant across runs is a
fixed baseline offset and harmless. A drift that GROWS means our daily tracking
is losing or gaining streams against reality, which is a bug. Those two look
identical in any single run, which is why this exists to be run repeatedly.
"""

import json
import os
import sys

REF = "data/group_streams/reference_points.json"
HIST = "data/group_streams/history.json"

# The published "Most Streamed K-pop Girl Groups in 2026 so far (as of Sep. 3)"
# list — the site's actual baseline. Rounded to ~1M at the source, so a drift
# under about 500k against it means agreement, not a discrepancy.
PUBLISHED_SEP3 = {
    "41MozSoPIsD1dJM0CLPjZF": 1402000000,
    "7n2Ycct7Beij7Dj7meI4X0": 1270000000,
    "4SpbR6yFEvexJuaBpgAU5p": 1269000000,
    "36cgvBn0aadzOijnjjwqMN": 1231000000,
    "6YVMFz59CuY7ngCxTxjpxE":  934260000,
    "6HvZYsbFfjnjFrWF950C9d":  929270000,
    "1SIocsqdEefUTE6XKGUiVS":  778180000,
}

# Days on which a group's kworb total FELL, meaning totals either side are not
# comparable and any gain spanning the boundary is understated.
RESCOPES = {
    "1SIocsqdEefUTE6XKGUiVS": ("2026-08-01", 165427908),
}


def latest(history, aid):
    days = sorted(d for d, groups in history.items() if aid in groups)
    return (days[-1], history[days[-1]][aid]["total_streams"]) if days else (None, None)


def main():
    if not os.path.exists(HIST):
        print(f"no {HIST} yet — nothing recorded", file=sys.stderr)
        return 0
    ref = json.load(open(REF))
    hist = json.load(open(HIST))

    print(f"{'group':<12} {'as of':<11} {'baseline':>16} {'2026 gain':>16} "
          f"{'vs Sep 3 list':>15}")
    print("-" * 76)

    for aid, entry in ref.items():
        if aid == "_README":
            continue
        name = entry["group"]
        day, total = latest(hist, aid)
        if total is None:
            print(f"{name:<12} {'—':<11} {'':>16} {'not yet recorded':>16}")
            continue

        # Prefer an exact year-close; fall back to the nearest earlier point and
        # say so, rather than quietly treating a 12-30 reading as a 12-31 one.
        close = next((p for p in entry["points"]
                      if p["day"] == "2025-12-31" and p.get("exact")), None)
        approx = ""
        if close is None:
            cands = [p for p in entry["points"] if p["day"] < "2026-01-01"]
            if not cands:
                print(f"{name:<12} {day:<11} {'no baseline point':>16}")
                continue
            close = max(cands, key=lambda p: p["day"])
            approx = f"  ~ from {close['day']}"

        gain = total - close["total"]
        pub = PUBLISHED_SEP3.get(aid)
        drift = f"{gain - pub:+,}" if pub else "—"

        flag = ""
        if aid in RESCOPES:
            d, amount = RESCOPES[aid]
            if close["day"] < d <= day:
                flag = f"  ✖ spans the {d} re-scope (−{amount:,}); not comparable"

        print(f"{name:<12} {day:<11} {close['total']:>16,} {gain:>16,} {drift:>15}"
              f"{approx}{flag}")

    print("\nDrift is measured against a list rounded to ~1M and dated one to two")
    print("days before our reading, so a few million in the same direction for")
    print("every group is agreement. Watch for one group drifting differently,")
    print("or for a drift that grows run over run.")
    # Always succeeds: this is a report, and the one flagged condition
    # (BABYMONSTER's August re-scope) is documented and permanent. A check that
    # is red on every run is a check nobody reads.
    return 0


if __name__ == "__main__":
    sys.exit(main())
