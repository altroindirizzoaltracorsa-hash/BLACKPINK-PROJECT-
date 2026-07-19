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
JISOO_ID = "6UZ0ba50XreR4TM8u322gs"
JENNIE_ID = "250b0Wlc5Vk0CoUsaCY84M"
ROSE_ID = "3eVa5w3URK5duf6eyVDbu9"
LISA_ID = "5L1lO4eRHmJ7a0Q6csE5cT"

# name -> Spotify track ID. Kept in kworb's own display order/naming so the
# list is easy to re-diff against a future kworb snapshot if needed. A few
# entries per member are tracks where the member is a featured artist on
# someone else's release (not in their own discography, found via search)
# or live/tour tracks credited to them individually that already turned up
# during BLACKPINK's own reconciliation (same track ID reused).
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
    JISOO_ID: [
        ("All Eyes On Me", "2YXswOX5aKv6OHRKUcAMLQ"),
        ("EYES CLOSED (with ZAYN)", "0CC8DrwncRXH6MqAL5A90O"),
        ("EYES CLOSED (with ZAYN) - 0.5X", "0eOpWsum2W5l1KLxJ4QVcM"),
        ("EYES CLOSED (with ZAYN) - 2X", "0IHmXRAKcRd00l50QW5pQU"),
        ("EYES CLOSED (with ZAYN) - BARE", "4tPfvkQAA3q6PF6bkBhvB0"),
        ("EYES CLOSED (with ZAYN) - UNVEILED", "4HB3f71StsELKzgk2iV9mM"),
        ("FLOWER", "69CrOS7vEHIrhC2ILyEi0s"),
        ("Hugs & Kisses", "5nQVbMv0XEGLGB39wpneQI"),
        ("TEARS", "08fvSPSKjoF4vmoEtcGain"),
        ("Your Love", "6TPpCbn9z0IY5Te048iy5R"),
        ("earthquake", "10zywlg5b0gQOC3q1A7ADx"),
        ("earthquake - Sam Feldt remix", "2f7PtCTGJCdGhLSv3prGWw"),
    ],
    JENNIE_ID: [
        ("Black (Feat. JENNIE of BLACKPINK)", "44f1TNdoQUgf3PUYraCTsH"),
        ("Damn Right (feat. Childish Gambino & Kali Uchis)", "2DZSXLAGHnylRgIjeUohB6"),
        ("Damn Right - Just JENNIE", "5MeZi3LNNCWPEQB0jxGSRe"),
        ("Dracula - JENNIE Remix", "3EXdpAjly41WqLfR2yRIkm"),
        ("Dracula - JENNIE Remix - Boys Noize Disko Version", "53AnN5mzvc62M1KOT45ffl"),
        ("Dracula - JENNIE Remix Instrumental", "4wE6cxIiCKdygPY4oQJC6p"),
        ("ExtraL (feat. Doechii)", "17sidmT6WatICg5ovmhaQR"),
        ("ExtraL - Just JENNIE", "0dTGUMURaPzBEKEOnXg52x"),
        ("F.T.S.", "0bhGIXbb89rgxw78RhNrdd"),
        ("Filter", "66Gjy8EYVt1usTyGs4mKsl"),
        ("Handlebars (feat. Dua Lipa)", "4rWsr6ogk0wyvRbTLAgM8X"),
        ("Handlebars - Just JENNIE", "6d611NNmXpV1Upyja5RNOY"),
        ("Intro : JANE with FKJ", "7fqrLh4hLXuoneIiADdea4"),
        ("Love Hangover (feat. Dominic Fike)", "7qnvIAXsz6zKV3qUx0MMOk"),
        ("Love Hangover - Just JENNIE", "43R47pIQW72NgpKeGIXS7x"),
        ("Mantra", "3I7XqNhgMRya2ABXn6TSKW"),
        ("One Of The Girls (with JENNIE, Lily Rose Depp)", "7CyPwkp0oE8Ro9Dd5CUDjW"),
        ("One Of The Girls - A Cappella", "4oN4odRiXgTMnaAjz7kinV"),
        ("One Of The Girls - Instrumental", "7zNS5065xzKyhOBMOj7pCr"),
        ("One Of The Girls - Slowed", "3bWm8ejTzkMhPSdBnpxLvl"),
        ("One Of The Girls - Sped Up", "4WfGDkm99oLJSAtELYZYEd"),
        ("SOLO", "2wVDWtLKXunswWecARNILj"),
        ("SOLO - BLACKPINK ARENA TOUR 2018 \"SPECIAL FINAL IN KYOCERA DOME OSAKA\"", "5S7by1wwGii36WAs4sBjzc"),
        ("SOLO - Live", "6V3dOOUiPg53wUf83tBLR8"),
        ("SPOT!", "1SS0WlKhJewviwEDZ6dWj0"),
        ("Seoul City", "3Rb70FTNnpmhDjTIWNlkww"),
        ("Slow Motion", "5Y1JLn2xFudNJolHkvoTXk"),
        ("Special", "4MwT3qzF3tfMtSFr9b2nKa"),
        ("Starlight", "2qgS0EKSu94srT6vmj7Ig9"),
        ("You & Me", "6gcuJpHu0Ey30D5WR76y98"),
        ("You & Me (Coachella ver.)", "0Vz146N2GxkVJw4kSGXrNi"),
        ("ZEN", "0BpDXGD919oMdvaNjgVCM3"),
        ("like JENNIE", "0PEKVfePLFsfEkVZaCx5iX"),
        ("like JENNIE - EDM Remix", "7L0dopNg5r1I6OHcVpA47E"),
        ("like JENNIE - Extended Remix", "1053UWA7fTbVLxBX8R9ClO"),
        ("like JENNIE - Peggy Gou Remix", "6Mg21kBQhf0VScEF8DL4LD"),
        ("like JENNIE - Peggy Gou Remix - EXTENDED MIX", "6pITIqSBFvBcafDKwEaJgc"),
        ("start a war", "7qnFp5pMVxpzQ28amUViti"),
        ("twin", "1utoANwmFNan7ctGw8JaHT"),
        ("with the IE (way up)", "1i6BItuKCtaHiigEKQovXb"),
    ],
    ROSE_ID: [
        ("3am", "3y4q6bBdbXsTIaPiwiiUfy"),
        ("APT.", "4wJ5Qq0jBN4ajy7ouZIV1c"),
        ("Gone", "2dHoVW9AxJVSRebPRyV2aA"),
        ("Gone - Live", "5lnmMdUf1ifC0Oa8wsKuyW"),
        ("Messy (From F1® The Movie)", "6Wobsw9uZ0D0xkfOjxXSq9"),
        ("On My Mind", "1tMRh8jiYlmatpVeWWesCe"),
        ("On The Ground", "2pn8dNVSpYnAtlKFC8Q0DJ"),
        ("Without You (Feat. ROSE)", "3V375E3xldRPEEcIKiw83l"),
        ("call it the end", "5a3tLTGA0HIDtrvnszXXBN"),
        ("dance all night", "50aQbgfdydBXABx2gATQHn"),
        ("drinks or coffee", "3fpWkbEZMP1BgOOfymwoaS"),
        ("gameboy", "77n3jFGqPPxYrEGwrWylNv"),
        ("not the same", "67siqMtQTGPpJZI4Dz8OpM"),
        ("number one girl", "1lcBt7LoEikqYmhUoa2cez"),
        ("stay a little longer", "5OdI6v2L7Aez4cclpbojiZ"),
        ("too bad for us", "3tDF6qjNrabjnb23RB2rpa"),
        ("toxic till the end", "1z5ebC9238uGoBgzYyvGpQ"),
        ("two years", "4HxGH28DitgAuuKpEVrLzN"),
    ],
    LISA_ID: [
        ("BADGRRRL", "5TXztZ5uNjv2XtUupk3i7w"),
        ("Bad Angel (with LISA)", "4QR40LqFAbMdabh4AoZJGZ"),
        ("Born Again (feat. Doja Cat & RAYE)", "7KNmIjcmGJIBrhP2s5Vioe"),
        ("Born Again (feat. Doja Cat & RAYE) - Purple Disco Machine Extended Mix", "1D9P2uPplvJUBZqs5v3gdU"),
        ("Born Again (feat. Doja Cat & RAYE) - Purple Disco Machine Remix", "7yRkdZDEKjSUP45TlkGvCd"),
        ("Chill", "1QIUF20HdqMA0CJvkBOHNb"),
        ("Dream", "78w38QMvXYulFfP6AKFVdk"),
        ("Elastigirl", "5hv6DLR5Vr5dVk4ahNBoDU"),
        ("FXCK UP THE WORLD (Vixi Solo Version)", "6a3HxWNiBhr3tNYoqaCbLt"),
        ("FXCK UP THE WORLD (feat. Future)", "4rBRRLgdB9DYJhqA9uVcWt"),
        ("Goals", "3hdGyxmW0eNskNwTwmXOIQ"),
        ("LALISA", "7uQZVznj0uQOGC9KhV2Mg6"),
        ("Lifestyle", "5cmP0BuMRba0q0pwN7eI6u"),
        ("MONEY", "7hU3IHwjX150XLoTVmjD0q"),
        ("Moonlit Floor (Kiss Me)", "3YfHR9NFs5dJP82s5Y0dum"),
        ("Moonlit Floor (Kiss Me) - Instrumental", "081JMVQTWrKiyKliR4kMc5"),
        ("Moonlit Floor (Kiss Me) - Live Performance Version", "5b9Y4mNT08ZyHIcpwA22UW"),
        ("Moonlit Floor (Kiss Me) - Santa Baby Remix", "2Dtev1Evm1XyyTRhb6UaD8"),
        ("New Woman (feat. ROSALÍA)", "5UmfBGfRJgjZ8CdhgffabQ"),
        ("Priceless (feat. LISA)", "5MI9rnOsAayuxi7pKVydNg"),
        ("Rapunzel (Kiki Solo Version)", "1OIgLu7U7Y98mgZBmkwCue"),
        ("Rapunzel (feat. Megan Thee Stallion)", "03qZDQKRYZdjhKsQ5G5H0t"),
        ("Rockstar", "65ZihkVQO3KqPj7ZKxmcev"),
        ("Rockstar - Extended", "01prGWjCTxKBxJc400zwvQ"),
        ("Rockstar - Instrumental", "64Wx8rvZgTwXgoVrapW1mj"),
        ("Rockstar - Slowed Down", "3cRVqcndSoWFjf3QNTDoNx"),
        ("Rockstar - Sped Up", "7grL80WBzT5yxhpTkXIvJe"),
        ("SG (with Ozuna, Megan Thee Stallion & LISA of BLACKPINK)", "6IPNp9PfaEqrzotY47TIWy"),
        ("Shoong! (feat. LISA of BLACKPINK)", "5HrIcZOo1DysX53qDRlRnt"),
        ("Thunder", "4d3buGFeBDfll8IpoMRCQn"),
        ("When I'm With You (feat. Tyla)", "4JxY3pNkxMKHjrPiOGQqcQ"),
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
