"""
One-time fix, not part of the daily pipeline:

1. fetch_artist_streams.py's first run labeled its snapshot with the day
   it ran (2026-07-19) instead of the day the numbers reflect (Spotify's
   public play_count always lags a day, so that snapshot is really
   2026-07-18's data -- see the TODAY comment in fetch_artist_streams.py
   for the same fix applied going forward).
2. We already have a trustworthy 2026-07-17 baseline for every one of the
   113 pinned tracks: the kworb.net snapshot used to reconcile the pinned
   track list in the first place. Backfilling it lets 07-18's daily_delta
   be real instead of null.

Deletes the mislabeled 07-19 rows and replaces them with correctly dated
07-17 (baseline, no delta) and 07-18 (the real fetched numbers, with
delta computed against the 07-17 baseline) rows.

Requires SUPABASE_URL / SUPABASE_SERVICE_KEY env vars.
"""

import os
import sys

import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

BLACKPINK_ID = "41MozSoPIsD1dJM0CLPjZF"
MISLABELED_DATE = "2026-07-19"
BASELINE_DATE = "2026-07-17"
FETCHED_DATE = "2026-07-18"

# track_id -> kworb-reported streams as of 2026-07-17, for all 113 pinned
# BLACKPINK tracks (reconciled by hand against a kworb snapshot when the
# pinned track list itself was built).
JULY17_BASELINE = {
    "4SFknyjLcyTLJFPKD2m96o": 1267632650,
    "6hvczQ05jc1yGlp9zhb95V": 1052026975,
    "6stcJnJHPO8RrYx5LLz5OP": 1020348135,
    "0ARKW62l9uWIDYMZTUmJHF": 898290276,
    "4lQsB3ERTWSNaAN1IkuNRl": 879065649,
    "4ZxOuNHhpyOj4gv52MtQpT": 801965667,
    "4Ws314Ylb27BVsvlZOy30C": 733188593,
    "13MF2TYuyfITClL1R2ei6e": 715512280,
    "4JUPEh2DVSXFGExu4Uxevz": 669710284,
    "5jQ3mnhNhs9VuEvmVKllWM": 653502210,
    "1XnpzbOGptRwfJhZgLbmSr": 589057797,
    "7qmvLmX9tyaTiBAVNI6YEn": 559500377,
    "6NEoeBLQbOMw92qMeLfI40": 500292309,
    "0L8LOav65XwLjCLS11gNPD": 480418783,
    "6veFyjNycn6EaNCKhkPXUY": 443434050,
    "6R6ZoHTypt5lt68MWbzZXv": 423770954,
    "38SKB7UfhL6Sd6Joxex5yK": 364515912,
    "0bYVPJvXr8ACmw313cVvhB": 341915180,
    "7iKDsPfLT0d5mu2htfMKBZ": 290833205,
    "3tP6QKbXvtrxiDI7QwKyUf": 285085746,
    "7qq0EOPW4RRlqdvMBmdd73": 280172695,
    "3MJhPqL2IgGs7gHEB2M35q": 271177496,
    "7iAgNZdotu40NwtoIWJHFe": 221923584,
    "39kzWAiVPpycdMpr745oPj": 205883985,
    "2URMA0ap6SAI8wFmcY1yta": 197104604,
    "4rsoLz7ZY1Ldz8dpm4Lqtg": 191160778,
    "2REoTZjaB3jyAt5dgkV5GK": 172408718,
    "1mFpMoeZfkIqtqW2AfQ8ba": 165681911,
    "1XoY4WZrvPIphBaikXGjF8": 164897610,
    "7Dq4YNgsltQuTmhYz1wJzq": 150452907,
    "5TfKoQg9AjmDIWYKFoDqMN": 147305137,
    "3eZD5DZGibwxMAOaCMBg3k": 141200710,
    "5nIjOnMbC0QDMrYFLGx0yV": 99371652,
    "4sz6sircK4Jn2SZSHgd96h": 94210883,
    "0mYa3o6tlUN5HRippmKmwH": 91335274,
    "4jUEHIrc443f743JbyLN0y": 80860432,
    "20MOKIGONywL5xIoB7RRAR": 80323489,
    "1fMXWEkJpIH483OrKn1zFV": 79206081,
    "5DVgfulxeJZJYc8FseyfUf": 55825504,
    "02h4inVwwNX1cMuGCDtsgV": 46408595,
    "3sgrwjWNJy753U30irIdEN": 46145369,
    "3oraRy91vke1aof4tIrQfr": 45291797,
    "29x3S9kmzTGHswtjSVeUPr": 43897039,
    "437Wn1icOBdhQaVnpJpl0F": 42594608,
    "7IS4NciwYPs1wMywOKx69z": 39654564,
    "6OKXcx7tClGAS0o2cOTl2v": 38180948,
    "4AESxPBujvuBbCAfBuA2sq": 37954138,
    "3mpGXkkjhY8K5C9OsaCMBo": 37733330,
    "6X9DNG2WR3IclfneGurU0T": 32812380,
    "5MXcM263QvCTWriH3nVusc": 32130492,
    "7Iv6YcXoLNhTPYhHqtyNUy": 24803169,
    "7m0duH1vdTNxM2g8BLfR0F": 23417879,
    "52lsilmqW7xWeJXARzwz3z": 20343541,
    "1sIKkwYIffUw0vLU8RsWIR": 15036681,
    "04LWm93tY9nwdlI9EO54HP": 14119677,
    "1GrGs8HBvOHHdeho4w1ZkH": 13513528,
    "3ua8wdqzl3SdgElppgcuf2": 12629566,
    "0UJRzax7oFLoK8Sb9IcPcm": 11551215,
    "59DULbyccrhJJb3Ko2bXFz": 11283996,
    "20O6VxUyfLn6Zk8izFpMeu": 11030791,
    "3VrjgpzoorLGYfaOXaOXOT": 10849190,
    "4gXhyN8S81jbq50NdEUcLR": 10775035,
    "3p9HltmtqXCvCSKKOKMZ29": 10569964,
    "4GPLXDicIuRmAELK5RWvCw": 10202462,
    "76F0GgW1qB7nED5CQeZSrX": 8919777,
    "6BYdrWzCp2tL2RKSoncArx": 8662950,
    "7jKhvwWoXGmfc8Ehc4kFrt": 8656157,
    "7fqjqOu4HKTN2yP6aV8lpQ": 8631784,
    "2jjh53eV2QVGIRjGTawheD": 7859381,
    "3RTSq1hwAr5CHB10SiWeDX": 7663377,
    "1kUXkPQh6G8GLAIVIMgJwk": 6915190,
    "40HHE2cHpWC3JajQytQUtD": 6873043,
    "5dUFWYt4BJfWlhC9CxWFGe": 6806133,
    "60IHvjpylI1IZHVSZnQSKJ": 6552707,
    "5ROltcFSXdACTwRwOyJRzv": 6499242,
    "5SK8ZoIj62LTcRW7OQ8vtZ": 6421176,
    "3QCRpdVPsCK11k5zUMfc1l": 5728159,
    "6149wOhItvVX0zoa1KK5hw": 5723748,
    "1b7PAugOHr8ZjD1Dbj8fON": 5626661,
    "38eKmp6QjELXKgLh0pePfG": 5574183,
    "3F7VrA3ttl6i6Z4b2KJ9YR": 5510950,
    "3fo1Z8nJX9gRHYPjb4mgJs": 5406468,
    "6zlLFk0ZjBkA80p6xcZ8Ac": 5326113,
    "6w5egqwHmhrBJsw8soFcuU": 5279136,
    "3mGle2Kpzw3E6G0g0T79QN": 5271279,
    "3KcrCvutXhEEinowTrLfN4": 5195412,
    "2u8Msh7gewUrmJ74K8HZNq": 4986495,
    "7ov2yk9ZbtJoOpcd7QoRwd": 4586437,
    "2QG3xa5guVkZhqZtuZZKgz": 4574024,
    "3u6Knotm44XwggprlvmPtW": 4539232,
    "3iC3qlIi0KqATuA86pRGcZ": 4509421,
    "7pt16OMGqeqivEeI1PzkfC": 4353440,
    "3b7trEcKoglybN5MxGuSaw": 4199496,
    "04xEHIAK4MsI7ZSN1hSDQN": 4140943,
    "6HHbjSWWGh6j9JcmLZ41Py": 4133289,
    "6PDvHZDWtGSVr8LXN3stsH": 4056857,
    "0ZnRursj0XlLszToN6wNV2": 3990488,
    "1hPIpoUwxbXBp5fGMSDcXx": 3952975,
    "5IKRga8drUYZ5IqON5xXbx": 3639160,
    "614TWJTbiXsJCPxMpnKi0L": 3625289,
    "3oZWZlxfXuUbbUPndAfmRR": 3506385,
    "06WghRVH4Yyvu4mtDJ0bfU": 3052448,
    "1uK64bAOSKhKFTUwrF2r2p": 2989221,
    "32ssBfmhrG6qbEapVNwAOm": 2972836,
    "3QuzFJUtG9H4RoEv5J9mCP": 2790334,
    "5x9VzjchhXQfDBZcnO5xPM": 2730900,
    "4sB4UCnEu6UVC0dWtCqUAT": 2538217,
    "6b5xktkZLF96lv5HrFucu4": 2383379,
    "7nWREW5AWOgLMmW6jKJUEz": 2194915,
    "5dYjvCegNq6LbwWTzy1xIC": 2077223,
    "7jr3iPu4O4bTCVwLMbdU2i": 773508044,
    "6P8SQWN3pcLKChWHt73fZV": 3855604,
    "56kudbKiRjWCwiAS3FRHCL": 9519374,
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


def main():
    tracks = sb("GET", "/artist_tracks", params={"artist_id": f"eq.{BLACKPINK_ID}", "select": "id,name,source_track_ids"})
    id_by_track_id = {}
    for t in tracks:
        for tid in t["source_track_ids"]:
            id_by_track_id[tid] = t["id"]

    missing = set(JULY17_BASELINE) - set(id_by_track_id)
    if missing:
        print(f"FATAL: {len(missing)} baseline track IDs have no artist_tracks row: {missing}", file=sys.stderr)
        sys.exit(1)

    mislabeled = sb("GET", "/track_daily_stats", params={
        "date": f"eq.{MISLABELED_DATE}",
        "track_ref": f"in.({','.join(str(t['id']) for t in tracks)})",
        "select": "track_ref,streams",
    })
    fetched_by_ref = {r["track_ref"]: r["streams"] for r in mislabeled}

    mislabeled_artist = sb("GET", "/artist_daily_stats", params={
        "date": f"eq.{MISLABELED_DATE}",
        "artist_id": f"eq.{BLACKPINK_ID}",
        "select": "followers,monthly_listeners",
    })
    if not mislabeled_artist:
        print(f"FATAL: no {MISLABELED_DATE} artist_daily_stats row for {BLACKPINK_ID}", file=sys.stderr)
        sys.exit(1)
    followers = mislabeled_artist[0]["followers"]
    monthly_listeners = mislabeled_artist[0]["monthly_listeners"]

    ref_by_track_id = {tid: id_by_track_id[tid] for tid in JULY17_BASELINE}
    missing_fetched = set(ref_by_track_id.values()) - set(fetched_by_ref)
    if missing_fetched:
        print(f"FATAL: {len(missing_fetched)} track_refs have no {MISLABELED_DATE} row to relabel", file=sys.stderr)
        sys.exit(1)

    print(f"Deleting mislabeled {MISLABELED_DATE} rows...")
    sb("DELETE", "/track_daily_stats", params={
        "date": f"eq.{MISLABELED_DATE}",
        "track_ref": f"in.({','.join(str(t['id']) for t in tracks)})",
    })
    sb("DELETE", "/artist_daily_stats", params={"date": f"eq.{MISLABELED_DATE}", "artist_id": f"eq.{BLACKPINK_ID}"})

    baseline_rows = [
        {"track_ref": ref_by_track_id[tid], "date": BASELINE_DATE, "streams": streams, "daily_delta": None}
        for tid, streams in JULY17_BASELINE.items()
    ]
    baseline_total = sum(JULY17_BASELINE.values())

    fetched_rows = [
        {
            "track_ref": ref_by_track_id[tid],
            "date": FETCHED_DATE,
            "streams": fetched_by_ref[ref_by_track_id[tid]],
            "daily_delta": fetched_by_ref[ref_by_track_id[tid]] - streams,
        }
        for tid, streams in JULY17_BASELINE.items()
    ]
    fetched_total = sum(fetched_by_ref[ref_by_track_id[tid]] for tid in JULY17_BASELINE)

    print(f"Inserting {BASELINE_DATE} baseline (total={baseline_total:,})...")
    sb("POST", "/track_daily_stats",
       params={"on_conflict": "track_ref,date"},
       headers={"Prefer": "resolution=merge-duplicates"},
       json=baseline_rows)
    sb("POST", "/artist_daily_stats",
       params={"on_conflict": "artist_id,date"},
       headers={"Prefer": "resolution=merge-duplicates"},
       json=[{
           "artist_id": BLACKPINK_ID,
           "date": BASELINE_DATE,
           "total_streams": baseline_total,
           "daily_delta": None,
           "followers": None,
           "monthly_listeners": None,
           "track_count": len(JULY17_BASELINE),
       }])

    print(f"Inserting {FETCHED_DATE} (total={fetched_total:,}, delta={fetched_total - baseline_total:,})...")
    sb("POST", "/track_daily_stats",
       params={"on_conflict": "track_ref,date"},
       headers={"Prefer": "resolution=merge-duplicates"},
       json=fetched_rows)
    sb("POST", "/artist_daily_stats",
       params={"on_conflict": "artist_id,date"},
       headers={"Prefer": "resolution=merge-duplicates"},
       json=[{
           "artist_id": BLACKPINK_ID,
           "date": FETCHED_DATE,
           "total_streams": fetched_total,
           "daily_delta": fetched_total - baseline_total,
           "followers": followers,
           "monthly_listeners": monthly_listeners,
           "track_count": len(JULY17_BASELINE),
       }])

    print("Done.")


if __name__ == "__main__":
    main()
