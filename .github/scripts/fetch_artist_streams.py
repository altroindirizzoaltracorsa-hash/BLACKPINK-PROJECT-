"""
Daily catalog-streams fetch for tracked_artists in Supabase.

For each active artist: pull the full discography via spotifyscraper
(embed-page-bootstrapped anon token -- survives GitHub Actions' network,
unlike open.spotify.com/get_access_token), dedupe tracks by name with a
drift tolerance (catches linked releases -- singles later folded into an
album, explicit/clean editions -- while leaving genuinely different songs
that happen to share a title, like same-named tracks on different live
albums, alone), and upsert today's snapshot into Supabase.

Requires SUPABASE_URL / SUPABASE_SERVICE_KEY env vars.
"""

import os
import sys
from datetime import date, timedelta

import httpx
from spotify_scraper import SpotifyClient

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
DRIFT_TOLERANCE = 0.01  # see test-spotifyscraper.py for how this was derived

TODAY = date.today().isoformat()


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


def fetch_catalog(client, artist_id):
    """Returns (playcount_by_id: {id: (name, streams)}, album_name_by_id: {id: album_name})."""
    albums = client.get_discography(artist_id)
    album_results = client.get_albums([a.id for a in albums])

    track_ids, album_name_by_id = [], {}
    seen = set()
    for ref, item in zip(albums, album_results):
        if not item.ok:
            print(f"  album fetch failed: {ref.name!r}: {item.error}", file=sys.stderr)
            continue
        for t in item.result.tracks:
            if not t.id:
                continue
            album_name_by_id[t.id] = item.result.name
            if t.id not in seen:
                seen.add(t.id)
                track_ids.append(t.id)

    track_results = client.get_tracks(track_ids)
    playcount_by_id = {}
    for tid, item in zip(track_ids, track_results):
        if not item.ok:
            print(f"  track fetch failed: {tid}: {item.error}", file=sys.stderr)
            continue
        if item.result.play_count is None:
            continue
        playcount_by_id[tid] = (item.result.name, item.result.play_count)

    return playcount_by_id, album_name_by_id


def dedupe(playcount_by_id, album_name_by_id):
    """
    Returns [{name, streams, source_track_ids}, ...] -- one entry per
    canonical song. Linked releases (spread <= DRIFT_TOLERANCE) collapse
    into one entry at the max (freshest) value. Real distinct content that
    happens to share a title gets disambiguated by album name instead of
    being merged.
    """
    by_name = {}
    for tid, (name, pc) in playcount_by_id.items():
        by_name.setdefault(name, []).append((tid, pc))

    canonical = []
    for name, entries in by_name.items():
        if len(entries) == 1:
            tid, pc = entries[0]
            canonical.append({"name": name, "streams": pc, "source_track_ids": [tid]})
            continue

        values = [pc for _, pc in entries]
        hi, lo = max(values), min(values)
        spread = (hi - lo) / hi if hi else 0

        if spread <= DRIFT_TOLERANCE:
            canonical.append({
                "name": name,
                "streams": hi,
                "source_track_ids": [tid for tid, _ in entries],
            })
        else:
            # Genuinely different songs sharing a title -- disambiguate by
            # the album each came from rather than silently merging or
            # colliding on the same canonical name.
            for tid, pc in entries:
                album = album_name_by_id.get(tid, "unknown album")
                canonical.append({
                    "name": f"{name} ({album})",
                    "streams": pc,
                    "source_track_ids": [tid],
                })

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
    playcount_by_id, album_name_by_id = fetch_catalog(client, artist_id)
    canonical = dedupe(playcount_by_id, album_name_by_id)
    total_streams = sum(c["streams"] for c in canonical)
    print(f"  {len(playcount_by_id)} raw tracks -> {len(canonical)} canonical, total={total_streams:,}")

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
