"""
Read-only: fetch what the live /streams page fetches (the public detail API on
the Vercel deployment) and print the corrected Aug 3 / Aug 2 numbers for a few
spot-check tracks per artist. Confirms the live site now serves the fix.
"""

import httpx

BASE = "https://www.blinksunited.com/api/proxy-image"

# artist_id -> (label, [track names to spot-check], expected aug3 daily_delta)
WATCH = {
    "6UZ0ba50XreR4TM8u322gs": ("JISOO",  {"FLOWER": 131_542, "earthquake": 153_615}),
    "250b0Wlc5Vk0CoUsaCY84M": ("JENNIE", {"Black (Feat. JENNIE of BLACKPINK)": 47_093,
                                          "Dracula - JENNIE Remix": 1_715_483}),
    "3eVa5w3URK5duf6eyVDbu9": ("ROSÉ",   {"Without You (Feat. ROSE)": 44_548, "APT.": 1_388_478}),
    "5L1lO4eRHmJ7a0Q6csE5cT": ("LISA",   {"Shoong! (feat. LISA of BLACKPINK)": 43_441,
                                          "MONEY": None}),
    "41MozSoPIsD1dJM0CLPjZF": ("BLACKPINK", {"How You Like That": None, "JUMP": None, "GO": None}),
}


def main():
    with httpx.Client(timeout=30, follow_redirects=True) as c:
        for aid, (label, watch) in WATCH.items():
            r = c.get(BASE, params={"artist_streams": "detail", "artist": aid})
            print(f"\n=== {label} ({aid})  HTTP {r.status_code} ===")
            if r.is_error:
                print(f"  ERROR: {r.text[:200]}")
                continue
            data = r.json()
            daily = data.get("daily") or []
            if daily:
                top = daily[0]
                print(f"  artist latest: {top.get('date')}  total={top.get('total_streams'):,}  "
                      f"daily_delta={top.get('daily_delta'):,}")
            by_name = {t.get("name"): t for t in (data.get("tracks") or [])}
            for name, expected in watch.items():
                t = by_name.get(name)
                if not t:
                    print(f"  [{name}] NOT FOUND in response")
                    continue
                dd = t.get("daily_delta")
                prev = t.get("prev_daily_delta")
                flag = ""
                if expected is not None and dd is not None:
                    flag = "  ✓ matches" if dd == expected else f"  ✗ expected {expected:,}"
                print(f"  [{name}] streams={t.get('streams'):,}  "
                      f"aug3_daily={dd:,}  aug2_daily={prev if prev is None else format(prev, ',')}{flag}")


if __name__ == "__main__":
    main()
