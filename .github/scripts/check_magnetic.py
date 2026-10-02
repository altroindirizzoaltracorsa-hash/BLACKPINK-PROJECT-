"""Magnetic's daily streams, three ways, so the per-track series can be trusted.

READ-ONLY. Writes nothing, anywhere.

The point is accuracy on one specific number. "Magnetic" exists on Spotify as
FIVE separate track IDs — the original, a Sped Up version, and three remixes —
so "Magnetic's streams" is ambiguous unless you say which IDs are in it. Summing
all five reads ~32M higher than the original, and a "fastest to 1B" style figure
built on the sum reaches the milestone sooner than the song actually does. This
prints the original and the sum side by side rather than picking one silently.

Three independent readings, because any one of them can be wrong on a given day:

  1. kworb's published per-track table — an outside party counting the same
     Spotify figures, with its own "Daily" column and its own "Last updated" day.
     Our totals have already been verified identical to kworb's per track, so a
     disagreement here means one of us is looking at a different day.
  2. spotifyscraper, live — the same path fetch_group_streams.py uses, right now.
  3. group_track_daily_stats — what we have actually recorded, with the
     daily_delta we computed, and the merged_with / stale flags that say whether
     the figure is this track's alone and whether we really saw it.

A days-to-1B projection comes out of (1) and (3), separately for the original and
for the five summed, so the difference between the two is on the page rather than
hidden in the arithmetic.

Env: SUPABASE_URL / SUPABASE_SERVICE_KEY optional (section 3 is skipped without
them). ARTIST_ID and TRACK_MATCH override the group and the title match.
"""

import json
import os
import re
import statistics
import sys
from datetime import date

import httpx
from spotify_scraper import SpotifyClient

ARTIST_ID = os.environ.get("ARTIST_ID", "36cgvBn0aadzOijnjjwqMN")       # ILLIT
TRACK_MATCH = os.environ.get("TRACK_MATCH", "magnetic").lower()
CATALOG = f"data/group_catalogs/{ARTIST_ID}.json"
TARGET = 1_000_000_000

# How many recorded days to read back. A span rate wants a long enough base that
# one smeared label barely moves it; 28 days is two full weeks past the point
# where that matters and still a small query.
WINDOW = int(os.environ.get("WINDOW", "28"))

# A daily delta this many times the median is not one day — it is two publishes
# landing in one row, which is what a 0-delta neighbour above it means.
MULTI_DAY = 1.75

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")


def strip_tags(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]*>", "", s)).strip()


def kworb_rows(artist_id):
    """-> (day, {track_id: {name, feature, streams, daily}}). kworb's own table."""
    url = f"https://kworb.net/spotify/artist/{artist_id}_songs.html"
    r = httpx.get(url, timeout=60, headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    html = r.text
    m = re.search(r"Last updated:\s*(\d{4}/\d{2}/\d{2})", html)
    day = m.group(1) if m else None
    out = {}
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S):
        cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S)
        if not cells:
            continue
        texts = [strip_tags(c) for c in cells]
        tm = re.search(r"track/([0-9A-Za-z]{22})", cells[0])
        if not tm:
            continue
        nums = [int(re.sub(r"[^\d]", "", t)) for t in texts[1:] if re.sub(r"[^\d]", "", t)]
        if not nums:
            continue
        out[tm.group(1)] = {
            "name": texts[0].lstrip("*").strip(),
            "feature": texts[0].strip().startswith("*"),
            "streams": nums[0],
            # Streams | Daily. Absent on a track kworb has no daily figure for.
            "daily": nums[1] if len(nums) > 1 else None,
        }
    return day, out


def sb(path, params):
    headers = {"Authorization": f"Bearer {SUPABASE_KEY}", "apikey": SUPABASE_KEY}
    r = httpx.get(f"{SUPABASE_URL}/rest/v1{path}", headers=headers, params=params, timeout=30)
    if r.is_error:
        print(f"  Supabase error body: {r.text}", file=sys.stderr)
    r.raise_for_status()
    return r.json()


def fmt(n):
    return "—" if n is None else f"{n:,}"


def projection(label, streams, per_day):
    """Days from today to 1B at this rate. Prints nothing it cannot support."""
    if streams is None or not per_day or per_day <= 0:
        print(f"  {label}: no rate available")
        return
    if streams >= TARGET:
        print(f"  {label}: already past 1B ({fmt(streams)})")
        return
    left = TARGET - streams
    print(f"  {label}: {fmt(left)} to go at {fmt(int(per_day))}/day "
          f"→ {left / per_day:.0f} more days")


def main():
    cat = json.load(open(CATALOG))
    tracks = [t for t in cat["tracks"] if TRACK_MATCH in t["name"].lower()]
    if not tracks:
        sys.exit(f"no track in {CATALOG} matches {TRACK_MATCH!r}")
    ids = [t["id"] for t in tracks]
    # The original is the shortest title among the matches — every other version
    # is the same title plus a suffix ("- Sped Up", "(Starlight Remix)").
    original = min(tracks, key=lambda t: len(t["name"]))
    print(f"{cat['name']} — {len(tracks)} track(s) matching {TRACK_MATCH!r}; "
          f"treating {original['name']!r} [{original['id']}] as the original\n")

    print("=" * 78)
    print("1. kworb's published table")
    print("=" * 78)
    kday, krows = None, {}
    try:
        kday, krows = kworb_rows(ARTIST_ID)
        print(f"  kworb Last updated: {kday}")
        print(f"  {'track id':<24} {'streams':>14} {'daily':>12}  name")
        for t in tracks:
            k = krows.get(t["id"])
            if not k:
                print(f"  {t['id']:<24} {'not listed':>14} {'—':>12}  {t['name']}")
                continue
            print(f"  {t['id']:<24} {fmt(k['streams']):>14} {fmt(k['daily']):>12}  {k['name']}")
        listed = [krows[t["id"]] for t in tracks if t["id"] in krows]
        if listed:
            print(f"  {'ALL VERSIONS SUMMED':<24} "
                  f"{fmt(sum(k['streams'] for k in listed)):>14} "
                  f"{fmt(sum(k['daily'] or 0 for k in listed)):>12}")
    except Exception as e:
        print(f"  ⚠ kworb unavailable: {e}")

    print()
    print("=" * 78)
    print("2. spotifyscraper, live — the path the daily job uses")
    print("=" * 78)
    live = {}
    try:
        with SpotifyClient() as client:
            for item, t in zip(client.get_tracks(ids), tracks):
                if item.ok and item.result.play_count is not None:
                    live[t["id"]] = item.result.play_count
        for t in tracks:
            v = live.get(t["id"])
            k = (krows.get(t["id"]) or {}).get("streams")
            diff = "" if (v is None or k is None) else f"  (kworb {v - k:+,})"
            print(f"  {t['id']:<24} {fmt(v):>14}  {t['name']}{diff}")
        if live:
            print(f"  {'ALL VERSIONS SUMMED':<24} {fmt(sum(live.values())):>14}")
    except Exception as e:
        print(f"  ⚠ spotifyscraper unavailable: {e}")

    print()
    print("=" * 78)
    print("3. what WE have recorded (group_track_daily_stats)")
    print("=" * 78)
    rate = {}
    if not (SUPABASE_URL and SUPABASE_KEY):
        print("  SUPABASE_URL/SUPABASE_SERVICE_KEY unset — skipped")
    else:
        try:
            refs = sb("/group_tracks", {"track_id": f"in.({','.join(ids)})",
                                        "select": "id,track_id,name"})
            if not refs:
                print("  no rows yet — the per-track table is populated by the next "
                      "fetch-catalog run that records a day")
            for ref in refs:
                rows = sb("/group_track_daily_stats", {
                    "track_ref": f"eq.{ref['id']}", "order": "date.desc",
                    "limit": str(WINDOW),
                    "select": "date,streams,daily_delta,merged_with,stale"})
                print(f"\n  {ref['name']} [{ref['track_id']}] — {len(rows)} recorded day(s)")
                if rows:
                    print(f"    {'date':<12} {'streams':>14} {'daily':>12}  flags")
                usable = [r for r in rows if not r["stale"] and not r["merged_with"]]
                deltas = [r["daily_delta"] for r in usable if r["daily_delta"]]
                med = statistics.median(deltas) if deltas else 0
                for r in rows:
                    flags = []
                    if r["merged_with"]:
                        flags.append(f"MERGED with {r['merged_with']} other id(s) "
                                     f"— this figure is not this track's alone")
                    if r["stale"]:
                        flags.append("STALE — carried from last-known, not observed")
                    d = r["daily_delta"]
                    if d == 0:
                        flags.append("NO MOVEMENT — a day recorded before the hold "
                                     "rule existed; its streams land on the next row")
                    elif d and med and d > MULTI_DAY * med:
                        flags.append(f"{d / med:.1f}x the median — two publishes in "
                                     f"one row, not one day")
                    print(f"    {r['date']:<12} {fmt(r['streams']):>14} "
                          f"{fmt(d):>12}  {'; '.join(flags)}")

                # The rate comes from the SPAN, not from averaging the deltas, and
                # the output above is why. A 0 day followed by a 2x day is one
                # two-day publish smeared across two rows (visible here on 23/24
                # Sep and 17 Sep), and averaging counts the 2x at full weight while
                # the 0 drags nothing back — on Magnetic that reads 673,471/day
                # against a true ~581,000, a 16% overstatement that then shortens
                # the 1B projection by nearly 40 days. Cumulative totals do not
                # have that problem: streams gained between the oldest and newest
                # observed row, over the calendar days between them, is correct
                # however the labels in between are smeared, and a missing day in
                # the middle costs nothing because the totals are cumulative.
                #
                # One thing DOES break a span: a merge. A smeared label moves
                # streams between rows and the endpoints still bracket the same
                # real streams, but when Spotify folds another version in, the
                # cumulative figure takes a permanent step up that was never
                # played in that window — so a span crossing a merge overstates
                # the rate for as long as it stays in the window. Timing artifacts
                # are tolerated; a level shift is not, so the span starts after
                # the newest merged row.
                merged_rows = [r for r in rows if r["merged_with"]]
                floor = max((r["date"] for r in merged_rows), default=None)
                if floor:
                    usable = [r for r in usable if r["date"] > floor]
                    print(f"    merge at {floor} — the rate below starts after it, "
                          f"since a merged figure steps the total up permanently")
                if len(usable) >= 2:
                    new, old = usable[0], usable[-1]
                    span = (date.fromisoformat(new["date"])
                            - date.fromisoformat(old["date"])).days
                    if span > 0:
                        rate[ref["track_id"]] = (new["streams"] - old["streams"]) / span
                        print(f"    rate over the {span}-day span "
                              f"{old['date']} → {new['date']}: "
                              f"{fmt(int(rate[ref['track_id']]))}/day")
                        if deltas:
                            print(f"      (median of the daily deltas: "
                                  f"{fmt(int(med))} — mean would be "
                                  f"{fmt(int(sum(deltas) / len(deltas)))}, inflated "
                                  f"by any two-publish row above)")
                if ref["track_id"] not in rate:
                    print("    no clean day yet — no rate from our own data")
        except Exception as e:
            print(f"  ⚠ Supabase read failed: {e}")

    print()
    print("=" * 78)
    print(f"4. days to {TARGET:,} — the original alone vs. every version summed")
    print("=" * 78)
    oid = original["id"]
    ko = krows.get(oid) or {}
    print(" from kworb's daily column:")
    projection(f"{original['name']} alone", ko.get("streams"), ko.get("daily"))
    listed = [krows[t["id"]] for t in tracks if t["id"] in krows]
    if listed:
        projection("all versions summed",
                   sum(k["streams"] for k in listed),
                   sum(k["daily"] or 0 for k in listed))
    print(" from our own recorded span (streams gained / calendar days):")
    projection(f"{original['name']} alone", live.get(oid) or ko.get("streams"), rate.get(oid))
    if rate:
        projection("all versions summed",
                   sum(live.values()) if live else None,
                   sum(rate.values()) if len(rate) == len(tracks) else None)
    print("\n  The two lines are different songs' worth of streams. A 'fastest to 1B'\n"
          "  figure normally means the original alone; the summed line reaches the\n"
          "  milestone earlier because it is counting the remixes too.")


if __name__ == "__main__":
    main()
