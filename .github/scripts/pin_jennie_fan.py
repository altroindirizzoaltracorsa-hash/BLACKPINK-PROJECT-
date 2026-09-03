"""
Pin JENNIE's artist_daily_stats to the BPxSpotify fan account's numbers.

The fan account's absolute total runs ~5.29M above our own scrape (constant
snapshot-timing offset), while its daily gains match ours within ~3K. Per the
user's choice, display the fan's totals. To avoid a mid-week spike, the one-time
baseline lift is absorbed on Aug 28 (EP release day, where a big jump is
natural); pre-EP days (<= Aug 27) are left untouched, and each row stays
self-consistent (daily == total - prev) so nothing flags "recount".

  Aug 30 daily = 9,672,090 - 544,673  = 9,127,417   (fan tweet's change column)
  Aug 31       = 8,437,940,760 / +9,672,090          (fan tweet, verbatim)

Note: this is a manual pin. The nightly scrape rebuilds JENNIE's total from her
per-track sums (~5.29M lower), so the next automatic run (Sep 2+) will show a
one-day dip back to our baseline and will need re-pinning if the fan total is to
stay the displayed source of truth. Dry-run unless APPLY=1.
"""

import os
import sys

import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
APPLY = bool(os.environ.get("APPLY"))

JENNIE_ID = "250b0Wlc5Vk0CoUsaCY84M"
AUG27 = "2026-08-27"

# Target chain (total, daily). Aug 30/31 are the fan's exact figures; Aug 29 &
# Sep 1 keep our measured dailies; Aug 28 absorbs the baseline lift.
TARGET = [
    ("2026-08-28", 8_409_208_750, 16_704_277),
    ("2026-08-29", 8_419_141_253, 9_932_503),
    ("2026-08-30", 8_428_268_670, 9_127_417),
    ("2026-08-31", 8_437_940_760, 9_672_090),
    ("2026-09-01", 8_447_098_741, 9_157_981),   # fan tweet (Sep 01), verbatim
]
AUG27_EXPECTED = 8_392_504_473   # anchor; Aug 28 daily chains onto this


def sb(method, path, **kwargs):
    headers = {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
        **kwargs.pop("headers", {}),
    }
    r = httpx.request(method, f"{SUPABASE_URL}/rest/v1{path}", headers=headers, timeout=30, **kwargs)
    if r.is_error:
        print(f"  Supabase error body: {r.text}", file=sys.stderr)
    r.raise_for_status()
    return r.json() if r.content else None


def get_row(date):
    rows = sb("GET", "/artist_daily_stats", params={
        "artist_id": f"eq.{JENNIE_ID}", "date": f"eq.{date}",
        "select": "date,total_streams,daily_delta",
    })
    return rows[0] if rows else None


def main():
    aug27 = get_row(AUG27)
    if not aug27:
        print("FATAL: missing Aug 27 anchor row", file=sys.stderr)
        sys.exit(1)
    print(f"Aug 27 anchor: total={aug27['total_streams']:,} (expected {AUG27_EXPECTED:,})")
    if aug27["total_streams"] != AUG27_EXPECTED:
        print("  !! Aug 27 anchor differs from expected; Aug 28 daily would not chain. Aborting.",
              file=sys.stderr)
        sys.exit(1)

    prev_total = aug27["total_streams"]
    ok = True
    for date, total, daily in TARGET:
        cur = get_row(date)
        chain = total - prev_total
        flag = "" if chain == daily else f"  !! chain {chain:,} != daily {daily:,}"
        if chain != daily:
            ok = False
        cur_str = f"{cur['total_streams']:,}/{(cur['daily_delta'] or 0):,}" if cur else "—"
        print(f"{date}: current {cur_str:<28} -> {total:,}/{daily:+,}{flag}")
        prev_total = total

    if not ok:
        print("\nFATAL: target chain is internally inconsistent; aborting.", file=sys.stderr)
        sys.exit(1)

    if APPLY:
        for date, total, daily in TARGET:
            sb("PATCH", "/artist_daily_stats",
               params={"artist_id": f"eq.{JENNIE_ID}", "date": f"eq.{date}"},
               json={"total_streams": total, "daily_delta": daily})
            print(f"  patched {date}: {total:,} / {daily:+,}")
        print("\n-> done: JENNIE pinned to fan totals (Aug 28 - Sep 1), chain consistent.")
    else:
        print("\n-> dry-run (set APPLY=1 to write).")


if __name__ == "__main__":
    main()
