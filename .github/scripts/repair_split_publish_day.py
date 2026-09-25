#!/usr/bin/env python3
"""One-off: fold a group's half-published day back into the day it belongs to.

Spotify publishes a streaming day in stages. fetch_group_streams.py labelled
every run "the day after the last recorded day", so a fetch landing mid-publish
opened a day from part of the catalogue and the next run opened ANOTHER day from
the rest. On 2026-09-23/24 that split one day in two for four of the seven
groups. (The guard that prevents it is now in fetch_group_streams.py; this
cleans up what the old behaviour left behind.)

Folds <extra-day> into <day>: the later row's total and track count win, the
delta is recomputed against the day BEFORE, and the later row is removed.

Refuses rather than guesses:
  * a group whose two deltas do not sum to something plausible against the days
    before is left alone and reported, not quietly rewritten;
  * a group with no row on the extra day is skipped;
  * --check makes no changes at all.

  python3 repair_split_publish_day.py --day 2026-09-23 --extra-day 2026-09-24 --check
"""
import argparse
import csv
import json
import os
import statistics
import sys
from datetime import date, timedelta

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), "data", "group_streams")
HISTORY = os.path.join(OUT_DIR, "history.json")
CSV_PATH = os.path.join(OUT_DIR, "history.csv")
CSV_COLUMNS = ["date", "group", "artist_id", "total_streams", "daily_delta", "tracks", "note"]

# How far the two halves' sum may sit from the surrounding days before we stop
# believing they are one day. The four real cases landed within 4%.
PLAUSIBLE = 0.25
BASELINE_DAYS = 4


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", required=True, help="the day to keep, e.g. 2026-09-23")
    ap.add_argument("--extra-day", required=True, help="the day to fold into it")
    ap.add_argument("--check", action="store_true", help="report only, change nothing")
    args = ap.parse_args()

    history = json.load(open(HISTORY))
    if args.day not in history:
        sys.exit(f"no history for {args.day}")
    if args.extra_day not in history:
        print(f"no rows on {args.extra_day} — nothing to fold (already done?)")
        return

    prev_day = (date.fromisoformat(args.day) - timedelta(days=1)).isoformat()
    if prev_day not in history:
        sys.exit(f"the day before ({prev_day}) is missing — cannot recompute deltas")

    folded, skipped = [], []
    for aid, extra in sorted(history[args.extra_day].items()):
        keep = history[args.day].get(aid)
        before = history[prev_day].get(aid)
        if keep is None or before is None:
            skipped.append((aid, f"no row on {args.day if keep is None else prev_day}"))
            continue

        combined = extra["total_streams"] - before["total_streams"]

        # What a normal day looks like for this group, from the days before.
        base = []
        d = date.fromisoformat(prev_day)
        while len(base) < BASELINE_DAYS:
            rec = history.get(d.isoformat(), {}).get(aid)
            if rec is None:
                break
            if rec.get("daily_delta"):
                base.append(rec["daily_delta"])
            d -= timedelta(days=1)
        if not base:
            skipped.append((aid, "no baseline days to judge against"))
            continue
        normal = statistics.mean(base)
        off = abs(combined - normal) / normal if normal else 1.0
        if off > PLAUSIBLE:
            skipped.append((aid, f"combined {combined:,} is {off:.0%} off a normal "
                                 f"day ({normal:,.0f}) — these may be two real days"))
            continue

        folded.append((aid, keep["total_streams"], extra["total_streams"], combined, normal, off))
        if not args.check:
            keep["total_streams"] = extra["total_streams"]
            keep["daily_delta"] = combined
            keep["tracks"] = extra["tracks"]
            keep.pop("provisional", None)
            note = (extra.get("note") or "").replace("still publishing", "").strip("; ").strip()
            keep["note"] = note
            del history[args.extra_day][aid]

    print(f"\n{'group id':<24}{'was':>16}{'now':>16}{'delta':>14}{'normal':>14}   off")
    for aid, was, now, combined, normal, off in folded:
        print(f"{aid:<24}{was:>16,}{now:>16,}{combined:>14,}{normal:>14,.0f}   {off:+.1%}")
    for aid, why in skipped:
        print(f"{aid:<24}  SKIPPED — {why}")
    if not folded:
        print("  (nothing folded)")

    if args.check:
        print("\n--check: nothing written")
        return
    if not folded:
        return

    if not history[args.extra_day]:
        del history[args.extra_day]
        print(f"\n{args.extra_day} is now empty — removed")

    with open(HISTORY, "w") as f:
        json.dump(history, f, indent=2, sort_keys=True)
        f.write("\n")

    # Rewrite only the affected rows; every other line is carried over unchanged.
    rows = list(csv.DictReader(open(CSV_PATH, newline="")))
    ids = {aid for aid, *_ in folded}
    out = []
    for r in rows:
        if r["date"] == args.extra_day and r["artist_id"] in ids:
            continue                                   # folded away
        if r["date"] == args.day and r["artist_id"] in ids:
            rec = history[args.day][r["artist_id"]]
            r = dict(r, total_streams=str(rec["total_streams"]),
                     daily_delta=str(rec["daily_delta"]),
                     tracks=str(rec["tracks"]), note=rec["note"])
        out.append(r)
    with open(CSV_PATH, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        w.writeheader()
        w.writerows(out)

    print(f"\nrewrote {len(folded)} group(s) into {args.day}")


if __name__ == "__main__":
    main()
