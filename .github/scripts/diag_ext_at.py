"""Read-only diagnostic: is vma_user_votes.ext_at present and being set?

Prints today's (US-Eastern) rows with their ext_at, so we can see whether the
extension/app votes are marking the day as counter-logged (which hides the
manual form). Writes nothing.
"""
import os
from datetime import datetime, timezone, timedelta
import httpx

URL = os.environ["SUPABASE_URL"]
KEY = os.environ["SUPABASE_SERVICE_KEY"]
H = {"Authorization": f"Bearer {KEY}", "apikey": KEY}

# US-Eastern date (EDT = UTC-4 in August) — matches the API's etDay().
et = datetime.now(timezone.utc) - timedelta(hours=4)
today = et.strftime("%Y-%m-%d")
print("ET today:", today)

# 1) Does the column exist? Selecting it errors 400 if the migration didn't apply.
print("\n--- column check (select ext_at) ---")
r = httpx.get(
    f"{URL}/rest/v1/vma_user_votes?select=app_user_id,day,votes,bp,lisa,ext_at,display_name"
    f"&day=eq.{today}&order=updated_at.desc&limit=25",
    headers=H, timeout=30,
)
print("HTTP", r.status_code)
print(r.text[:4000])

# 1b) What does a POST to the vote endpoint actually do? (redirect? 401 direct?)
# This mirrors exactly what the Android app faces. A dummy token → expect 401 if
# the app reaches the handler directly, or 3xx + Location if it must follow a redirect.
print("\n--- POST endpoint behavior (dummy token, no redirect-follow) ---")
try:
    pr = httpx.post(
        "https://blinksunited.com/api/vma-votes",
        json={"extToken": "diagnostic-dummy", "votes": 1, "breakdown": {"BLACKPINK": 1}},
        follow_redirects=False, timeout=20,
    )
    print("POST status:", pr.status_code, "| Location:", pr.headers.get("location"))
    print("body:", pr.text[:300])
except Exception as e:
    print("POST error:", type(e).__name__, e)

if r.status_code == 200:
    rows = r.json()
    with_ext = [x for x in rows if x.get("ext_at")]
    print(f"\nToday rows: {len(rows)} | with ext_at set: {len(with_ext)}")
    for x in rows[:25]:
        print(f"  {x.get('display_name') or x['app_user_id'][:8]:<20} "
              f"votes={x.get('votes')} bp={x.get('bp')} lisa={x.get('lisa')} "
              f"ext_at={x.get('ext_at')}")
