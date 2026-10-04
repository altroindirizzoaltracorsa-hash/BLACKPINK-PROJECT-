"""Exercise snapshot_youtube.py against a stubbed catalog endpoint and Supabase.

Run: python .github/scripts/test_snapshot_youtube.py

No network, no key, no quota. The things covered are the ones that only bite in
production: a delta measured against whatever the previous reading actually was
rather than "yesterday", the real hours between readings, a falling view count
(YouTube recounts, and a negative delta is data), re-running the same day,
videos of every kind being recorded while the board filters later, and refusing
to write an empty reading.
"""
import json
import os
import sys
import types
from datetime import datetime, timezone

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, ".github/scripts"))

# ── stub httpx ─────────────────────────────────────────────────────────────
VIDEOS = [
    {"id": "aaa", "title": "BLACKPINK - 'GO' M/V", "channel": "BLACKPINK",
     "channelId": "UCbp", "kind": "mv", "durationSec": 190,
     "publishedAt": "2016-11-01T00:00:00Z", "views": 96_818_448,
     "next": 100_000_000, "gap": 3_181_552},
    {"id": "bbb", "title": "join the #PinkVenomChallenge", "channel": "BLACKPINK",
     "channelId": "UCbp", "kind": "short", "durationSec": 15,
     "publishedAt": "2022-08-01T00:00:00Z", "views": 129_314_664,
     "next": 200_000_000, "gap": 70_685_336},
    {"id": "ccc", "title": "ROSÉ & Bruno Mars - APT. (Official Music Video)",
     "channel": "ROSÉ", "channelId": "UCro", "kind": "mv", "durationSec": 169,
     "publishedAt": "2024-10-18T00:00:00Z", "views": 2_701_258_074,
     "next": 2_800_000_000, "gap": 98_741_926},
]
CATALOG = {"channels": [{"title": "BLACKPINK", "uploads": 668, "videos": 2},
                        {"title": "ROSÉ", "uploads": 98, "videos": 1}],
           "unresolved": [], "count": len(VIDEOS), "videos": VIDEOS}

DB_VIDEOS = {}      # video_id -> row
DB_STATS = {}       # (video_ref, date) -> row
NEXT_ID = [1]
CALLS = []


class Resp:
    def __init__(self, payload, status=200):
        self._p = payload
        self.status_code = status
        self.is_error = status >= 400
        self.text = json.dumps(payload)
        self.content = self.text.encode()

    def raise_for_status(self):
        if self.is_error:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._p


def fake_get(url, headers=None, timeout=None, follow_redirects=None):
    CALLS.append(("GET", url))
    if "/api/youtube-catalog" in url:
        return Resp(CATALOG)
    raise AssertionError("unexpected GET " + url)


def fake_request(method, url, headers=None, timeout=None, json=None, params=None):
    CALLS.append((method, url))
    path = url.split("/rest/v1", 1)[1]
    params = params or {}
    if path == "/youtube_videos" and method == "POST":
        out = []
        for row in json:
            existing = DB_VIDEOS.get(row["video_id"])
            if existing:
                existing.update(row)
                out.append(existing)
            else:
                rec = {**row, "id": NEXT_ID[0]}
                NEXT_ID[0] += 1
                DB_VIDEOS[row["video_id"]] = rec
                out.append(rec)
        return Resp(out)
    if path == "/youtube_video_daily_stats" and method == "GET":
        rows = sorted(DB_STATS.values(), key=lambda r: r["captured_at"], reverse=True)
        return Resp(rows)
    if path == "/youtube_video_daily_stats" and method == "POST":
        for row in json:
            DB_STATS[(row["video_ref"], row["date"])] = dict(row)
        return Resp([])
    raise AssertionError("unexpected " + method + " " + path)


httpx_stub = types.ModuleType("httpx")
httpx_stub.get = fake_get
httpx_stub.request = fake_request
sys.modules["httpx"] = httpx_stub

os.environ.update({
    "ADMIN_KEY": "k", "SUPABASE_URL": "https://stub",
    "SUPABASE_SERVICE_KEY": "s", "MIN_VIEWS": "50000000",
})
os.environ.pop("DRY_RUN", None)
os.environ.pop("OVERRIDE_DATE", None)

import snapshot_youtube as S  # noqa: E402

FAILS = []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        FAILS.append(msg)


def run_at(ts):
    """One snapshot, with the clock pinned."""
    real = S.datetime

    class Clock(real):
        @classmethod
        def now(cls, tz=None):
            return ts
    S.datetime = Clock
    try:
        return S.main()
    finally:
        S.datetime = real


print("--- the first reading")
t0 = datetime(2026, 10, 5, 4, 41, tzinfo=timezone.utc)
check(run_at(t0) == 0, "returns 0")
check(len(DB_VIDEOS) == 3, f"all 3 videos upserted ({len(DB_VIDEOS)})")
check(len(DB_STATS) == 3, f"3 readings written ({len(DB_STATS)})")
check(all(r["daily_delta"] is None for r in DB_STATS.values()),
      "every delta is NULL — there is nothing to compare against yet")
check(all(r["hours_since"] is None for r in DB_STATS.values()), "and no hours_since")
kinds = {v["kind"] for v in DB_VIDEOS.values()}
check("short" in kinds,
      "a Short is RECORDED even though the board will not show it — "
      "filtering is a read-time decision, history is not re-fetchable")

print("\n--- a second reading, 23.5 hours later")
VIDEOS[0]["views"] = 96_950_000          # GO:  +131,552
VIDEOS[2]["views"] = 2_703_900_000       # APT: +2,641,926
t1 = datetime(2026, 10, 6, 4, 11, tzinfo=timezone.utc)
check(run_at(t1) == 0, "returns 0")
go = DB_STATS[(DB_VIDEOS["aaa"]["id"], "2026-10-06")]
apt = DB_STATS[(DB_VIDEOS["ccc"]["id"], "2026-10-06")]
check(go["daily_delta"] == 131_552, f"GO delta is 131,552 (got {go['daily_delta']:,})")
check(abs(go["hours_since"] - 23.5) < 0.01,
      f"hours_since is the REAL elapsed time, 23.5 not 24 (got {go['hours_since']})")
rate = apt["daily_delta"] / apt["hours_since"] * 24
check(abs(rate - 2_697_000) < 5_000,
      f"so APT's rate is {rate:,.0f}/day, not {apt['daily_delta']:,.0f} — "
      "a 23.5h gap read as a day would understate it by 2%")

print("\n--- a delayed run, 31 hours later")
VIDEOS[0]["views"] = 97_100_000          # +150,000 over 31h
t2 = datetime(2026, 10, 7, 11, 11, tzinfo=timezone.utc)
run_at(t2)
go2 = DB_STATS[(DB_VIDEOS["aaa"]["id"], "2026-10-07")]
check(abs(go2["hours_since"] - 31.0) < 0.01, f"hours_since is 31 (got {go2['hours_since']})")
true_rate = go2["daily_delta"] / go2["hours_since"] * 24
naive = go2["daily_delta"]
check(abs(true_rate - 116_129) < 500 and naive == 150_000,
      f"the honest rate is {true_rate:,.0f}/day where delta-as-a-day says "
      f"{naive:,} — 29% high, which is why hours_since exists")

print("\n--- YouTube takes a count back down")
VIDEOS[2]["views"] = 2_703_000_000        # APT loses 900,000 to a recount
t3 = datetime(2026, 10, 8, 4, 41, tzinfo=timezone.utc)
run_at(t3)
apt2 = DB_STATS[(DB_VIDEOS["ccc"]["id"], "2026-10-08")]
check(apt2["daily_delta"] == -900_000,
      f"the negative delta is stored as-is ({apt2['daily_delta']:,}) — "
      "recounts are real and clamping them would invent views")

print("\n--- re-running the same day")
before = len(DB_STATS)
VIDEOS[0]["views"] = 97_200_000
run_at(datetime(2026, 10, 8, 9, 0, tzinfo=timezone.utc))
check(len(DB_STATS) == before,
      f"no duplicate rows — the upsert is on (video_ref, date) ({before} → {len(DB_STATS)})")
check(DB_STATS[(DB_VIDEOS["aaa"]["id"], "2026-10-08")]["views"] == 97_200_000,
      "and the row is corrected to the later reading")

print("\n--- a retitled / reclassified video keeps its history")
rows_before = sum(1 for (ref, _) in DB_STATS if ref == DB_VIDEOS["bbb"]["id"])
VIDEOS[1]["title"] = "BLACKPINK - 'Pink Venom' M/V"
VIDEOS[1]["kind"] = "mv"
run_at(datetime(2026, 10, 9, 4, 41, tzinfo=timezone.utc))
check(DB_VIDEOS["bbb"]["kind"] == "mv", "kind is refreshed on the existing row")
rows_after = sum(1 for (ref, _) in DB_STATS if ref == DB_VIDEOS["bbb"]["id"])
check(rows_after == rows_before + 1,
      f"and every earlier reading survives ({rows_before} → {rows_after})")

print("\n--- an empty catalogue is refused")
saved = list(CATALOG["videos"])
CATALOG["videos"] = []
check(run_at(datetime(2026, 10, 10, 4, 41, tzinfo=timezone.utc)) == 1,
      "exits non-zero rather than recording a day where everything vanished")
CATALOG["videos"] = saved

print("\n--- DRY_RUN writes nothing")
# Set on the module, not in os.environ: the script reads its config once at
# import, the same as the other scripts here, so the workflow's env is what
# matters in production and a late os.environ change would do nothing.
S.DRY_RUN = True
n = len(DB_STATS)
check(run_at(datetime(2026, 10, 11, 4, 41, tzinfo=timezone.utc)) == 0, "returns 0")
check(len(DB_STATS) == n, f"and the table is untouched ({n} rows)")
S.DRY_RUN = False

print(f"\nFAILURES: {len(FAILS)}")
for f in FAILS:
    print("  - " + f)
sys.exit(1 if FAILS else 0)
