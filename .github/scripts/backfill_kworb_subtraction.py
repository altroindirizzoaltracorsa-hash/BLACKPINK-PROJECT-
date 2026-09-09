"""
One-time fix, not part of the daily pipeline:

kworb shows both a track's cumulative total and its most recent daily
delta, so total - daily reconstructs the previous day's total for free,
without needing another kworb snapshot. Validated exactly against
BLACKPINK's already-known 07-16 total (0 discrepancy) before trusting
it for the other artists.

The trickier part: kworb's "Last updated" date on each member's chart
page is NOT the date the shown total reflects. Cross-checking each
member's raw kworb total against our own freshly-fetched 07-18 figures
shows a consistent pattern -- kworb_total_date = last_updated - 1 day
(Spotify's own public count always lags a day behind whenever kworb
scraped):
  - JENNIE, ROSÉ (last_updated 07-19): raw total ~= our 07-18 fetch,
    so total - daily gives a real 07-17 baseline.
  - LISA (last_updated 07-18): raw total ~= 07-17 (one day behind
    ours), so the raw total itself is usable as 07-17, and
    total - daily reaches back to 07-16.
  - JISOO (last_updated 07-13): raw total is ~6 days behind our
    07-18 fetch -- too stale to use as a "previous day" baseline
    without mislabeling a 6-day gap as a 1-day delta. Skipped; she'll
    get a real delta from the next fetch instead.

Requires SUPABASE_URL / SUPABASE_SERVICE_KEY env vars.
"""

import os
import sys

import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

BLACKPINK_ID = "41MozSoPIsD1dJM0CLPjZF"
JENNIE_ID = "250b0Wlc5Vk0CoUsaCY84M"
ROSE_ID = "3eVa5w3URK5duf6eyVDbu9"
LISA_ID = "5L1lO4eRHmJ7a0Q6csE5cT"

# (track_id, total_as_shown_by_kworb, daily_delta_as_shown_by_kworb)

# BLACKPINK: kworb total = 07-17 (already used as the 07-17 baseline
# elsewhere). total - daily = 07-16.
BLACKPINK_ROWS = [
    ("4SFknyjLcyTLJFPKD2m96o", 1267632650, 242781),
    ("6hvczQ05jc1yGlp9zhb95V", 1052026975, 223538),
    ("6stcJnJHPO8RrYx5LLz5OP", 1020348135, 252308),
    ("0ARKW62l9uWIDYMZTUmJHF", 898290276, 214426),
    ("4lQsB3ERTWSNaAN1IkuNRl", 879065649, 203251),
    ("4ZxOuNHhpyOj4gv52MtQpT", 801965667, 224293),
    ("7jr3iPu4O4bTCVwLMbdU2i", 773508044, 134616),
    ("4Ws314Ylb27BVsvlZOy30C", 733188593, 158825),
    ("13MF2TYuyfITClL1R2ei6e", 715512280, 210257),
    ("4JUPEh2DVSXFGExu4Uxevz", 669710284, 95104),
    ("5jQ3mnhNhs9VuEvmVKllWM", 653502210, 700771),
    ("1XnpzbOGptRwfJhZgLbmSr", 589057797, 124364),
    ("7qmvLmX9tyaTiBAVNI6YEn", 559500377, 136926),
    ("6NEoeBLQbOMw92qMeLfI40", 500292309, 123558),
    ("0L8LOav65XwLjCLS11gNPD", 480418783, 97025),
    ("6veFyjNycn6EaNCKhkPXUY", 443434050, 113897),
    ("6R6ZoHTypt5lt68MWbzZXv", 423770954, 57066),
    ("38SKB7UfhL6Sd6Joxex5yK", 364515912, 71769),
    ("0bYVPJvXr8ACmw313cVvhB", 341915180, 61181),
    ("7iKDsPfLT0d5mu2htfMKBZ", 290833205, 65874),
    ("3tP6QKbXvtrxiDI7QwKyUf", 285085746, 57749),
    ("7qq0EOPW4RRlqdvMBmdd73", 280172695, 48807),
    ("3MJhPqL2IgGs7gHEB2M35q", 271177496, 48096),
    ("7iAgNZdotu40NwtoIWJHFe", 221923584, 29636),
    ("39kzWAiVPpycdMpr745oPj", 205883985, 33361),
    ("2URMA0ap6SAI8wFmcY1yta", 197104604, 35263),
    ("4rsoLz7ZY1Ldz8dpm4Lqtg", 191160778, 33990),
    ("2REoTZjaB3jyAt5dgkV5GK", 172408718, 33734),
    ("1mFpMoeZfkIqtqW2AfQ8ba", 165681911, 40032),
    ("1XoY4WZrvPIphBaikXGjF8", 164897610, 35171),
    ("7Dq4YNgsltQuTmhYz1wJzq", 150452907, 32815),
    ("5TfKoQg9AjmDIWYKFoDqMN", 147305137, 28476),
    ("3eZD5DZGibwxMAOaCMBg3k", 141200710, 22855),
    ("5nIjOnMbC0QDMrYFLGx0yV", 99371652, 11025),
    ("4sz6sircK4Jn2SZSHgd96h", 94210883, 14469),
    ("0mYa3o6tlUN5HRippmKmwH", 91335274, 223048),
    ("4jUEHIrc443f743JbyLN0y", 80860432, 10246),
    ("20MOKIGONywL5xIoB7RRAR", 80323489, 13060),
    ("1fMXWEkJpIH483OrKn1zFV", 79206081, 11182),
    ("5DVgfulxeJZJYc8FseyfUf", 55825504, 12597),
    ("02h4inVwwNX1cMuGCDtsgV", 46408595, 6386),
    ("3sgrwjWNJy753U30irIdEN", 46145369, 3213),
    ("3oraRy91vke1aof4tIrQfr", 45291797, 107987),
    ("29x3S9kmzTGHswtjSVeUPr", 43897039, 3789),
    ("437Wn1icOBdhQaVnpJpl0F", 42594608, 6115),
    ("7IS4NciwYPs1wMywOKx69z", 39654564, 5364),
    ("6OKXcx7tClGAS0o2cOTl2v", 38180948, 5553),
    ("4AESxPBujvuBbCAfBuA2sq", 37954138, 3471),
    ("3mpGXkkjhY8K5C9OsaCMBo", 37733330, 2168),
    ("6X9DNG2WR3IclfneGurU0T", 32812380, 9090),
    ("5MXcM263QvCTWriH3nVusc", 32130492, 74789),
    ("7Iv6YcXoLNhTPYhHqtyNUy", 24803169, 3719),
    ("7m0duH1vdTNxM2g8BLfR0F", 23417879, 46520),
    ("52lsilmqW7xWeJXARzwz3z", 20343541, 1742),
    ("1sIKkwYIffUw0vLU8RsWIR", 15036681, 1940),
    ("04LWm93tY9nwdlI9EO54HP", 14119677, 1245),
    ("1GrGs8HBvOHHdeho4w1ZkH", 13513528, 2947),
    ("3ua8wdqzl3SdgElppgcuf2", 12629566, 2742),
    ("0UJRzax7oFLoK8Sb9IcPcm", 11551215, 1860),
    ("59DULbyccrhJJb3Ko2bXFz", 11283996, 2956),
    ("20O6VxUyfLn6Zk8izFpMeu", 11030791, 1950),
    ("3VrjgpzoorLGYfaOXaOXOT", 10849190, 4979),
    ("4gXhyN8S81jbq50NdEUcLR", 10775035, 2373),
    ("3p9HltmtqXCvCSKKOKMZ29", 10569964, 1950),
    ("4GPLXDicIuRmAELK5RWvCw", 10202462, 2066),
    ("56kudbKiRjWCwiAS3FRHCL", 9519374, 1266),
    ("76F0GgW1qB7nED5CQeZSrX", 8919777, 2269),
    ("6BYdrWzCp2tL2RKSoncArx", 8662950, 1741),
    ("7jKhvwWoXGmfc8Ehc4kFrt", 8656157, 2053),
    ("7fqjqOu4HKTN2yP6aV8lpQ", 8631784, 653),
    ("2jjh53eV2QVGIRjGTawheD", 7859381, 462),
    ("3RTSq1hwAr5CHB10SiWeDX", 7663377, 1136),
    ("1kUXkPQh6G8GLAIVIMgJwk", 6915190, 1443),
    ("40HHE2cHpWC3JajQytQUtD", 6873043, 722),
    ("5dUFWYt4BJfWlhC9CxWFGe", 6806133, 1350),
    ("60IHvjpylI1IZHVSZnQSKJ", 6552707, 804),
    ("5ROltcFSXdACTwRwOyJRzv", 6499242, 1431),
    ("5SK8ZoIj62LTcRW7OQ8vtZ", 6421176, 952),
    ("3QCRpdVPsCK11k5zUMfc1l", 5728159, 1235),
    ("6149wOhItvVX0zoa1KK5hw", 5723748, 967),
    ("1b7PAugOHr8ZjD1Dbj8fON", 5626661, 472),
    ("38eKmp6QjELXKgLh0pePfG", 5574183, 903),
    ("3F7VrA3ttl6i6Z4b2KJ9YR", 5510950, 716),
    ("3fo1Z8nJX9gRHYPjb4mgJs", 5406468, 829),
    ("6zlLFk0ZjBkA80p6xcZ8Ac", 5326113, 527),
    ("6w5egqwHmhrBJsw8soFcuU", 5279136, 785),
    ("3mGle2Kpzw3E6G0g0T79QN", 5271279, 539),
    ("3KcrCvutXhEEinowTrLfN4", 5195412, 662),
    ("2u8Msh7gewUrmJ74K8HZNq", 4986495, 735),
    ("7ov2yk9ZbtJoOpcd7QoRwd", 4586437, 644),
    ("2QG3xa5guVkZhqZtuZZKgz", 4574024, 438),
    ("3u6Knotm44XwggprlvmPtW", 4539232, 438),
    ("3iC3qlIi0KqATuA86pRGcZ", 4509421, 552),
    ("7pt16OMGqeqivEeI1PzkfC", 4353440, 408),
    ("3b7trEcKoglybN5MxGuSaw", 4199496, 681),
    ("04xEHIAK4MsI7ZSN1hSDQN", 4140943, 722),
    ("6HHbjSWWGh6j9JcmLZ41Py", 4133289, 642),
    ("6PDvHZDWtGSVr8LXN3stsH", 4056857, 380),
    ("0ZnRursj0XlLszToN6wNV2", 3990488, 368),
    ("1hPIpoUwxbXBp5fGMSDcXx", 3952975, 637),
    ("6P8SQWN3pcLKChWHt73fZV", 3855604, 240),
    ("5IKRga8drUYZ5IqON5xXbx", 3639160, 404),
    ("614TWJTbiXsJCPxMpnKi0L", 3625289, 376),
    ("3oZWZlxfXuUbbUPndAfmRR", 3506385, 331),
    ("06WghRVH4Yyvu4mtDJ0bfU", 3052448, 327),
    ("1uK64bAOSKhKFTUwrF2r2p", 2989221, 357),
    ("32ssBfmhrG6qbEapVNwAOm", 2972836, 310),
    ("3QuzFJUtG9H4RoEv5J9mCP", 2790334, 320),
    ("5x9VzjchhXQfDBZcnO5xPM", 2730900, 289),
    ("4sB4UCnEu6UVC0dWtCqUAT", 2538217, 308),
    ("6b5xktkZLF96lv5HrFucu4", 2383379, 271),
    ("7nWREW5AWOgLMmW6jKJUEz", 2194915, 291),
    ("5dYjvCegNq6LbwWTzy1xIC", 2077223, 233),
]

# JENNIE, ROSÉ: kworb total ~= our 07-18 fetch. total - daily = 07-17.
JENNIE_ROWS = [
    ("7CyPwkp0oE8Ro9Dd5CUDjW", 2741871447, 1684289),
    ("0PEKVfePLFsfEkVZaCx5iX", 899163751, 757606),
    ("2wVDWtLKXunswWecARNILj", 790601257, 139697),
    ("3I7XqNhgMRya2ABXn6TSKW", 564363510, 308902),
    ("3EXdpAjly41WqLfR2yRIkm", 417843765, 2164302),
    ("6gcuJpHu0Ey30D5WR76y98", 347066240, 116495),
    ("17sidmT6WatICg5ovmhaQR", 337974016, 206093),
    ("1SS0WlKhJewviwEDZ6dWj0", 299422592, 125391),
    ("7qnvIAXsz6zKV3qUx0MMOk", 238367563, 136876),
    ("4rWsr6ogk0wyvRbTLAgM8X", 212801128, 153313),
    ("3Rb70FTNnpmhDjTIWNlkww", 197535548, 236668),
    ("0Vz146N2GxkVJw4kSGXrNi", 115048781, 32322),
    ("0BpDXGD919oMdvaNjgVCM3", 107232748, 106276),
    ("1i6BItuKCtaHiigEKQovXb", 104683977, 97220),
    ("2DZSXLAGHnylRgIjeUohB6", 98331277, 82870),
    ("7qnFp5pMVxpzQ28amUViti", 78625822, 68999),
    ("44f1TNdoQUgf3PUYraCTsH", 70551628, 36196),
    ("66Gjy8EYVt1usTyGs4mKsl", 48203534, 48231),
    ("4WfGDkm99oLJSAtELYZYEd", 47820720, 23535),
    ("2qgS0EKSu94srT6vmj7Ig9", 46101450, 51829),
    ("1utoANwmFNan7ctGw8JaHT", 45888440, 36337),
    ("6V3dOOUiPg53wUf83tBLR8", 42302762, 13045),
    ("7fqrLh4hLXuoneIiADdea4", 35104935, 28395),
    ("0bhGIXbb89rgxw78RhNrdd", 33879571, 29214),
    ("5Y1JLn2xFudNJolHkvoTXk", 33249767, 12075),
    ("1053UWA7fTbVLxBX8R9ClO", 20233861, 80491),
    ("5S7by1wwGii36WAs4sBjzc", 14051003, 5299),
    ("3bWm8ejTzkMhPSdBnpxLvl", 13944211, 9007),
    ("6Mg21kBQhf0VScEF8DL4LD", 13279727, 10582),
    ("4MwT3qzF3tfMtSFr9b2nKa", 12127801, 3765),
    ("7L0dopNg5r1I6OHcVpA47E", 10213236, 29316),
    ("7zNS5065xzKyhOBMOj7pCr", 7314272, 6773),
    ("0dTGUMURaPzBEKEOnXg52x", 5586637, 14461),
    ("5MeZi3LNNCWPEQB0jxGSRe", 5210759, 16774),
    ("4oN4odRiXgTMnaAjz7kinV", 5002678, 5065),
    ("6d611NNmXpV1Upyja5RNOY", 3044240, 11442),
    ("43R47pIQW72NgpKeGIXS7x", 2741313, 8927),
    ("53AnN5mzvc62M1KOT45ffl", 2713488, 16166),
    ("6pITIqSBFvBcafDKwEaJgc", 772363, 432),
    ("4wE6cxIiCKdygPY4oQJC6p", 479784, 1132),
]

ROSE_ROWS = [
    ("4wJ5Qq0jBN4ajy7ouZIV1c", 2548348263, 1521777),
    ("2pn8dNVSpYnAtlKFC8Q0DJ", 588739644, 92379),
    ("2dHoVW9AxJVSRebPRyV2aA", 469554451, 97133),
    ("1z5ebC9238uGoBgzYyvGpQ", 458547491, 318809),
    ("1lcBt7LoEikqYmhUoa2cez", 350468399, 224853),
    ("6Wobsw9uZ0D0xkfOjxXSq9", 189738300, 153912),
    ("1tMRh8jiYlmatpVeWWesCe", 140632495, 147297),
    ("3fpWkbEZMP1BgOOfymwoaS", 137585457, 81333),
    ("5OdI6v2L7Aez4cclpbojiZ", 109371505, 86686),
    ("3V375E3xldRPEEcIKiw83l", 104159836, 37084),
    ("3y4q6bBdbXsTIaPiwiiUfy", 93701349, 78204),
    ("4HxGH28DitgAuuKpEVrLzN", 92850726, 66393),
    ("77n3jFGqPPxYrEGwrWylNv", 90558989, 52272),
    ("3tDF6qjNrabjnb23RB2rpa", 57186530, 39071),
    ("50aQbgfdydBXABx2gATQHn", 55957300, 39605),
    ("5a3tLTGA0HIDtrvnszXXBN", 46877559, 32081),
    ("67siqMtQTGPpJZI4Dz8OpM", 45976090, 25324),
    ("5lnmMdUf1ifC0Oa8wsKuyW", 30518247, 5196),
]

# LISA: kworb total ~= 07-17 already (one day behind ours). Used both
# as-is (07-17) and total - daily (07-16).
LISA_ROWS = [
    ("7hU3IHwjX150XLoTVmjD0q", 1424219628, 204286),
    ("7uQZVznj0uQOGC9KhV2Mg6", 645805014, 107304),
    ("65ZihkVQO3KqPj7ZKxmcev", 613221451, 314428),
    ("3YfHR9NFs5dJP82s5Y0dum", 432151000, 161322),
    ("5UmfBGfRJgjZ8CdhgffabQ", 412934816, 139793),
    ("7KNmIjcmGJIBrhP2s5Vioe", 379157332, 217529),
    ("6IPNp9PfaEqrzotY47TIWy", 349639619, 66577),
    ("5HrIcZOo1DysX53qDRlRnt", 221694003, 47669),
    ("4rBRRLgdB9DYJhqA9uVcWt", 110614229, 53997),
    ("5MI9rnOsAayuxi7pKVydNg", 103557123, 60170),
    ("78w38QMvXYulFfP6AKFVdk", 97562267, 103843),
    ("1QIUF20HdqMA0CJvkBOHNb", 73742761, 47992),
    ("4JxY3pNkxMKHjrPiOGQqcQ", 59065449, 38298),
    ("01prGWjCTxKBxJc400zwvQ", 57906926, 16337),
    ("6a3HxWNiBhr3tNYoqaCbLt", 51239962, 45567),
    ("4QR40LqFAbMdabh4AoZJGZ", 50680662, 202706),
    ("5cmP0BuMRba0q0pwN7eI6u", 50402008, 40327),
    ("4d3buGFeBDfll8IpoMRCQn", 39702631, 31356),
    ("5hv6DLR5Vr5dVk4ahNBoDU", 39658405, 37964),
    ("3hdGyxmW0eNskNwTwmXOIQ", 32068470, 323968),
    ("03qZDQKRYZdjhKsQ5G5H0t", 24404570, 16738),
    ("5TXztZ5uNjv2XtUupk3i7w", 20736141, 16490),
    ("1OIgLu7U7Y98mgZBmkwCue", 16014433, 11890),
    ("7grL80WBzT5yxhpTkXIvJe", 12362053, 1302),
    ("2Dtev1Evm1XyyTRhb6UaD8", 11943149, 927),
    ("64Wx8rvZgTwXgoVrapW1mj", 11434894, 1448),
    ("3cRVqcndSoWFjf3QNTDoNx", 10204091, 1319),
    ("5b9Y4mNT08ZyHIcpwA22UW", 6182568, 1156),
    ("7yRkdZDEKjSUP45TlkGvCd", 5878440, 4543),
    ("081JMVQTWrKiyKliR4kMc5", 2109243, 211),
    ("1D9P2uPplvJUBZqs5v3gdU", 423020, 307),
]


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


def track_ref_map(artist_id):
    tracks = sb("GET", "/artist_tracks", params={"artist_id": f"eq.{artist_id}", "select": "id,source_track_ids"})
    ref_by_track_id = {}
    for t in tracks:
        for tid in t["source_track_ids"]:
            ref_by_track_id[tid] = t["id"]
    return ref_by_track_id


def upsert_day(artist_id, date, rows, ref_by_track_id, prev_date_for_delta=None, prev_by_ref=None):
    """rows: [(track_id, streams), ...]. Upserts track_daily_stats +
    artist_daily_stats for `date`. If prev_by_ref given, computes deltas
    against it; else deltas are null."""
    missing = [tid for tid, _ in rows if tid not in ref_by_track_id]
    if missing:
        print(f"  FATAL: {len(missing)} track IDs have no artist_tracks row: {missing}", file=sys.stderr)
        sys.exit(1)

    track_rows = []
    for tid, streams in rows:
        ref = ref_by_track_id[tid]
        prev = prev_by_ref.get(ref) if prev_by_ref else None
        track_rows.append({
            "track_ref": ref,
            "date": date,
            "streams": streams,
            "daily_delta": (streams - prev) if prev is not None else None,
        })
    sb("POST", "/track_daily_stats",
       params={"on_conflict": "track_ref,date"},
       headers={"Prefer": "resolution=merge-duplicates"},
       json=track_rows)

    total = sum(streams for _, streams in rows)
    prev_total = sb("GET", "/artist_daily_stats", params={
        "artist_id": f"eq.{artist_id}", "date": f"eq.{prev_date_for_delta}", "select": "total_streams",
    }) if prev_date_for_delta else None
    prev_total_val = prev_total[0]["total_streams"] if prev_total else None

    sb("POST", "/artist_daily_stats",
       params={"on_conflict": "artist_id,date"},
       headers={"Prefer": "resolution=merge-duplicates"},
       json=[{
           "artist_id": artist_id,
           "date": date,
           "total_streams": total,
           "daily_delta": (total - prev_total_val) if prev_total_val is not None else None,
           "followers": None,
           "monthly_listeners": None,
           "track_count": len(rows),
       }])
    print(f"  {artist_id} {date}: total={total:,} ({len(rows)} tracks)")
    return total


def patch_delta(artist_id, date, prev_date, ref_by_track_id, rows):
    """Recompute daily_delta for an EXISTING day's rows against prev_date."""
    ids = [str(ref_by_track_id[tid]) for tid, _ in rows]
    prev_rows = sb("GET", "/track_daily_stats", params={
        "track_ref": f"in.({','.join(ids)})", "date": f"eq.{prev_date}", "select": "track_ref,streams",
    })
    prev_by_ref = {r["track_ref"]: r["streams"] for r in prev_rows}

    cur_rows = sb("GET", "/track_daily_stats", params={
        "track_ref": f"in.({','.join(ids)})", "date": f"eq.{date}", "select": "track_ref,streams",
    })
    patched = []
    for r in cur_rows:
        prev = prev_by_ref.get(r["track_ref"])
        if prev is None:
            continue
        patched.append({"track_ref": r["track_ref"], "date": date, "streams": r["streams"], "daily_delta": r["streams"] - prev})
    if patched:
        sb("POST", "/track_daily_stats",
           params={"on_conflict": "track_ref,date"},
           headers={"Prefer": "resolution=merge-duplicates"},
           json=patched)

    cur_artist = sb("GET", "/artist_daily_stats", params={"artist_id": f"eq.{artist_id}", "date": f"eq.{date}", "select": "total_streams,followers,monthly_listeners,track_count"})
    prev_artist = sb("GET", "/artist_daily_stats", params={"artist_id": f"eq.{artist_id}", "date": f"eq.{prev_date}", "select": "total_streams"})
    if cur_artist and prev_artist:
        c, p = cur_artist[0], prev_artist[0]
        sb("POST", "/artist_daily_stats",
           params={"on_conflict": "artist_id,date"},
           headers={"Prefer": "resolution=merge-duplicates"},
           json=[{
               "artist_id": artist_id, "date": date,
               "total_streams": c["total_streams"],
               "daily_delta": c["total_streams"] - p["total_streams"],
               "followers": c["followers"], "monthly_listeners": c["monthly_listeners"],
               "track_count": c["track_count"],
           }])
    print(f"  patched {artist_id} {date} delta against {prev_date} ({len(patched)} tracks)")


def main():
    # BLACKPINK: insert 07-16 (validated exactly against known aggregate)
    print("=== BLACKPINK 07-16 ===")
    ref = track_ref_map(BLACKPINK_ID)
    rows_0716 = [(tid, total - daily) for tid, total, daily in BLACKPINK_ROWS]
    computed_total = sum(v for _, v in rows_0716)
    assert computed_total == 17517380913, f"BLACKPINK 07-16 total mismatch: {computed_total:,}"
    upsert_day(BLACKPINK_ID, "2026-07-16", rows_0716, ref)

    # JENNIE: insert 07-17, patch 07-18 delta against it
    print("=== JENNIE 07-17 ===")
    ref = track_ref_map(JENNIE_ID)
    rows_0717 = [(tid, total - daily) for tid, total, daily in JENNIE_ROWS]
    upsert_day(JENNIE_ID, "2026-07-17", rows_0717, ref)
    patch_delta(JENNIE_ID, "2026-07-18", "2026-07-17", ref, [(tid, None) for tid, _, _ in JENNIE_ROWS])

    # ROSÉ: insert 07-17, patch 07-18 delta against it
    print("=== ROSÉ 07-17 ===")
    ref = track_ref_map(ROSE_ID)
    rows_0717 = [(tid, total - daily) for tid, total, daily in ROSE_ROWS]
    upsert_day(ROSE_ID, "2026-07-17", rows_0717, ref)
    patch_delta(ROSE_ID, "2026-07-18", "2026-07-17", ref, [(tid, None) for tid, _, _ in ROSE_ROWS])

    # LISA: insert 07-17 (raw total) and 07-16 (total - daily), patch 07-18 delta against 07-17
    print("=== LISA 07-17 & 07-16 ===")
    ref = track_ref_map(LISA_ID)
    rows_0717 = [(tid, total) for tid, total, daily in LISA_ROWS]
    upsert_day(LISA_ID, "2026-07-17", rows_0717, ref)
    rows_0716 = [(tid, total - daily) for tid, total, daily in LISA_ROWS]
    upsert_day(LISA_ID, "2026-07-16", rows_0716, ref, prev_date_for_delta="2026-07-17")
    patch_delta(LISA_ID, "2026-07-18", "2026-07-17", ref, [(tid, None) for tid, _, _ in LISA_ROWS])

    print("Done. JISOO skipped (kworb snapshot too stale to use as a 1-day baseline).")


if __name__ == "__main__":
    main()
