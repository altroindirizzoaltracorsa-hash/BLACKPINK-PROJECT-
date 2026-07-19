"""
Daily catalog-streams fetch for tracked_artists in Supabase.

Uses a pinned track list per artist (FIXED_TRACKS below) instead of
walking the live discography. Spotify's catalog has duplicate album
listings (explicit/clean editions, pre-release singles later folded
into an album) that serve the same play_count under multiple track
IDs, and some tracks nominally on the group's albums are actually
credited to a single member. Deduping that heuristically drifted from
kworb.net's tracking scope, so instead FIXED_TRACKS is pinned to
exactly the same ~113 BLACKPINK tracks kworb tracks (reconciled by
hand against a kworb snapshot), fetched live via spotifyscraper rather
than kworb's own scrape (which lags real-time data by 1-2 days).

Requires SUPABASE_URL / SUPABASE_SERVICE_KEY env vars.
"""

import os
import sys
from datetime import date, timedelta

import httpx
from spotify_scraper import SpotifyClient

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

# Spotify's public play_count always lags by a day -- whatever we fetch
# "today" is actually yesterday's finalized count, same convention kworb
# uses. Label the snapshot with the day it reflects, not the day we ran.
TODAY = (date.today() - timedelta(days=1)).isoformat()

BLACKPINK_ID = "41MozSoPIsD1dJM0CLPjZF"

# name -> Spotify track ID. Kept in kworb's own display order/naming so the
# list is easy to re-diff against a future kworb snapshot if needed.
FIXED_TRACKS = {
    BLACKPINK_ID: [
        ("How You Like That", "4SFknyjLcyTLJFPKD2m96o"),
        ("Kill This Love", "6hvczQ05jc1yGlp9zhb95V"),
        ("Pink Venom", "6stcJnJHPO8RrYx5LLz5OP"),
        ("Shut Down", "0ARKW62l9uWIDYMZTUmJHF"),
        ("DDU-DU DDU-DU", "4lQsB3ERTWSNaAN1IkuNRl"),
        ("As If It's Your Last", "4ZxOuNHhpyOj4gv52MtQpT"),
        ("Kiss and Make Up", "7jr3iPu4O4bTCVwLMbdU2i"),
        ("Lovesick Girls", "4Ws314Ylb27BVsvlZOy30C"),
        ("BOOMBAYAH", "13MF2TYuyfITClL1R2ei6e"),
        ("Ice Cream (with Selena Gomez)", "4JUPEh2DVSXFGExu4Uxevz"),
        ("JUMP", "5jQ3mnhNhs9VuEvmVKllWM"),
        ("Pretty Savage", "1XnpzbOGptRwfJhZgLbmSr"),
        ("PLAYING WITH FIRE", "7qmvLmX9tyaTiBAVNI6YEn"),
        ("WHISTLE", "6NEoeBLQbOMw92qMeLfI40"),
        ("Typa Girl", "0L8LOav65XwLjCLS11gNPD"),
        ("Forever Young", "6veFyjNycn6EaNCKhkPXUY"),
        ("Sour Candy (with BLACKPINK)", "6R6ZoHTypt5lt68MWbzZXv"),
        ("Don't Know What To Do", "38SKB7UfhL6Sd6Joxex5yK"),
        ("Tally", "0bYVPJvXr8ACmw313cVvhB"),
        ("Love To Hate Me", "7iKDsPfLT0d5mu2htfMKBZ"),
        ("STAY", "3tP6QKbXvtrxiDI7QwKyUf"),
        ("Crazy Over You", "7qq0EOPW4RRlqdvMBmdd73"),
        ("Hard to Love", "3MJhPqL2IgGs7gHEB2M35q"),
        ("Bet You Wanna (feat. Cardi B)", "7iAgNZdotu40NwtoIWJHFe"),
        ("You Never Know", "39kzWAiVPpycdMpr745oPj"),
        ("Really", "2URMA0ap6SAI8wFmcY1yta"),
        ("Kick It", "4rsoLz7ZY1Ldz8dpm4Lqtg"),
        ("See U Later", "2REoTZjaB3jyAt5dgkV5GK"),
        ("THE GIRLS - BLACKPINK THE GAME OST", "1mFpMoeZfkIqtqW2AfQ8ba"),
        ("The Happiest Girl", "1XoY4WZrvPIphBaikXGjF8"),
        ("Ready For Love", "7Dq4YNgsltQuTmhYz1wJzq"),
        ("Yeah Yeah Yeah", "5TfKoQg9AjmDIWYKFoDqMN"),
        ("Hope Not", "3eZD5DZGibwxMAOaCMBg3k"),
        ("BOOMBAYAH - Japanese Version", "5nIjOnMbC0QDMrYFLGx0yV"),
        ("DDU-DU DDU-DU - Remix", "4sz6sircK4Jn2SZSHgd96h"),
        ("GO", "0mYa3o6tlUN5HRippmKmwH"),
        ("DDU-DU DDU-DU - Japanese Version", "4jUEHIrc443f743JbyLN0y"),
        ("WHISTLE - Acoustic Ver.", "20MOKIGONywL5xIoB7RRAR"),
        ("SO HOT - THEBLACKLABEL REMIX ARENA TOUR OSAKA", "1fMXWEkJpIH483OrKn1zFV"),
        ("AS IF IT'S YOUR LAST - Japanese Version", "5DVgfulxeJZJYc8FseyfUf"),
        ("FOREVER YOUNG - Japanese Version", "02h4inVwwNX1cMuGCDtsgV"),
        ("WHISTLE - Japanese Version", "3sgrwjWNJy753U30irIdEN"),
        ("Champion", "3oraRy91vke1aof4tIrQfr"),
        ("PLAYING WITH FIRE - Japanese Version", "29x3S9kmzTGHswtjSVeUPr"),
        ("DDU-DU DDU-DU - Live", "437Wn1icOBdhQaVnpJpl0F"),
        ("SEE U LATER - Japanese Version", "7IS4NciwYPs1wMywOKx69z"),
        ("REALLY - Japanese Version", "6OKXcx7tClGAS0o2cOTl2v"),
        ("STAY - Japanese Version", "4AESxPBujvuBbCAfBuA2sq"),
        ("KILL THIS LOVE - JP Ver.", "3mpGXkkjhY8K5C9OsaCMBo"),
        ("Kiss and Make Up - ARENA TOUR OSAKA", "6X9DNG2WR3IclfneGurU0T"),
        ("Me and my", "5MXcM263QvCTWriH3nVusc"),
        ("LET IT BE~YOU&I~ONLY LOOK AT ME - ARENA TOUR OSAKA", "7Iv6YcXoLNhTPYhHqtyNUy"),
        ("Fxxxboy", "7m0duH1vdTNxM2g8BLfR0F"),
        ("Pretty Savage - JP Ver.", "52lsilmqW7xWeJXARzwz3z"),
        ("Yuki no Hana/JISOO - LIVE ARENA TOUR OSAKA", "1sIKkwYIffUw0vLU8RsWIR"),
        ("DDU-DU DDU-DU - Remix -JP Ver.-", "04LWm93tY9nwdlI9EO54HP"),
        ("Kill This Love - Live", "1GrGs8HBvOHHdeho4w1ZkH"),
        ("Pretty Savage - Live", "3ua8wdqzl3SdgElppgcuf2"),
        ("Lovesick Girls - JP Ver.", "0UJRzax7oFLoK8Sb9IcPcm"),
        ("YOU & I + ONLY LOOK AT ME - Live", "59DULbyccrhJJb3Ko2bXFz"),
        ("Crazy Over You - Live", "20O6VxUyfLn6Zk8izFpMeu"),
        ("How You Like That - JP Ver.", "3VrjgpzoorLGYfaOXaOXOT"),
        ("DDU-DU DDU-DU - Live (2)", "4gXhyN8S81jbq50NdEUcLR"),
        ("How You Like That - Live", "3p9HltmtqXCvCSKKOKMZ29"),
        ("Lovesick Girls - Live", "4GPLXDicIuRmAELK5RWvCw"),
        ("Sour Candy - Shygirl & Mura Masa Remix", "56kudbKiRjWCwiAS3FRHCL"),
        ("Love To Hate Me + You Never Know - Live", "76F0GgW1qB7nED5CQeZSrX"),
        ("Don't Know What To Do - Live", "6BYdrWzCp2tL2RKSoncArx"),
        ("PLAYING WITH FIRE - Live (2)", "7jKhvwWoXGmfc8Ehc4kFrt"),
        ("DDU-DU DDU-DU - JP Ver./TOKYO DOME", "7fqjqOu4HKTN2yP6aV8lpQ"),
        ("WHISTLE - Acoustic Ver. Japanese Version", "2jjh53eV2QVGIRjGTawheD"),
        ("Forever Young - Live", "3RTSq1hwAr5CHB10SiWeDX"),
        ("BOOMBAYAH - Live", "1kUXkPQh6G8GLAIVIMgJwk"),
        ("SOLO - Live", "40HHE2cHpWC3JajQytQUtD"),
        ("WHISTLE - Live (2)", "5dUFWYt4BJfWlhC9CxWFGe"),
        ("Kill This Love - JP Ver./TOKYO DOME", "60IHvjpylI1IZHVSZnQSKJ"),
        ("As If It's Your Last - Live (2)", "5ROltcFSXdACTwRwOyJRzv"),
        ("BOOMBAYAH - Live (2)", "5SK8ZoIj62LTcRW7OQ8vtZ"),
        ("Forever Young - Live (2)", "3QCRpdVPsCK11k5zUMfc1l"),
        ("Last Christmas/Akahana no Tonakai - ARENA TOUR OSAKA", "6149wOhItvVX0zoa1KK5hw"),
        ("DDU-DU DDU-DU (Remix Version) - Live", "1b7PAugOHr8ZjD1Dbj8fON"),
        ("DON'T KNOW WHAT TO DO - JP Ver.", "38eKmp6QjELXKgLh0pePfG"),
        ("FOREVER YOUNG - JP Ver./TOKYO DOME", "3F7VrA3ttl6i6Z4b2KJ9YR"),
        ("PLAYING WITH FIRE - Live (SEOUL)", "3fo1Z8nJX9gRHYPjb4mgJs"),
        ("STAY (Remix Version) - Live", "6zlLFk0ZjBkA80p6xcZ8Ac"),
        ("WHISTLE (Remix Version) - Live", "6w5egqwHmhrBJsw8soFcuU"),
        ("Really (Reggae Version) - Live", "3mGle2Kpzw3E6G0g0T79QN"),
        ("As If It's Your Last - Live (SEOUL)", "3KcrCvutXhEEinowTrLfN4"),
        ("BOOMBAYAH - JP Ver./TOKYO DOME", "2u8Msh7gewUrmJ74K8HZNq"),
        ("STAY - Live", "7ov2yk9ZbtJoOpcd7QoRwd"),
        ("WHISTLE - Live (SEOUL)", "2QG3xa5guVkZhqZtuZZKgz"),
        ("Don't Know What To Do - JP Ver./TOKYO DOME", "3u6Knotm44XwggprlvmPtW"),
        ("WHISTLE - JP Ver./TOKYO DOME", "3iC3qlIi0KqATuA86pRGcZ"),
        ("STAY - Remix/JP Ver./TOKYO DOME", "7pt16OMGqeqivEeI1PzkfC"),
        ("You Never Know - JP Ver.", "3b7trEcKoglybN5MxGuSaw"),
        ("HOPE NOT - JP Ver.", "04xEHIAK4MsI7ZSN1hSDQN"),
        ("KICK IT - JP Ver.", "6HHbjSWWGh6j9JcmLZ41Py"),
        ("DDU-DU DDU-DU - ARENA TOUR OSAKA", "6PDvHZDWtGSVr8LXN3stsH"),
        ("See U Later - Live", "0ZnRursj0XlLszToN6wNV2"),
        ("AS IF IT'S YOUR LAST - JP Ver./TOKYO DOME", "1hPIpoUwxbXBp5fGMSDcXx"),
        ("Kiss and Make Up (Remix) [Mixed]", "6P8SQWN3pcLKChWHt73fZV"),
        ("REALLY - JP Ver./TOKYO DOME", "5IKRga8drUYZ5IqON5xXbx"),
        ("PLAYING WITH FIRE - JP Ver./TOKYO DOME", "614TWJTbiXsJCPxMpnKi0L"),
        ("Kick It - JP Ver./TOKYO DOME", "3oZWZlxfXuUbbUPndAfmRR"),
        ("SEE U LATER - JP Ver./TOKYO DOME", "06WghRVH4Yyvu4mtDJ0bfU"),
        ("BOOMBAYAH - ARENA TOUR OSAKA", "1uK64bAOSKhKFTUwrF2r2p"),
        ("FOREVER YOUNG - ARENA TOUR OSAKA", "32ssBfmhrG6qbEapVNwAOm"),
        ("WHISTLE - Acoustic Ver. ARENA TOUR OSAKA", "3QuzFJUtG9H4RoEv5J9mCP"),
        ("STAY - ARENA TOUR OSAKA", "5x9VzjchhXQfDBZcnO5xPM"),
        ("AS IF IT'S YOUR LAST - ARENA TOUR OSAKA", "4sB4UCnEu6UVC0dWtCqUAT"),
        ("PLAYING WITH FIRE - ARENA TOUR OSAKA", "6b5xktkZLF96lv5HrFucu4"),
        ("REALLY - ARENA TOUR OSAKA", "7nWREW5AWOgLMmW6jKJUEz"),
        ("SEE U LATER - ARENA TOUR OSAKA", "5dYjvCegNq6LbwWTzy1xIC"),
    ],
}


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


def fetch_fixed_tracks(client, track_specs):
    """track_specs: [(name, track_id), ...]. Returns [{name, streams, source_track_ids}]."""
    ids = [tid for _, tid in track_specs]
    results = client.get_tracks(ids)
    canonical = []
    for (name, tid), item in zip(track_specs, results):
        if not item.ok:
            print(f"  track fetch failed: {name!r} [{tid}]: {item.error}", file=sys.stderr)
            continue
        if item.result.play_count is None:
            print(f"  no play_count for: {name!r} [{tid}]", file=sys.stderr)
            continue
        canonical.append({"name": name, "streams": item.result.play_count, "source_track_ids": [tid]})
    return canonical


def upsert_artist_tracks(artist_id, canonical_tracks):
    """Upserts artist_tracks rows, returns {name: track_ref_id}."""
    rows = [
        {"artist_id": artist_id, "name": c["name"], "source_track_ids": c["source_track_ids"]}
        for c in canonical_tracks
    ]
    result = sb(
        "POST", "/artist_tracks",
        params={"on_conflict": "artist_id,name"},
        headers={"Prefer": "resolution=merge-duplicates,return=representation"},
        json=rows,
    )
    return {row["name"]: row["id"] for row in result}


def previous_track_streams(artist_id, prev_date):
    """{track_ref: streams} for this artist's tracks on prev_date, or {} if none."""
    if not prev_date:
        return {}
    track_refs = sb("GET", "/artist_tracks", params={"artist_id": f"eq.{artist_id}", "select": "id"})
    ids = [str(r["id"]) for r in track_refs]
    if not ids:
        return {}
    rows = sb("GET", "/track_daily_stats", params={
        "track_ref": f"in.({','.join(ids)})",
        "date": f"eq.{prev_date}",
        "select": "track_ref,streams",
    })
    return {r["track_ref"]: r["streams"] for r in rows}


def previous_artist_stat(artist_id):
    rows = sb("GET", "/artist_daily_stats", params={
        "artist_id": f"eq.{artist_id}",
        "date": f"lt.{TODAY}",
        "order": "date.desc",
        "limit": 1,
        "select": "date,total_streams",
    })
    return rows[0] if rows else None


def process_artist(client, artist_id, artist_name):
    print(f"=== {artist_name} ({artist_id}) ===")
    track_specs = FIXED_TRACKS.get(artist_id)
    if not track_specs:
        print(f"  no FIXED_TRACKS entry for {artist_id}, skipping", file=sys.stderr)
        return

    canonical = fetch_fixed_tracks(client, track_specs)
    total_streams = sum(c["streams"] for c in canonical)
    print(f"  {len(canonical)}/{len(track_specs)} tracks fetched, total={total_streams:,}")

    name_to_ref = upsert_artist_tracks(artist_id, canonical)

    prev_artist = previous_artist_stat(artist_id)
    prev_date = prev_artist["date"] if prev_artist else None
    prev_track_streams = previous_track_streams(artist_id, prev_date)

    track_rows = []
    for c in canonical:
        ref = name_to_ref[c["name"]]
        prev = prev_track_streams.get(ref)
        track_rows.append({
            "track_ref": ref,
            "date": TODAY,
            "streams": c["streams"],
            "daily_delta": (c["streams"] - prev) if prev is not None else None,
        })
    sb("POST", "/track_daily_stats",
       params={"on_conflict": "track_ref,date"},
       headers={"Prefer": "resolution=merge-duplicates"},
       json=track_rows)

    artist_data = client.get_artist(artist_id)
    if artist_data.images:
        avatar_url = max(artist_data.images, key=lambda im: im.width or 0).url
        sb("POST", "/tracked_artists",
           params={"on_conflict": "spotify_artist_id"},
           headers={"Prefer": "resolution=merge-duplicates"},
           json=[{
               "spotify_artist_id": artist_id,
               "name": artist_name,
               "avatar_url": avatar_url,
           }])

    artist_delta = (total_streams - prev_artist["total_streams"]) if prev_artist else None
    sb("POST", "/artist_daily_stats",
       params={"on_conflict": "artist_id,date"},
       headers={"Prefer": "resolution=merge-duplicates"},
       json=[{
           "artist_id": artist_id,
           "date": TODAY,
           "total_streams": total_streams,
           "daily_delta": artist_delta,
           "followers": artist_data.followers,
           "monthly_listeners": artist_data.monthly_listeners,
           "track_count": len(canonical),
       }])
    print(f"  saved. daily_delta={artist_delta}")


def main():
    artists = sb("GET", "/tracked_artists", params={"active": "eq.true", "select": "spotify_artist_id,name"})
    if not artists:
        print("No active tracked_artists found.", file=sys.stderr)
        sys.exit(1)

    failures = []
    with SpotifyClient() as client:
        for a in artists:
            try:
                process_artist(client, a["spotify_artist_id"], a["name"])
            except Exception as e:
                print(f"  FAILED: {e}", file=sys.stderr)
                failures.append(a["name"])

    if failures:
        print(f"{len(failures)}/{len(artists)} artists failed: {', '.join(failures)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
