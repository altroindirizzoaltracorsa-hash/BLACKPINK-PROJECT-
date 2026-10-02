"""Release dates for the group tracks that are in range of 1 billion streams.

The 1B comparison is measured in DAYS FROM RELEASE, so the release date is the
one term we fetch everything else for and never stored. This fills it.

── Why a track's own release_date is not the answer ────────────────────────────

Spotify reports a track's date as the date of the ALBUM THAT TRACK ID BELONGS
TO. For a single later folded into an album, the id we track is the album's
copy, so the date is the album's — months or years after the song came out.
Measured on the first run of this script:

    JUMP                 2026-02-27 (DEADLINE)        really 2025-07-11
    How You Like That    2020-10-02 (THE ALBUM)       really 2020-06-26
    Ice Cream            2020-10-02 (THE ALBUM)       really 2020-08-28
    What is Love?        2018-07-09 (Summer Nights)   really 2018-04-09

The error runs one way — always late — and is worst for the biggest, oldest
hits, which are exactly the ones a "fastest to 1B" table is about. Taking those
at face value would have understated days-from-release by months on the headline
rows.

So the date is resolved by walking each group's discography and keeping the
EARLIEST release carrying a track of the same (normalized) title. A track whose
title appears nowhere in that walk — a feature on someone else's release, a
soundtrack — keeps its own album date and is marked `album` rather than
`first_release`, so the page can show it as the approximation it is.

Scoped by streams rather than run over all ~870 tracks: a track at 40M is not in
a race to 1B for years, and its date can be fetched when it is. FLOOR (default
300,000,000) is read against each track's newest recorded figure in
group_track_daily_stats, so the scope widens on its own as tracks grow.

Idempotent and additive: tracks that already have a date are skipped unless
REFETCH=1. Writes nothing unless WRITE=1.

Env: SUPABASE_URL, SUPABASE_SERVICE_KEY. Optional FLOOR, WRITE, REFETCH, BATCH.
"""

import os
import sys

import httpx
from spotify_scraper import SpotifyClient

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
FLOOR = int(os.environ.get("FLOOR", "300000000"))
WRITE = os.environ.get("WRITE", "0") == "1"
REFETCH = os.environ.get("REFETCH", "0") == "1"
BATCH = int(os.environ.get("BATCH", "40"))
# How deep to walk each group's discography looking for a song's first release.
# Generous on purpose: a 2016 debut single is a long way down TWICE's list, and
# the whole point is to reach past the album the track id belongs to.
MAX_RELEASES = int(os.environ.get("MAX_RELEASES", "300"))


def norm(name):
    """Lowercase, whitespace-collapsed title — the same normalization the artist
    fetch uses to recognise one song across two track ids."""
    return " ".join((name or "").lower().split())


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


def first_releases(client, artist_id):
    """{normalized title: earliest release date} across this artist's discography.

    Every album is fetched for its track list, not just its date: a song's first
    appearance is usually on a single whose title is the song's, but just as
    often it is a track on an earlier EP, and only the track list shows that."""
    out = {}
    try:
        releases = client.get_discography(artist_id, max_releases=MAX_RELEASES)
    except Exception as e:
        print(f"  ⚠ discography fetch failed for {artist_id}: {e}", file=sys.stderr)
        return out
    for rel in releases:
        alb_id = getattr(rel, "id", None)
        if not alb_id:
            continue
        try:
            album = client.get_album(alb_id)
        except Exception:
            continue
        rd = getattr(album, "release_date", None)
        day = rd.date().isoformat() if hasattr(rd, "date") else None
        if not day:
            continue
        for t in (album.tracks or []):
            k = norm(getattr(t, "name", ""))
            if not k:
                continue
            if k not in out or day < out[k]:
                out[k] = day
    return out


def in_range():
    """[(ref, track_id, name, streams)] — tracks at or above FLOOR on their
    newest recorded day, newest-first by streams."""
    tracks = sb("GET", "/group_tracks",
                params={"select": "id,artist_id,track_id,name,release_date", "limit": "5000"})
    by_ref = {t["id"]: t for t in tracks}
    # One query for the whole table rather than per track: 870 tracks x 25 days
    # is still a small read, and 870 round trips is not.
    stats = sb("GET", "/group_track_daily_stats",
               params={"select": "track_ref,date,streams", "order": "date.desc",
                       "streams": f"gte.{FLOOR}", "limit": "20000"})
    newest = {}
    for s in stats:                     # already newest-first
        newest.setdefault(s["track_ref"], s)
    out = []
    for ref, s in newest.items():
        t = by_ref.get(ref)
        if not t:
            continue
        if t.get("release_date") and not REFETCH:
            continue
        out.append({"ref": ref, "artist_id": t["artist_id"], "track_id": t["track_id"],
                    "name": t.get("name"), "streams": s["streams"]})
    out.sort(key=lambda r: -r["streams"])
    return out, len(by_ref), sum(1 for t in tracks if t.get("release_date"))


def main():
    if not (SUPABASE_URL and SUPABASE_KEY):
        sys.exit("SUPABASE_URL / SUPABASE_SERVICE_KEY required")

    todo, n_tracks, n_dated = in_range()
    print(f"group_tracks: {n_tracks} rows, {n_dated} already dated")
    print(f"at or above {FLOOR:,} streams and still undated: {len(todo)}")
    if not todo:
        print("nothing to do")
        return

    found, missing = [], []
    with SpotifyClient() as client:
        # One discography walk per group, shared by all of its tracks.
        firsts = {}
        for aid in sorted({t["artist_id"] for t in todo}):
            firsts[aid] = first_releases(client, aid)
            print(f"  discography {aid}: {len(firsts[aid])} distinct titles")

        for i in range(0, len(todo), BATCH):
            chunk = todo[i:i + BATCH]
            try:
                results = client.get_tracks([t["track_id"] for t in chunk])
            except Exception as e:
                print(f"  batch failed: {e}", file=sys.stderr)
                missing.extend(chunk)
                continue
            for t, item in zip(chunk, results):
                rd = getattr(item.result, "release_date", None) if item.ok else None
                album_day = None
                if rd:
                    album_day = rd.date().isoformat() if hasattr(rd, "date") else str(rd)[:10]
                earliest = firsts.get(t["artist_id"], {}).get(norm(t["name"]))
                if not album_day and not earliest:
                    missing.append(t)
                    continue
                # Three outcomes, and the difference between the last two is the
                # whole point: a title track's album date IS its release date, so
                # the walk agreeing with it is CONFIRMATION, not a failure to
                # find anything. Collapsing those two into one bucket put a
                # "may be late" warning on ~50 correct rows and left the handful
                # that are genuinely unverified indistinguishable from them.
                #
                # None of these is a verified release date, and the labels say
                # only what was actually established. "earliest_found" is the
                # oldest release SPOTIFY STILL LISTS carrying this title — which
                # is not the same as the oldest that ever existed: How You Like
                # That resolves to 2020-10-02 (THE ALBUM) because its 2020-06-26
                # single appears to have been delisted, and nothing in the data
                # can see that. An earlier label of "confirmed" claimed a
                # verification this evidence cannot support.
                if earliest and (not album_day or earliest < album_day):
                    day, prec = earliest, "first_release"   # an earlier release exists: single later folded in
                elif earliest:
                    day, prec = album_day, "earliest_found" # nothing earlier is listed — not proof none existed
                else:
                    day, prec = album_day, "album"          # title not found at all; this is the id's album, which
                                                            # can sit either side of the song's real release
                # Spotify serves some dates as year-only, which arrives as 1
                # January. Marked so a coarse date can be shown as coarse rather
                # than read as a New Year's Day release — a days-from-release
                # figure built on it is out by up to a year.
                if day.endswith("-01-01"):
                    prec = "year"
                found.append({**t, "release_date": day, "precision": prec,
                              "album_date": album_day,
                              "moved": (album_day and day != album_day)})

    moved = [f for f in found if f["moved"]]
    unverified = [f for f in found if f["precision"] == "album"]
    print(f"\nresolved {len(found)}, unresolved {len(missing)}, "
          f"{len(moved)} corrected off their album date, "
          f"{len(found) - len(moved) - len(unverified)} with nothing earlier listed, "
          f"{len(unverified)} left on an unverified album date")
    for f in found:
        flag = ""
        if f["moved"]:
            flag = f"   ← album says {f['album_date']}"
        elif f["precision"] == "album":
            flag = "   (the track id's album — the song itself may be older or newer)"
        if f["precision"] == "year":
            flag += "  [year-only]"
        print(f"  {f['streams']:>14,}  {f['release_date']}  {f['name']}{flag}")
    for t in missing:
        print(f"  {t['streams']:>14,}  {'—':>10}  {t['name']} [{t['track_id']}] — no date found")

    if not WRITE:
        print(f"\nWRITE != 1 — would set {len(found)} release date(s)")
        return
    for f in found:
        sb("PATCH", "/group_tracks",
           params={"id": f"eq.{f['ref']}"},
           json={"release_date": f["release_date"], "release_precision": f["precision"]})
    print(f"\nset {len(found)} release date(s)")


if __name__ == "__main__":
    main()
