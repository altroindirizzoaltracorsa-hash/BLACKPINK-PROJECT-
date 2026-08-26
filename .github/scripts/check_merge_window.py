"""
Read-only. Inspect a Spotify version-merge window and reconstruct the "real"
per-track numbers on the days a group was merged.

For each day in [FROM, TO] it reads track_daily_stats for BLACKPINK's tracks and:
  1. Prints a focus table for one track family (NAME substring, default
     "as if it's your last") — every member's streams per day, marking the days
     two members share an identical count (= Spotify merged them that day).
  2. Prints a full merge timeline: for every day, which groups of tracks report
     the exact same (>= MERGE_MIN) count — i.e. which pairs are merged that day.
  3. Reconstructs each focus member's real value on a merged day by linear
     interpolation between its nearest CLEAN (un-merged) days, and validates it:
     on a merge day the members' reconstructed values should sum to the combined
     number Spotify actually showed.

Writes NOTHING. Env: SUPABASE_URL, SUPABASE_SERVICE_KEY. Optional: FROM, TO, NAME.
"""

import os
import sys
from datetime import date
import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
FROM = os.environ.get("FROM", "2026-08-14")
TO = os.environ.get("TO", "2026-08-21")
NAME = os.environ.get("NAME", "as if it's your last").lower()
MERGE_MIN = 1_000_000
BLACKPINK_ID = "41MozSoPIsD1dJM0CLPjZF"


def sb(path, **params):
    r = httpx.get(
        f"{SUPABASE_URL}/rest/v1{path}",
        headers={"Authorization": f"Bearer {SUPABASE_KEY}", "apikey": SUPABASE_KEY},
        params=params, timeout=60,
    )
    r.raise_for_status()
    return r.json()


def fmt(n):
    return f"{n:,}" if isinstance(n, int) else str(n)


def main():
    print(f"Window {FROM} .. {TO}   focus name~{NAME!r}   (read-only)\n")

    tracks = sb("/artist_tracks", artist_id=f"eq.{BLACKPINK_ID}", select="id,name")
    id_to_name = {t["id"]: t["name"] for t in tracks}
    ref_list = ",".join(str(t["id"]) for t in tracks)

    rows = sb("/track_daily_stats",
              track_ref=f"in.({ref_list})",
              select="track_ref,date,streams,daily_delta",
              order="date.asc",
              **{"and": f"(date.gte.{FROM},date.lte.{TO})"})

    # index: streams[date][ref] = streams
    by_day = {}
    for r in rows:
        by_day.setdefault(r["date"], {})[r["track_ref"]] = r["streams"]
    days = sorted(by_day)
    if not days:
        print("No track_daily_stats rows in this window.")
        return

    # ---- 1. focus family table -------------------------------------------------
    fam = [t for t in tracks if NAME in t["name"].lower()]
    fam_ids = [t["id"] for t in fam]
    print("=== FOCUS FAMILY ===")
    for t in fam:
        print(f"  ref {t['id']}  {t['name']}")
    print()
    header = "date       " + "".join(f"| {t['id']:>10} " for t in fam)
    print(header)
    for d in days:
        cells = ""
        vals = {}
        for t in fam:
            v = by_day[d].get(t["id"])
            vals[t["id"]] = v
            cells += f"| {fmt(v):>10} " if v is not None else f"| {'—':>10} "
        # merged flag: any two family members equal (>= MERGE_MIN)
        present = [v for v in vals.values() if v is not None and v >= MERGE_MIN]
        merged = len(present) != len(set(present))
        print(f"{d} {cells} {'  <== MERGED (dup counts)' if merged else ''}")
    print()

    # ---- 2. full merge timeline across all BP tracks ---------------------------
    print("=== MERGE TIMELINE (all BLACKPINK tracks) ===")
    for d in days:
        groups = {}
        for ref, s in by_day[d].items():
            if s is not None and s >= MERGE_MIN:
                groups.setdefault(s, []).append(ref)
        merged_groups = {s: refs for s, refs in groups.items() if len(refs) > 1}
        if not merged_groups:
            print(f"  {d}: (no merged groups)")
            continue
        print(f"  {d}: {len(merged_groups)} merged group(s)")
        for s, refs in sorted(merged_groups.items(), key=lambda kv: -kv[0]):
            names = ", ".join(id_to_name.get(r, str(r)) for r in refs)
            print(f"      {fmt(s):>14}  ×{len(refs)}  →  {names}")
    print()

    # ---- 3. reconstruct merged days for each focus member ----------------------
    print("=== RECONSTRUCTION (interpolate merged days from nearest clean days) ===")

    def is_merged_day(d):
        present = [by_day[d].get(i) for i in fam_ids]
        present = [v for v in present if v is not None and v >= MERGE_MIN]
        return len(present) != len(set(present))

    merged_days = [d for d in days if is_merged_day(d)]
    clean_days = [d for d in days if not is_merged_day(d)]
    if not merged_days:
        print("  No merged days in this window — nothing to reconstruct.")
    for t in fam:
        rid = t["id"]
        series = [(d, by_day[d].get(rid)) for d in days if by_day[d].get(rid) is not None]
        if not series:
            continue
        print(f"\n  {t['name']} (ref {rid}):")
        for d in merged_days:
            before = [(dd, v) for dd, v in series if dd < d and dd in clean_days]
            after = [(dd, v) for dd, v in series if dd > d and dd in clean_days]
            shown = by_day[d].get(rid)
            if not before or not after:
                print(f"    {d}: shown {fmt(shown)} — can't reconstruct (need a clean day on both sides in window)")
                continue
            (da, va), (db, vb) = before[-1], after[0]
            span = (date.fromisoformat(db) - date.fromisoformat(da)).days
            step = (date.fromisoformat(d) - date.fromisoformat(da)).days
            est = round(va + (vb - va) * step / span)
            print(f"    {d}: shown {fmt(shown)}  →  reconstructed ~{fmt(est)}   "
                  f"(interp {da}={fmt(va)} .. {db}={fmt(vb)})")

    # validation: on each merged day, sum of reconstructed family members vs the
    # combined value Spotify showed (the shared duplicated number).
    print("\n  Validation (Σ reconstructed ≈ combined shown):")
    for d in merged_days:
        present = {}
        for ref, s in by_day[d].items():
            if s is not None and s >= MERGE_MIN:
                present.setdefault(s, []).append(ref)
        combined = max((s for s, refs in present.items() if len(refs) > 1), default=None)
        est_sum = 0
        ok = True
        for t in fam:
            rid = t["id"]
            before = [(dd, by_day[dd].get(rid)) for dd in clean_days if dd < d and by_day[dd].get(rid) is not None]
            after = [(dd, by_day[dd].get(rid)) for dd in clean_days if dd > d and by_day[dd].get(rid) is not None]
            if not before or not after:
                ok = False
                break
            (da, va), (db, vb) = before[-1], after[0]
            span = (date.fromisoformat(db) - date.fromisoformat(da)).days
            step = (date.fromisoformat(d) - date.fromisoformat(da)).days
            est_sum += round(va + (vb - va) * step / span)
        if ok and combined:
            diff = est_sum - combined
            pct = 100 * diff / combined
            print(f"    {d}: Σreconstructed={fmt(est_sum)}  vs combined shown={fmt(combined)}  "
                  f"(diff {diff:+,} = {pct:+.3f}%)")
        else:
            print(f"    {d}: not enough clean days to validate")


if __name__ == "__main__":
    main()
