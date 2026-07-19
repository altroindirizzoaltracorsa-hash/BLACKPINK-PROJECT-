"""
One-off: verify the Spotify artist IDs for the 4 BLACKPINK members before
adding them as tracked_artists, and print follower/monthly-listener
figures as a sanity check against what's publicly visible on their
profile pages.
"""

from spotify_scraper import SpotifyClient

MEMBER_IDS = {
    "3eVa5w3URK5duf6eyVDbu9": "expected JISOO",
    "5L1lO4eRHmJ7a0Q6csE5cT": "expected JENNIE",
    "250b0Wlc5Vk0CoUsaCY84M": "expected ROSÉ",
    "6UZ0ba50XreR4TM8u322gs": "expected LISA",
}


def main():
    with SpotifyClient() as client:
        for aid, label in MEMBER_IDS.items():
            a = client.get_artist(aid)
            avatar = max(a.images, key=lambda im: im.width or 0).url if a.images else None
            print(
                f"{aid}  {label:16s}  actual={a.name!r}  "
                f"followers={a.followers:,}  monthly_listeners={a.monthly_listeners:,}  "
                f"avatar={avatar}"
            )


if __name__ == "__main__":
    main()
