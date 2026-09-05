"""One-off correction: CLICK (JISOO) and SaWaDiKa (LISA) were added to tracking
with a Sep 3 track row of streams=0 (they release Sep 4). They add nothing to the
Sep 3 artist totals, but they bumped artist_daily_stats.track_count 12->13 / 31->32
on Sep 3, which trips the client 'recount' flag and drops the real Sep 3 delta from
the daily average.

Fix: delete the streams=0 Sep 3 track rows and restore Sep 3 track_count, so Sep 3
is a normal counted day and the count change (plus the songs' real streams) lands on
Sep 4. Totals and deltas are NEVER touched. Safety: refuses to delete a row that has
non-zero streams, and only decrements a track_count that is still the inflated value.

Dry-run by default; set APPLY=true to write."""
import os, json, urllib.request, urllib.parse

BASE  = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1"
KEY   = os.environ["SUPABASE_SERVICE_KEY"]
APPLY = os.environ.get("APPLY", "").lower() == "true"
DATE  = "2026-09-03"

def sb(method, path, params=None, body=None, prefer=None):
    url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    headers = {"Authorization": f"Bearer {KEY}", "apikey": KEY, "Content-Type": "application/json"}
    if prefer: headers["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, method=method, headers=headers, data=data)
    with urllib.request.urlopen(req, timeout=30) as r:
        txt = r.read().decode()
        return json.loads(txt) if txt else []

# (artist_id, artist name, new-track ref, track name, expected inflated count, restored count)
JOBS = [
    ("6UZ0ba50XreR4TM8u322gs", "JISOO", 14734, "CLICK",     13, 12),
    ("5L1lO4eRHmJ7a0Q6csE5cT", "LISA",  14827, "SaWaDiKa",  32, 31),
]

print(f"MODE: {'APPLY' if APPLY else 'DRY-RUN (no writes)'} · target date {DATE}\n")

for aid, name, ref, tname, infl, restored in JOBS:
    print(f"==== {name} ({aid}) — {tname} (ref {ref}) ====")

    ads = sb("GET", "/artist_daily_stats", {
        "artist_id": f"eq.{aid}", "date": f"eq.{DATE}",
        "select": "date,total_streams,daily_delta,track_count",
    })
    if not ads:
        print(f"  !! no artist_daily_stats row for {DATE} — skipping\n"); continue
    row = ads[0]
    print(f"  artist row: total={row['total_streams']:,} delta={row['daily_delta']} track_count={row['track_count']}")

    tds = sb("GET", "/track_daily_stats", {
        "track_ref": f"eq.{ref}", "date": f"eq.{DATE}", "select": "track_ref,date,streams",
    })
    trow = tds[0] if tds else None
    print(f"  {tname} {DATE} row: {trow}")

    # ---- safety gates ----
    if trow and trow["streams"] not in (0, None):
        print(f"  !! {tname} has {trow['streams']:,} streams on {DATE} — NOT zero; refusing to delete. Skipping.\n"); continue
    if row["track_count"] != infl:
        print(f"  ~~ track_count is {row['track_count']}, not the inflated {infl} (already fixed?) — will not decrement.\n")
        do_count = False
    else:
        do_count = True

    if not APPLY:
        if trow: print(f"  DRY: would DELETE track_daily_stats(ref={ref}, date={DATE}) [streams=0]")
        if do_count: print(f"  DRY: would SET artist_daily_stats({name},{DATE}).track_count {infl} -> {restored}")
        print()
        continue

    if trow:
        sb("DELETE", "/track_daily_stats", {"track_ref": f"eq.{ref}", "date": f"eq.{DATE}"}, prefer="return=minimal")
        print(f"  deleted track_daily_stats(ref={ref}, date={DATE})")
    if do_count:
        sb("PATCH", "/artist_daily_stats",
           {"artist_id": f"eq.{aid}", "date": f"eq.{DATE}"},
           body={"track_count": restored}, prefer="return=minimal")
        print(f"  set track_count -> {restored}")

    # verify
    chk = sb("GET", "/artist_daily_stats", {"artist_id": f"eq.{aid}", "date": f"eq.{DATE}", "select": "total_streams,daily_delta,track_count"})[0]
    print(f"  AFTER: total={chk['total_streams']:,} delta={chk['daily_delta']} track_count={chk['track_count']}\n")

print("done.")
