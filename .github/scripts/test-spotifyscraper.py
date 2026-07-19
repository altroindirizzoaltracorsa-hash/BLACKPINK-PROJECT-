"""
One-off: resolve final track IDs for a kworb-matching fixed track list --
get real play_count for the featured-artist candidates found via search
last run, and confirm the SOLO - Live ambiguity (kworb tracks only the
SEOUL tour version, not THE SHOW or ARENA TOUR OSAKA).
"""

from spotify_scraper import SpotifyClient

CANDIDATE_IDS = {
    "Kiss and Make Up (candidate A)": "7jr3iPu4O4bTCVwLMbdU2i",
    "Kiss and Make Up (candidate B)": "66xk2wDM30vUTw5rsEJexi",
    "Kiss and Make Up (Remix) [Mixed]": "6P8SQWN3pcLKChWHt73fZV",
    "Sour Candy - Shygirl & Mura Masa Remix": "56kudbKiRjWCwiAS3FRHCL",
    "SOLO - Live (SEOUL, expected kworb match)": "40HHE2cHpWC3JajQytQUtD",
    "SOLO - Live (THE SHOW, expected extra)": "6V3dOOUiPg53wUf83tBLR8",
}


def main():
    with SpotifyClient() as client:
        ids = list(CANDIDATE_IDS.values())
        results = client.get_tracks(ids)
        for label, tid, item in zip(CANDIDATE_IDS.keys(), ids, results):
            if not item.ok:
                print(f"{label}  [{tid}]  FAILED: {item.error}")
                continue
            t = item.result
            artists = ", ".join(a.name for a in t.artists)
            album_name = t.album.name if t.album else None
            print(f"{label}  [{tid}]  play_count={t.play_count:,}  name={t.name!r}  artists={artists}  album={album_name!r}")


if __name__ == "__main__":
    main()
