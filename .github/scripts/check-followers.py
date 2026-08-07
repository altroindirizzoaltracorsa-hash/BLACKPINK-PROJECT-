"""
Read-only. For each artist, dump recent followers / followers_delta and
monthly_listeners / monthly_listeners_delta, to see whether the '+0 followers'
on the site is genuine (Spotify reports follower counts coarsely / flat for
days) or a computation issue. Monthly listeners shown alongside as a contrast.
"""

import os
import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

ARTISTS = {
    "JENNIE": "250b0Wlc5Vk0CoUsaCY84M",
    "BLACKPINK": "41MozSoPIsD1dJM0CLPjZF",
    "ROSÉ": "3eVa5w3URK5duf6eyVDbu9",
    "LISA": "5L1lO4eRHmJ7a0Q6csE5cT",
    "JISOO": "6UZ0ba50XreR4TM8u322gs",
}


def sb(path, **params):
    r = httpx.get(f"{SUPABASE_URL}/rest/v1{path}",
                  headers={"Authorization": f"Bearer {SUPABASE_KEY}", "apikey": SUPABASE_KEY},
                  params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def fmt(v):
    return f"{v:+,}" if isinstance(v, int) else str(v)


def main():
    for name, aid in ARTISTS.items():
        rows = sb("/artist_daily_stats", artist_id=f"eq.{aid}", order="date.desc", limit=8,
                  select="date,followers,followers_delta,monthly_listeners,monthly_listeners_delta")
        print(f"\n=== {name} ===")
        for r in rows:
            fol = r.get("followers")
            fol_s = f"{fol:,}" if isinstance(fol, int) else str(fol)
            ml = r.get("monthly_listeners")
            ml_s = f"{ml:,}" if isinstance(ml, int) else str(ml)
            print(f"  {r['date']}  followers={fol_s:>12} (Δ {fmt(r.get('followers_delta'))})"
                  f"   monthly={ml_s:>12} (Δ {fmt(r.get('monthly_listeners_delta'))})")


if __name__ == "__main__":
    main()
