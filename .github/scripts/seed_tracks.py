"""
Put named track ids into an artist's catalogue NOW, ahead of the nightly fetch.

Why this exists: auto-discovery already finds a new release the day it drops,
but the line that persists it — upsert_artist_tracks — sits after
process_artist's two early returns (the mid-publish hold, and "same total as
yesterday, skipping"). Until Spotify publishes a day, every run finds the
release, logs it and exits before writing. That is usually right: the tracks
land in the same run that first records their numbers, so nothing is missed.
This is for when you want the catalogue built in advance anyway.

Writes artist_tracks ONLY — never track_daily_stats. A day nobody observed
must not exist, and the tracks carry no streams until a real fetch records
them. Re-running is a no-op: the upsert conflicts on (artist_id, name).

Metadata comes from the same fetch_fixed_tracks() the nightly job uses, so the
rows are identical to what it would have written, including album art and
track numbers.

Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, ARTIST_ID, TRACK_IDS (comma or
whitespace separated), and WRITE=1 to actually write — without it this is a
dry run that prints what it would do.
"""

import os
import sys

from spotify_scraper import SpotifyClient

import fetch_artist_streams as F

lines = []


def say(line):
    lines.append(line)
    print(line)


def report():
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as f:
            f.write("```\n" + "\n".join(lines) + "\n```\n")
    # One annotation, %0A for line breaks: a literal newline ends a workflow
    # command and silently drops everything after it.
    blob = "%0A".join(
        l.replace("%", "%25").replace("\r", "").replace("\n", " ") for l in lines)
    print(f"::notice title=seed::{blob[:3500]}")


def main():
    artist_id = os.environ["ARTIST_ID"].strip()
    raw = os.environ["TRACK_IDS"].replace(",", " ").split()
    ids = [t.strip() for t in raw if t.strip()]
    write = os.environ.get("WRITE") == "1"
    if not ids:
        say("no TRACK_IDS given, nothing to do")
        return
    say(f"artist {artist_id} · {len(ids)} id(s) · {'WRITE' if write else 'DRY RUN'}")

    # What the catalogue already holds, so an id that is in and an id that is
    # new are reported apart rather than both reading as "done".
    existing = F.sb("GET", "/artist_tracks", params={
        "artist_id": f"eq.{artist_id}", "select": "name,source_track_ids"}) or []
    have_ids = {s for r in existing for s in (r.get("source_track_ids") or [])}
    have_names = {F._norm_track_name(r.get("name")) for r in existing}
    say(f"catalogue holds {len(existing)} tracks before this")

    # The NAME matters as much as the id: artist_tracks upserts on
    # (artist_id, name), so a name that differs by one character from the one
    # auto-discovery would write gives the same song two rows, and the nightly
    # job then counts it twice. So the names are not taken from this script's
    # input — they are read back off the artist's discography by the very
    # function discovery uses, and an id that scan does not find is refused
    # rather than guessed at.
    with SpotifyClient() as client:
        scanned = {tid: name for name, tid, _ in F.scan_recent_tracks(client, artist_id)}
        say(f"discography scan offers {len(scanned)} recent track(s)")
        specs, unknown = [], []
        for tid in ids:
            if tid in scanned:
                specs.append((scanned[tid], tid))
            else:
                unknown.append(tid)
        for tid in unknown:
            say(f"  NOT IN THE RECENT DISCOGRAPHY [{tid}] — refusing: its name "
                f"would be a guess, and a wrong name means a duplicate row")
        if not specs:
            say("no usable ids")
            return
        canonical, failed = F.fetch_fixed_tracks(client, specs)

    for name, tid in failed:
        say(f"  COULD NOT FETCH {name!r} [{tid}] — skipped, nothing written for it")

    fresh = []
    for c in canonical:
        n = F._norm_track_name(c["name"])
        in_ids = any(s in have_ids for s in c["source_track_ids"])
        if in_ids:
            say(f"  already in catalogue by id: {c['name']!r} — left alone")
        elif n in have_names:
            # Same song under a new track id. The nightly job refuses these to
            # avoid counting one song twice; so does this.
            say(f"  NAME ALREADY TRACKED: {c['name']!r} — refusing, that would "
                f"count one song twice")
        else:
            fresh.append(c)
            say(f"  will add: {c['name']!r} [{c['source_track_ids']}] "
                f"streams={c['streams']:,}")

    if not fresh:
        say("nothing new to add")
        return
    if not write:
        say(f"DRY RUN — {len(fresh)} track(s) would be added. Set write=1 to apply.")
        return

    refs = F.upsert_artist_tracks(artist_id, fresh)
    say(f"WROTE {len(refs)} artist_tracks row(s): {', '.join(sorted(refs))}")
    after = F.sb("GET", "/artist_tracks", params={
        "artist_id": f"eq.{artist_id}", "select": "name"}) or []
    say(f"catalogue now holds {len(after)} tracks")
    say("no track_daily_stats rows written — streams land on the next real fetch")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        say(f"FAILED: {type(e).__name__}: {e}")
        report()
        sys.exit(1)
    report()
