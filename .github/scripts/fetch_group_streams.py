"""Daily Spotify totals for the seven K-pop girl groups, straight from Spotify.

Runs after the BLACKPINK catalog job. Reads each group's monitored track list
from data/group_catalogs/, fetches every track's play_count via spotifyscraper
(free, keyless — the same path the BLACKPINK job uses), sums, and appends a day
to the history and the CSV.

Verified before this existed: summing exactly these track IDs reproduces kworb's
published total to the digit for BLACKPINK (109/109) and ILLIT (64/64), and to
within 0.005% for the rest — where the residual was kworb being stale on a
featured track, not us being wrong. So this is not an approximation of kworb; it
is the same measurement, taken on our own schedule.

Outputs (all under data/group_streams/):
  history.json     — {date: {artist_id: {...}}}, one entry per streaming day
  history.csv      — the same rows, long format, for spreadsheets
  last_tracks.json — most recent per-track value, used to cover a failed fetch
"""

import csv
import json
import os
import sys
from datetime import date, timedelta

from spotify_scraper import SpotifyClient

CATALOG_DIR = "data/group_catalogs"
OUT_DIR = "data/group_streams"
HISTORY = os.path.join(OUT_DIR, "history.json")
CSV_PATH = os.path.join(OUT_DIR, "history.csv")
LAST_TRACKS = os.path.join(OUT_DIR, "last_tracks.json")

# Manual backfills only; normally the date is derived (see day_for).
OVERRIDE_DATE = os.environ.get("OVERRIDE_DATE")
DRY_RUN = os.environ.get("DRY_RUN", "0") == "1"
BATCH = 40

CSV_COLUMNS = ["date", "group", "artist_id", "total_streams", "daily_delta", "tracks", "note"]


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def catalogs():
    """[(name, artist_id, [track_id, ...])] — the seeded lists, in stable order."""
    out = []
    for fn in sorted(os.listdir(CATALOG_DIR)):
        if not fn.endswith(".json"):
            continue
        d = load_json(os.path.join(CATALOG_DIR, fn), None)
        if not d or not d.get("tracks"):
            print(f"  ⚠ {fn}: no tracks, skipping", file=sys.stderr)
            continue
        out.append((d["name"], d["artist_id"], [t["id"] for t in d["tracks"]]))
    return out


def playcounts(client, ids):
    got, failed = {}, []
    for i in range(0, len(ids), BATCH):
        chunk = ids[i:i + BATCH]
        try:
            results = client.get_tracks(chunk)
        except Exception as e:
            print(f"    batch failed: {e}", file=sys.stderr)
            failed.extend(chunk)
            continue
        for tid, item in zip(chunk, results):
            if not item.ok or item.result.play_count is None:
                failed.append(tid)
                continue
            got[tid] = item.result.play_count
    return got, failed


def day_for(prev_day):
    """The streaming day to label this snapshot with.

    Same rule as fetch_artist_streams.py, and for the same reason: Spotify
    publishes finalized days IN ORDER but sometimes days late, so "today - 1"
    mislabels whenever the lag isn't exactly one. A total that has changed since
    the last recorded day is therefore the next UNRECORDED day, whatever the
    current lag — and it catches up one day per run on its own."""
    if OVERRIDE_DATE:
        return OVERRIDE_DATE
    if prev_day:
        return (date.fromisoformat(prev_day) + timedelta(days=1)).isoformat()
    return (date.today() - timedelta(days=1)).isoformat()


def last_entry(history, artist_id):
    """(day, record) for this group's most recent recorded day, or (None, None)."""
    days = sorted(d for d, groups in history.items() if artist_id in groups)
    return (days[-1], history[days[-1]][artist_id]) if days else (None, None)


def open_and_final(history, artist_id):
    """(open_day, final_day, final_rec).

    open_day is a day already started while Spotify was mid-publish. Its date is
    REUSED rather than advanced past, so one streaming day cannot end up split
    across two dated rows. final_rec is the last COMPLETE day — what the delta is
    measured against, which is not the same thing as the last recorded row."""
    days = sorted(d for d, groups in history.items() if artist_id in groups)
    if not days:
        return None, None, None
    last = days[-1]
    if history[last][artist_id].get("provisional"):
        prev = days[-2] if len(days) > 1 else None
        return last, prev, (history[prev][artist_id] if prev else None)
    return None, last, history[last][artist_id]


# Share of the comparable catalogue that may sit unchanged before we treat the
# publish as unfinished. Shared with fetch_artist_streams.py, where it was
# measured against real history: 0.0% unchanged on every clean day, against
# 45.1% and 54.9% on the two rows that had to be repaired. The actual share is
# printed every run so it can be tuned from real numbers here too.
UNCHANGED_LIMIT = float(os.environ.get("UNCHANGED_LIMIT", "0.20"))
MIN_COMPARABLE = int(os.environ.get("MIN_COMPARABLE", "12"))


def publish_unfinished(got, known, failed):
    """(unfinished, unchanged, comparable) — is Spotify still working through
    this catalogue? Tracks covered by a last-known fallback are excluded: they
    are unchanged by construction, and counting them would let a bad fetch
    masquerade as a half-published day."""
    failed = set(failed)
    comparable = unchanged = 0
    for tid, v in got.items():
        if tid in failed:
            continue
        prev = known.get(tid)
        if prev is None:
            continue
        comparable += 1
        if v == prev:
            unchanged += 1
    if comparable < MIN_COMPARABLE:
        return False, unchanged, comparable
    return (unchanged / comparable) >= UNCHANGED_LIMIT, unchanged, comparable


def equal_value_groups(per_track, min_streams=1_000_000):
    """Track IDs sharing an identical large play_count — Spotify has merged them,
    and every ID in the group reports the merged figure. kworb's list is summed
    as-is (that is what reproduces its total), so this does NOT change the
    arithmetic; it records the count, because a NEW merge appearing mid-series
    would inflate the total overnight and needs to be visible when it happens."""
    by = {}
    for tid, v in per_track.items():
        if v >= min_streams:
            by.setdefault(v, []).append(tid)
    return sum(1 for ids in by.values() if len(ids) > 1)


def merge_csv_rows(existing, new_rows):
    """(rows, replaced_keys) — `new_rows` folded into the rows already on disk.

    The CSV is the durable record, so it is never rebuilt from history: one bad
    run would erase months of lines. A new day is appended exactly as before; a
    day still OPEN has its own (date, group) row replaced in place, and every
    other line is carried over untouched. Without the replace, rewriting an open
    day would append a second row for a date that already has one — which is the
    shape of the bug this whole change exists to stop."""
    rows = list(existing)
    index = {(r["date"], r["group"]): i for i, r in enumerate(rows)}
    replaced = []
    for r in sorted(new_rows, key=lambda r: (r["date"], r["group"])):
        key = (r["date"], r["group"])
        row = {k: str(r[k]) for k in CSV_COLUMNS}
        at = index.get(key)
        if at is None:
            rows.append(row)
            index[key] = len(rows) - 1
        else:
            rows[at] = row
            replaced.append(key)
    return rows, replaced


def main():
    history = load_json(HISTORY, {})
    last_tracks = load_json(LAST_TRACKS, {})
    rows_to_append = []
    wrote = []

    with SpotifyClient() as client:
        for name, aid, ids in catalogs():
            print(f"\n=== {name} [{aid}] — {len(ids)} tracks", flush=True)
            got, failed = playcounts(client, ids)

            # A failed track must never silently shorten the total: an absent
            # track and a track that lost streams look identical in a sum, and
            # one of those is a real signal we care about.
            known = last_tracks.get(aid, {})
            covered = 0
            for tid in failed:
                if tid in known:
                    got[tid] = known[tid]
                    covered += 1
            still_missing = len(failed) - covered

            total = sum(got.values())
            merged = equal_value_groups(got)
            # prev is the last COMPLETE day. When a day is still open, that is
            # the row before it — never the open row itself, or the delta would
            # be measured against a half-written day.
            open_day, prev_day, prev = open_and_final(history, aid)
            note = ""

            unfinished, unchanged, comparable = publish_unfinished(got, known, failed)
            if comparable:
                print(f"  {unchanged}/{comparable} tracks unchanged since {prev_day} "
                      f"({100.0 * unchanged / comparable:.1f}%)")

            if still_missing:
                print(f"  ⚠ {still_missing} track(s) unfetchable and no last-known value — holding")
                continue
            if covered:
                note = f"{covered} track(s) from last-known"
                print(f"  ⚠ {note}")

            if prev is None:
                day = day_for(None)
                delta = None
                print(f"  first record: {total:,} → labeling {day}")
            elif total == prev["total_streams"]:
                print(f"  unchanged at {total:,} — Spotify has not published a new day; holding")
                continue
            elif total < prev["total_streams"]:
                # The BABYMONSTER case: kworb's total for that artist fell 165M
                # in August when its scope changed. Storing a fall would corrupt
                # every subsequent delta AND every year-to-date figure derived
                # from it, silently and permanently. So refuse, and say so.
                drop = prev["total_streams"] - total
                print(f"  ✖ TOTAL FELL by {drop:,} since {prev_day} "
                      f"({prev['total_streams']:,} → {total:,}) — NOT recording. "
                      f"A drop means the catalog was re-scoped or tracks merged; "
                      f"reseed data/group_catalogs/{aid}.json before trusting this group again.")
                continue
            else:
                # A day already open stays open: reuse its date so the rest of
                # this publish lands in the SAME day instead of opening another.
                day = open_day or day_for(prev_day)
                delta = total - prev["total_streams"]
                print(f"  {total:,}  (+{delta:,} since {prev_day}) → labeling {day}"
                      + (" [rewriting the open day]" if open_day else ""))

            if unfinished and prev is not None:
                note = f"{note}; still publishing" if note else "still publishing"
                print(f"  ⏳ Spotify still publishing — {day} recorded as PROVISIONAL "
                      f"and rewritten until it completes")

            if merged:
                extra = f"{merged} merged-value group(s)"
                note = f"{note}; {extra}" if note else extra
                print(f"  note: {extra}")

            rec = {
                "total_streams": total,
                "daily_delta": delta,
                "tracks": len(got),
                "note": note,
            }
            if unfinished and prev is not None:
                rec["provisional"] = True
            history.setdefault(day, {})[aid] = rec
            rows_to_append.append({
                "date": day, "group": name, "artist_id": aid,
                "total_streams": total,
                "daily_delta": "" if delta is None else delta,
                "tracks": len(got), "note": note,
            })
            # Only a COMPLETE day advances the per-track baseline. Saving a
            # half-published run here would make the next run compare against
            # the partial state, so the stragglers still to arrive would look
            # like the whole catalogue and the day would finalise early.
            if not (unfinished and prev is not None):
                last_tracks[aid] = got
            wrote.append(f"{name} {day} {total:,}"
                         + (" (provisional)" if rec.get("provisional") else ""))

    if not rows_to_append:
        print("\nnothing new to record (every group held)")
        return
    if DRY_RUN:
        print(f"\nDRY_RUN — would record {len(rows_to_append)} row(s):")
        for w in wrote:
            print(f"  {w}")
        return

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(HISTORY, "w") as f:
        json.dump(history, f, indent=2, sort_keys=True)
        f.write("\n")
    with open(LAST_TRACKS, "w") as f:
        json.dump(last_tracks, f, sort_keys=True)
        f.write("\n")

    existing = []
    if os.path.exists(CSV_PATH):
        with open(CSV_PATH, newline="") as f:
            existing = list(csv.DictReader(f))
    merged, replaced = merge_csv_rows(existing, rows_to_append)
    for key in replaced:
        print(f"  rewrote open row {key[0]} {key[1]}")
    with open(CSV_PATH, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        w.writeheader()
        w.writerows(merged)

    print(f"\nrecorded {len(rows_to_append)} row(s):")
    for w_ in wrote:
        print(f"  {w_}")


if __name__ == "__main__":
    main()
