#!/usr/bin/env python3
"""Has kworb started listing anything on the group watchlist yet?

That question is the re-seed trigger, and nothing was asking it. A watchlisted
track is recorded daily with counted=false precisely BECAUSE kworb has not
listed it; the moment kworb does, the group's pinned catalogue is out of date
and its total is missing a record it should now contain. Until somebody
notices, the group simply reads low — and reads low in a way that looks like a
quiet week rather than like a missing album.

So this runs daily and FAILS when the answer is yes. A red run is the
notification; a green one means there is nothing to do. It deliberately does
not re-seed by itself: re-seeding while kworb is mid-update can pin a partial
list, which is a worse state than being a day late, and it is the one thing
here a person should look at before it happens.

Read-only. One GET per group on the watchlist.
"""
import json
import os
import re
import sys

WATCHLIST = "data/group_watchlist.json"
CATALOGS = "data/group_catalogs"


def kworb_ids(artist_id):
    """Every track id kworb lists for this artist, or None if unreachable.

    None and "lists nothing" are kept apart on purpose: an unreachable kworb
    must never read as "not listed yet", which is the answer that means do
    nothing. Lifted from probe_track_playcount.py, which asks the same
    question one track at a time.
    """
    try:
        import httpx
        r = httpx.get(f"https://kworb.net/spotify/artist/{artist_id}_songs.html",
                      timeout=60, headers={"User-Agent": "Mozilla/5.0"},
                      follow_redirects=True)
        r.raise_for_status()
        return set(re.findall(r"track/([0-9A-Za-z]{22})", r.text))
    except Exception as e:
        print(f"  !! kworb unreachable for {artist_id}: {e}", file=sys.stderr)
        return None


def main():
    with open(WATCHLIST, encoding="utf-8") as fh:
        wl = json.load(fh)

    groups = [(k, v) for k, v in wl.items() if not k.startswith("_")]
    if not groups:
        print("the watchlist is empty — nothing to check")
        return 0

    listed, unreachable = [], []
    for artist_id, entry in groups:
        name = artist_id
        cat_path = os.path.join(CATALOGS, f"{artist_id}.json")
        counted = set()
        if os.path.exists(cat_path):
            with open(cat_path, encoding="utf-8") as fh:
                cat = json.load(fh)
            name = cat.get("name", artist_id)
            counted = {t["id"] for t in cat.get("tracks", [])}

        # An entry already in the catalogue is a no-op the file itself calls
        # harmless: it was re-seeded and the flag flips by itself. Not news.
        pending = [t for t in entry.get("tracks", []) if t["id"] not in counted]
        if not pending:
            print(f"{name}: every watched track is already in the catalogue — nothing pending")
            continue

        kw = kworb_ids(artist_id)
        if kw is None:
            unreachable.append(name)
            continue

        now_on = [t for t in pending if t["id"] in kw]
        print(f"{name}: {len(pending)} pending, {len(now_on)} now on kworb "
              f"(kworb lists {len(kw)} ids, catalogue pins {len(counted)})")

        # The two SETS, not the two counts. Comparing sizes says nothing about
        # membership — 67 against 64 was read here as "three tracks kworb
        # counts that we do not", which does not follow and was wrong. The
        # catalogue pins kworb's scope as of its seed day while kworb's own
        # list moves underneath it, so the lists drift in both directions.
        #
        # Reported, never failed on. Drift is worth seeing — a group missing
        # tracks kworb counts reads low, and reads like a quiet week — but it
        # is a standing condition, and a daily red for it would bury the one
        # thing this check exists to shout about.
        watched = {t["id"] for t in entry.get("tracks", [])}
        kworb_only = kw - counted - watched        # watched ones are the headline above
        ours_only = counted - kw
        if kworb_only or ours_only:
            print(f"    scope drift: kworb has {len(kworb_only)} id(s) the catalogue does not"
                  f" (beyond the watchlist), the catalogue has {len(ours_only)} kworb no longer lists")
            for tid in sorted(kworb_only):
                print(f"      kworb only   https://open.spotify.com/track/{tid}")
            for tid in sorted(ours_only):
                nm = next((t.get("name", "?") for t in cat.get("tracks", []) if t["id"] == tid), "?")
                print(f"      ours only    {tid}  {nm}")
        for t in now_on:
            print(f"    LISTED  {t['name']}  {t['id']}")
        if now_on:
            listed.append((name, artist_id, now_on))

    if unreachable:
        # Not a pass. "Could not ask" and "asked, answer was no" are different
        # answers and only one of them means do nothing.
        print(f"\n::error::could not reach kworb for: {', '.join(unreachable)} — "
              f"this run proved nothing, it did not prove 'not yet'")
        return 1

    if not listed:
        print("\nnothing new on kworb — the pinned catalogues are still right")
        return 0

    print("\n" + "=" * 70)
    for name, artist_id, tracks in listed:
        print(f"{name} IS NOW ON KWORB: {', '.join(t['name'] for t in tracks)}")
        print(f"  re-seed with:  Seed group catalogs from kworb  →  only: {name}, write: 1")
    print("=" * 70)
    print("Until that runs, these tracks are recorded but NOT counted, so the")
    print("group's total is missing them. Re-seeding is a LEVEL SHIFT: the")
    print("tracks join carrying everything they have accumulated and all of it")
    print("lands in one day's daily_delta. scope_growth() notes the amount; a")
    print("span rate across that day must subtract it or start after it.")
    print("::error::kworb now lists a watched track — re-seed that group")
    return 1


if __name__ == "__main__":
    sys.exit(main())
