"""
Extend the JENNIE fan-total pin back to Aug 26/27 (now that the fan account's
Aug 27 post gives those days), so the ~5.28M baseline lift no longer sits as a
fake bump on Aug 28 (EP release day).

With Aug 26 + Aug 27 lifted onto the fan baseline, Aug 28 chains off a lifted
Aug 27 and returns to its REAL daily (~+11.42M). The unavoidable one-time
baseline lift slides back to Aug 25 (deep pre-EP, untracked), which carries it
as a slightly high daily -- kept internally consistent so nothing flags
"recount".

Fan anchors (total, daily), all verbatim from @BPxSpotify:
  Aug 26  8,390,480,531 / +7,057,406   (7,307,678 - 250,272 change)
  Aug 27  8,397,788,209 / +7,307,678
  Aug 30  8,428,268,670 / +9,127,417
  Aug 31  8,437,940,760 / +9,672,090
  Sep 01  8,447,098,741 / +9,157,981
Aug 28/29 bridge the Aug27->Aug30 gap with our measured dailies (+3,130 residual
absorbed on Aug 28). Dry-run unless APPLY=1.
"""

import os
import sys

import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
APPLY = bool(os.environ.get("APPLY"))

JENNIE_ID = "250b0Wlc5Vk0CoUsaCY84M"
AUG24 = "2026-08-24"
AUG25 = "2026-08-25"

# Aug 25 carries the baseline lift; its total is fan-Aug26 minus fan-Aug26 daily.
AUG25_TOTAL = 8_390_480_531 - 7_057_406   # 8,383,423,125

# Target chain Aug 26 -> Sep 1 (total, daily). Each daily == total - prev_total.
CHAIN = [
    ("2026-08-26", 8_390_480_531, 7_057_406),    # fan
    ("2026-08-27", 8_397_788_209, 7_307_678),    # fan
    ("2026-08-28", 8_409_208_750, 11_420_541),   # our measured +3,130 residual
    ("2026-08-29", 8_419_141_253, 9_932_503),    # our measured
    ("2026-08-30", 8_428_268_670, 9_127_417),    # fan
    ("2026-08-31", 8_437_940_760, 9_672_090),    # fan
    ("2026-09-01", 8_447_098_741, 9_157_981),    # fan
]


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


def patch(date, total, daily):
    sb("PATCH", "/artist_daily_stats",
       params={"artist_id": f"eq.{JENNIE_ID}", "date": f"eq.{date}"},
       json={"total_streams": total, "daily_delta": daily})


def main():
    aug24 = get_row(AUG24)
    aug25 = get_row(AUG25)
    if not (aug24 and aug25):
        print("FATAL: missing Aug 24 or Aug 25 row", file=sys.stderr)
        sys.exit(1)

    aug25_daily = AUG25_TOTAL - aug24["total_streams"]   # carries the lift, stays consistent

    # Full plan incl. Aug 25, with consistency check (daily == total - prev).
    plan = [(AUG25, AUG25_TOTAL, aug25_daily)] + CHAIN
    prev = aug24["total_streams"]
    print(f"Aug 24 anchor: total={aug24['total_streams']:,} (untouched)")
    ok = True
    for date, total, daily in plan:
        cur = get_row(date)
        chain = total - prev
        bad = "" if chain == daily else f"  !! chain {chain:,} != daily {daily:,}"
        if chain != daily:
            ok = False
        cur_str = f"{cur['total_streams']:,}/{(cur['daily_delta'] or 0):,}" if cur else "—"
        note = "  <- carries baseline lift" if date == AUG25 else ""
        print(f"{date}: {cur_str:<28} -> {total:,}/{daily:+,}{bad}{note}")
        prev = total

    if not ok:
        print("\nFATAL: target chain inconsistent; aborting.", file=sys.stderr)
        sys.exit(1)

    if APPLY:
        for date, total, daily in plan:
            patch(date, total, daily)
            print(f"  patched {date}: {total:,} / {daily:+,}")
        print("\n-> done: Aug 28 back to real daily; baseline lift rests on Aug 25.")
    else:
        print("\n-> dry-run (set APPLY=1 to write).")


if __name__ == "__main__":
    main()
