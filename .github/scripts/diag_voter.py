"""Read-only: why is a given voter not ranked on the VMA voting board? Looks the
account up by BU display name or linked scrobbler handle, then dumps their votes,
their user_daily_counts stream rows, and exactly what vma_vote_board's rank gate
(jump+shutdown+ddududu+go for ET-today >= 1) sees. Writes nothing.

Set VOTER to the name to investigate (default LALALAMESAA)."""
import os, json, urllib.request, urllib.parse
from datetime import datetime, timezone, timedelta

BASE  = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1"
KEY   = os.environ["SUPABASE_SERVICE_KEY"]
VOTER = os.environ.get("VOTER", "LALALAMESAA")

def sb(path, params):
    url = BASE + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {KEY}", "apikey": KEY})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

et_today = (datetime.now(timezone.utc) - timedelta(hours=4)).date().isoformat()   # ET ~= UTC-4 (summer)
utc_today = datetime.now(timezone.utc).date().isoformat()
print(f"ET-today (voting board gate) = {et_today}   ·   UTC-today (day_key) = {utc_today}\n")

# 1) find candidate app_user_ids by vote display_name and by linked handle
ids = {}
for row in sb("/vma_user_votes", {"display_name": f"ilike.{VOTER}", "select": "app_user_id,display_name", "limit": "20"}):
    ids[row["app_user_id"]] = row.get("display_name")
for row in sb("/linked_accounts", {"source_username": f"ilike.{VOTER}", "select": "app_user_id,source_username,source", "limit": "20"}):
    ids.setdefault(row["app_user_id"], f"(handle {row['source_username']})")
print(f"matched app_user_ids for {VOTER!r}: {ids or 'NONE FOUND'}\n")

for uid, label in ids.items():
    print(f"==== {uid}  [{label}] ====")
    votes = sb("/vma_user_votes", {"app_user_id": f"eq.{uid}", "order": "day.desc", "select": "day,votes,bp,lisa,display_name,updated_at", "limit": "6"})
    print("  vma_user_votes (recent):")
    for v in votes:
        print(f"     {v['day']}  votes={v['votes']}  bp={v['bp']} lisa={v['lisa']}  name={v.get('display_name')!r}")
    udc = sb("/user_daily_counts", {"app_user_id": f"eq.{uid}", "order": "day_key.desc", "select": "day_key,jump,shutdown,ddududu,ltal,go,sawadika,click,fallenangel,heaven", "limit": "6"})
    print("  user_daily_counts (recent):")
    for r in udc:
        allc = sum((r.get(k) or 0) for k in ('jump','shutdown','ddududu','ltal','go','sawadika','click','fallenangel','heaven'))
        print(f"     {r['day_key']}  jump={r['jump']} sd={r['shutdown']} ddu={r['ddududu']} go={r['go']} ltal={r['ltal']} sawa={r.get('sawadika')} click={r.get('click')} fa={r.get('fallenangel')} hvn={r.get('heaven')}  | all={allc}")
    links = sb("/linked_accounts", {"app_user_id": f"eq.{uid}", "select": "source,source_username"})
    print(f"  linked_accounts: {[(l['source'], l['source_username']) for l in links]}")
    # what the board's rank gate sees:
    et_row = next((r for r in udc if r['day_key'] == et_today), None)
    gate = ((et_row['jump'] or 0)+(et_row['shutdown'] or 0)+(et_row['ddududu'] or 0)+(et_row['go'] or 0)) if et_row else 0
    all_core = sum((r['jump'] or 0)+(r['shutdown'] or 0)+(r['ddududu'] or 0)+(r['go'] or 0) for r in udc)
    print(f"  >> RANK GATE (4-core on ET-today {et_today}) = {gate}  → {'RANKED' if gate>=1 else 'UNRANKED'}")
    print(f"  >> all-core across recent rows = {all_core}\n")
