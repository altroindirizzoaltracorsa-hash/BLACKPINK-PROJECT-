"""
One-off: pin JENNIE's Aug 31 + Sep 1 artist_daily_stats to the two sources the
user chose, verbatim:

  Aug 31  ->  BPxSpotify fan account:  total 8,437,940,760, daily +9,672,090
  Sep 1   ->  jenniecharts.com (JGC):  total 8,441,429,322, daily +7,973,242

NOTE / caveat: these two sources do not chain. Sep 1 total - Aug 31 total
= 8,441,429,322 - 8,437,940,760 = 3,488,562, which is NOT JGC's stated Sep 1
daily of +7,973,242. So with the values written verbatim the streams page's
consistency check (daily_delta == total - prev_total) will flag Sep 1 as a
"recount" mismatch. That is expected and is what the user asked for; the
alternative would be to override Sep 1's displayed daily to 3,488,562, which
would contradict JGC.

Only total_streams + daily_delta are PATCHed. Dry-run unless APPLY=1.
"""

import os
import sys

import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
APPLY = bool(os.environ.get("APPLY"))

JENNIE_ID = "250b0Wlc5Vk0CoUsaCY84M"
SEP1, AUG31, AUG30 = "2026-09-01", "2026-08-31", "2026-08-30"

AUG31_TOTAL = 8_437_940_760     # BPxSpotify fan account
AUG31_DAILY = 9_672_090         # BPxSpotify fan account
SEP1_TOTAL = 8_441_429_322      # jenniecharts.com (JGC)
SEP1_DAILY = 7_973_242          # jenniecharts.com (JGC)


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
    aug30 = get_row(AUG30)
    aug31 = get_row(AUG31)
    sep1 = get_row(SEP1)
    if not (aug30 and aug31 and sep1):
        print("FATAL: missing one of Aug 30 / Aug 31 / Sep 1 rows", file=sys.stderr)
        sys.exit(1)

    print(f"Aug 30 (anchor): total={aug30['total_streams']:,}")
    print(f"Aug 31:  current total={aug31['total_streams']:>15,} daily={aug31['daily_delta']:>12,}")
    print(f"         target  total={AUG31_TOTAL:>15,} daily={AUG31_DAILY:>12,}   (BPxSpotify fan)")
    print(f"Sep 1:   current total={sep1['total_streams']:>15,} daily={sep1['daily_delta']:>12,}")
    print(f"         target  total={SEP1_TOTAL:>15,} daily={SEP1_DAILY:>12,}   (jenniecharts / JGC)")

    computed_sep1_daily = SEP1_TOTAL - AUG31_TOTAL
    print(f"\nConsistency check: Sep1_total - Aug31_total = {computed_sep1_daily:,}")
    if computed_sep1_daily != SEP1_DAILY:
        print(f"  !! differs from JGC daily {SEP1_DAILY:,} -> streams page will flag Sep 1 'recount'")
        print("     (expected: the two sources don't chain; values written verbatim as requested)")

    if APPLY:
        patch(AUG31, AUG31_TOTAL, AUG31_DAILY)
        patch(SEP1, SEP1_TOTAL, SEP1_DAILY)
        print("\n-> written: Aug 31 = fan account, Sep 1 = JGC (both verbatim).")
    else:
        print("\n-> dry-run (set APPLY=1 to write).")


if __name__ == "__main__":
    main()
