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

And, when SUPABASE_URL / SUPABASE_SERVICE_KEY are set, the PER-TRACK detail into
group_tracks + group_track_daily_stats. Every track is already fetched
individually — that is how the total is built — so keeping the detail costs no
extra request; throwing it away is what made "how fast is ILLIT's Magnetic
actually moving" unanswerable from our own data. Supabase is strictly additive
here: the committed files above are written FIRST and a Supabase failure cannot
touch them.
"""

import csv
import json
import os
import sys
from datetime import date, timedelta

import httpx
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

# Optional on purpose: unset means "write the files, skip the per-track rows".
# This job's committed output predates Supabase and must keep working without it
# — a missing secret is a gap in the new detail, not a broken daily record.
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")

CSV_COLUMNS = ["date", "group", "artist_id", "total_streams", "daily_delta", "tracks", "note"]


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def catalogs():
    """[(name, artist_id, [{id, name, feature}, ...])] — the seeded lists, in
    stable order. The full track dicts are carried, not just the IDs, because
    the per-track rows need the title and the feature flag."""
    out = []
    for fn in sorted(os.listdir(CATALOG_DIR)):
        if not fn.endswith(".json"):
            continue
        d = load_json(os.path.join(CATALOG_DIR, fn), None)
        if not d or not d.get("tracks"):
            print(f"  ⚠ {fn}: no tracks, skipping", file=sys.stderr)
            continue
        out.append((d["name"], d["artist_id"], d["tracks"]))
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


# Below this, an identical play_count across two IDs is coincidence (plenty of
# obscure tracks sit on the same small number), not evidence of a merge.
MERGE_MIN = 1_000_000


def equal_value_ids(per_track, min_streams=MERGE_MIN):
    """{play_count: [track_id, ...]} for values shared by more than one ID.

    Spotify sometimes serves several versions of a song as one merged count, and
    when it does every ID in the group returns the same number. kworb's list is
    summed as-is (that is what reproduces its total), so this does NOT change the
    arithmetic — but a per-track reading has to know, or five IDs reporting one
    merged figure read as five separate songs."""
    by = {}
    for tid, v in per_track.items():
        if v >= min_streams:
            by.setdefault(v, []).append(tid)
    return {v: ids for v, ids in by.items() if len(ids) > 1}


def equal_value_groups(per_track, min_streams=MERGE_MIN):
    """How many merged value-groups this catalogue shows. Recorded on the day
    row because a NEW merge appearing mid-series would inflate the total
    overnight and needs to be visible when it happens."""
    return len(equal_value_ids(per_track, min_streams))


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


def upsert_group_tracks(artist_id, tracks):
    """Upserts group_tracks from the seeded catalogue, returns {track_id: ref}."""
    rows = [
        {
            "artist_id": artist_id,
            "track_id": t["id"],
            "name": t.get("name"),
            "feature": bool(t.get("feature")),
        }
        for t in tracks
    ]
    result = sb(
        "POST", "/group_tracks",
        params={"on_conflict": "track_id"},
        headers={"Prefer": "resolution=merge-duplicates,return=representation"},
        json=rows,
    )
    return {row["track_id"]: row["id"] for row in result}


def store_per_track(name, artist_id, day, tracks, got, known, failed):
    """Writes one day of per-track rows. Returns the number of rows written.

    `known` is the PRE-RUN baseline (the last complete day's per-track snapshot),
    so daily_delta is measured against the same thing the group total's delta is.
    `failed` are the tracks whose value was carried forward from that baseline —
    flagged `stale`, because their delta is 0 by construction and a rate
    calculation must not read that as "it did not move"."""
    refs = upsert_group_tracks(artist_id, tracks)
    merged = equal_value_ids(got)
    failed = set(failed)
    rows = []
    for tid, v in got.items():
        ref = refs.get(tid)
        if ref is None:          # not in the catalogue we just upserted
            continue
        prev = known.get(tid)
        rows.append({
            "track_ref": ref,
            "date": day,
            "streams": v,
            "daily_delta": None if prev is None else v - prev,
            "merged_with": len(merged.get(v, [])) - 1 if v in merged else 0,
            "stale": tid in failed,
        })
    for i in range(0, len(rows), 200):
        sb(
            "POST", "/group_track_daily_stats",
            params={"on_conflict": "track_ref,date"},
            headers={"Prefer": "resolution=merge-duplicates"},
            json=rows[i:i + 200],
        )
    return len(rows)


def push_per_track(pending):
    """Per-track rows for every day recorded this run. Called AFTER the committed
    files are written, and every group is isolated: Supabase being down costs the
    per-track detail for that day and nothing else. Nothing downstream breaks —
    the next day's daily_delta is measured against last_tracks.json, not against
    Supabase, so a lost day leaves one hole in `streams` and every later delta is
    still right. Re-filling the hole needs OVERRIDE_DATE, since an ordinary run
    only ever records the next UNrecorded day."""
    if not pending:
        return
    if not (SUPABASE_URL and SUPABASE_KEY):
        print("\nSUPABASE_URL/SUPABASE_SERVICE_KEY unset — per-track rows not stored "
              "(the committed files above are unaffected)")
        return
    print("\nper-track rows:")
    for p in pending:
        try:
            n = store_per_track(**p)
            print(f"  {p['name']} {p['day']}: {n} track row(s)")
        except Exception as e:
            print(f"  ⚠ {p['name']} {p['day']}: per-track store FAILED ({e}) — "
                  f"the day itself is recorded in the committed files, and later "
                  f"deltas stay correct; this day's per-track detail is missing",
                  file=sys.stderr)


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
    pending_per_track = []
    wrote = []

    with SpotifyClient() as client:
        for name, aid, tracks in catalogs():
            ids = [t["id"] for t in tracks]
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

            # HOLD, the same rule the artist fetch follows: a half-published day
            # is not a day, so nothing is written for it — not even provisionally.
            # Waiting costs nothing, because `day` comes from the last RECORDED
            # day rather than the clock, so a later run picks up the same label
            # once the catalogue has moved. The alternative is what it produced on
            # the artist side: a row like +376 sitting among +7M days, which is
            # then read as the day's gain and skews every average built on it.
            if unfinished and prev is not None:
                print(f"  ⏳ Spotify still publishing — holding, nothing written. "
                      f"A later run records {day} once the catalogue has moved.")
                continue

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
            # No provisional rows are produced any more — an unfinished publish
            # returns above — but the flag stays readable for rows written before
            # that change, and for a first-ever record (prev is None), which is
            # not held because there is no previous day to compare it against.
            if unfinished and prev is None:
                rec["provisional"] = True
            history.setdefault(day, {})[aid] = rec
            rows_to_append.append({
                "date": day, "group": name, "artist_id": aid,
                "total_streams": total,
                "daily_delta": "" if delta is None else delta,
                "tracks": len(got), "note": note,
            })
            # The same numbers, kept per track instead of only summed. `known` is
            # captured before last_tracks[aid] is advanced below, so it is the
            # last COMPLETE day — the same baseline the group delta used.
            pending_per_track.append({
                "name": name, "artist_id": aid, "day": day, "tracks": tracks,
                "got": dict(got), "known": dict(known), "failed": list(failed),
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
        print(f"\nDRY_RUN — would record {len(rows_to_append)} row(s), plus "
              f"per-track rows for {sum(len(p['got']) for p in pending_per_track)} "
              f"track(s). Nothing written, Supabase included:")
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

    push_per_track(pending_per_track)


if __name__ == "__main__":
    main()
