"""
Rebuild JENNIE's artist_daily_stats the correct way: the artist total is just
the sum of her per-track rows (Spotify-merged duplicates collapsed), and the
daily delta is today's sum minus yesterday's. No external whole-catalog pin.

This undoes the earlier "pin to kworb / fan / JGC" hacks. The Fallen Angel EP
(Fallen Angel + Heaven, on top of the already-counted Less than a Lover) simply
adds its real per-track numbers into the sum, chained from the pre-EP Aug 27
anchor -- i.e. "previous total + Heaven + Fallen Angel", which is what it should
have been all along.

MODE:
  diag  (default) -- read-only. Dumps, per day: stored artist total/delta, the
        recomputed merged sum of per-track rows, the row count, and the 3 EP
        track rows vs the authoritative card values. Writes nothing.
  apply (APPLY=1) -- pins the 3 EP track rows to the card values (idempotent if
        they already match), then recomputes + PATCHes the artist total/delta
        for Aug 28 - Sep 1 from the per-track sums.
"""

import os
import sys
from datetime import date, timedelta

import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
APPLY = bool(os.environ.get("APPLY"))

JENNIE_ID = "250b0Wlc5Vk0CoUsaCY84M"
MERGE_MIN = 1_000_000

# Window: Aug 27 is the pre-EP anchor (untouched); Aug 28 - Sep 1 get rebuilt.
ANCHOR = "2026-08-27"
REBUILD = ["2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01"]
DUMP = ["2026-08-26", ANCHOR] + REBUILD

# Authoritative EP per-track figures (BPxSpotify / JGC cards), keyed by Spotify ID.
# (total, daily) -- daily None on release day (Aug 28).
CARDS = {
    "75QkBCdRc5DGgcyPiVSg4b": {  # Fallen Angel
        "2026-08-28": (1_507_295, None),
        "2026-08-29": (2_764_813, 1_257_518),
        "2026-08-30": (3_888_497, 1_123_684),
        "2026-08-31": (5_113_793, 1_225_296),
        "2026-09-01": (6_289_713, 1_175_920),
    },
    "6uhCnqc4Tncn1vqkuGubPO": {  # Heaven
        "2026-08-28": (1_601_452, None),
        "2026-08-29": (2_628_088, 1_026_636),
        "2026-08-30": (3_477_152, 849_064),
        "2026-08-31": (4_441_006, 963_854),
        "2026-09-01": (5_252_024, 811_018),
    },
    "19UnXjpLshSLobPspdyxlD": {  # Less than a Lover
        "2026-08-28": (49_910_241, 1_407_396),
        "2026-08-29": (51_035_545, 1_125_304),
        "2026-08-30": (52_021_723, 986_178),
        "2026-08-31": (53_003_552, 981_829),
        "2026-09-01": (53_828_685, 825_133),
    },
}
EP_NAME = {
    "75QkBCdRc5DGgcyPiVSg4b": "Fallen Angel",
    "6uhCnqc4Tncn1vqkuGubPO": "Heaven",
    "19UnXjpLshSLobPspdyxlD": "Less than a Lover",
}


def sb(method, path, **kwargs):
    headers = {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
        **kwargs.pop("headers", {}),
    }
    r = httpx.request(method, f"{SUPABASE_URL}/rest/v1{path}", headers=headers, timeout=60, **kwargs)
    if r.is_error:
        print(f"  Supabase error body: {r.text}", file=sys.stderr)
    r.raise_for_status()
    return r.json() if r.content else None


def merged_total(streams):
    """Sum of stream values with Spotify-merged duplicates (equal value >= MERGE_MIN
    shared by >1 track) counted once. Mirrors collapse_merged() in
    fetch_artist_streams.py for the artist TOTAL."""
    groups = {}
    for s in streams:
        if s is None:
            continue
        groups[s] = groups.get(s, 0) + 1
    total = 0
    for val, cnt in groups.items():
        total += val if (cnt > 1 and val >= MERGE_MIN) else val * cnt
    return total


def main():
    # Jennie's track refs and Spotify-id -> ref map.
    at_rows = sb("GET", "/artist_tracks", params={
        "artist_id": f"eq.{JENNIE_ID}", "select": "id,name,source_track_ids",
    })
    ids = [str(r["id"]) for r in at_rows]
    spid_to_ref = {}
    for r in at_rows:
        for spid in (r.get("source_track_ids") or []):
            spid_to_ref[spid] = str(r["id"])
    ref_to_name = {str(r["id"]): r["name"] for r in at_rows}
    print(f"JENNIE has {len(ids)} artist_tracks rows\n")

    # All track rows for the dump window, grouped by date.
    rows = sb("GET", "/track_daily_stats", params={
        "track_ref": f"in.({','.join(ids)})",
        "date": f"in.({','.join(DUMP)})",
        "select": "track_ref,date,streams,daily_delta",
    })
    by_date = {}
    for r in rows:
        by_date.setdefault(r["date"], []).append(r)

    # Stored artist rows.
    arts = sb("GET", "/artist_daily_stats", params={
        "artist_id": f"eq.{JENNIE_ID}",
        "date": f"in.({','.join(DUMP)})",
        "select": "date,total_streams,daily_delta",
    })
    art_by_date = {a["date"]: a for a in arts}

    print(f"{'Date':<12}{'stored total':>16}{'stored daily':>14}{'merged sum':>16}{'diff':>12}{'#rows':>7}")
    recomputed = {}
    for d in DUMP:
        trows = by_date.get(d, [])
        msum = merged_total([t["streams"] for t in trows])
        recomputed[d] = msum
        a = art_by_date.get(d)
        st = a["total_streams"] if a else None
        sd = a["daily_delta"] if a else None
        diff = (st - msum) if st is not None else None
        print(f"{d:<12}{(st if st is not None else 0):>16,}{(sd if sd is not None else 0):>14,}"
              f"{msum:>16,}{(diff if diff is not None else 0):>12,}{len(trows):>7}")

    # EP tracks: stored vs card.
    print("\nEP per-track rows (stored streams/delta  vs  card):")
    for spid, name in EP_NAME.items():
        ref = spid_to_ref.get(spid)
        print(f"  {name}  (ref={ref})")
        for d in REBUILD:
            card = CARDS[spid].get(d)
            stored = next((t for t in by_date.get(d, []) if str(t["track_ref"]) == ref), None)
            s_str = f"{stored['streams']:,}/{(stored['daily_delta'] or 0):,}" if stored else "—"
            c_str = f"{card[0]:,}/{(card[1] or 0):,}" if card else "—"
            flag = "" if (stored and card and stored["streams"] == card[0]) else "  <-- differs"
            print(f"    {d}: stored {s_str:<24} card {c_str}{flag}")

    # Rebuilt artist chain (from merged sums), anchored at Aug 27.
    print("\nRebuilt artist total/daily (merged sum of per-track rows, chained from Aug 27):")
    for d in REBUILD:
        prev = (date.fromisoformat(d) - timedelta(days=1)).isoformat()
        delta = recomputed[d] - recomputed[prev]
        print(f"  {d}: total={recomputed[d]:>16,}  daily={delta:>+13,}")

    if not APPLY:
        print("\n-> diag only (set APPLY=1 to pin EP track rows + rebuild artist totals).")
        return

    # 1) Pin the 3 EP track rows to the card values.
    track_writes = []
    for spid, per_day in CARDS.items():
        ref = spid_to_ref.get(spid)
        if not ref:
            print(f"FATAL: no artist_tracks ref for {EP_NAME[spid]} ({spid})", file=sys.stderr)
            sys.exit(1)
        for d, (tot, dly) in per_day.items():
            track_writes.append({"track_ref": ref, "date": d, "streams": tot, "daily_delta": dly})
    sb("POST", "/track_daily_stats",
       params={"on_conflict": "track_ref,date"},
       headers={"Prefer": "resolution=merge-duplicates"},
       json=track_writes)
    print(f"\n-> pinned {len(track_writes)} EP track rows to card values.")

    # 2) Re-read the rebuild window (now with pinned EP values) and recompute totals.
    rows2 = sb("GET", "/track_daily_stats", params={
        "track_ref": f"in.({','.join(ids)})",
        "date": f"in.({','.join([ANCHOR] + REBUILD)})",
        "select": "track_ref,date,streams",
    })
    by_date2 = {}
    for r in rows2:
        by_date2.setdefault(r["date"], []).append(r)
    sums = {d: merged_total([t["streams"] for t in by_date2.get(d, [])]) for d in [ANCHOR] + REBUILD}

    for d in REBUILD:
        prev = (date.fromisoformat(d) - timedelta(days=1)).isoformat()
        total = sums[d]
        delta = sums[d] - sums[prev]
        sb("PATCH", "/artist_daily_stats",
           params={"artist_id": f"eq.{JENNIE_ID}", "date": f"eq.{d}"},
           json={"total_streams": total, "daily_delta": delta})
        print(f"   patched {d}: total={total:,} daily={delta:+,}")
    print("\n-> done: artist totals rebuilt from per-track sums (no external pin, no recount).")


if __name__ == "__main__":
    main()
