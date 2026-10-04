#!/usr/bin/env python3
"""One daily reading of every tracked YouTube video, into Supabase.

The fetch has to happen on Vercel — YOUTUBE_API_KEY lives there, not here — so
this calls /api/youtube-catalog and does the writing itself. That split is
deliberate: the read endpoint stays read-only and safe to run at will, and the
only thing that writes is this job, in the repo, where it can be tested.

WHY THIS EXISTS. /api/youtube-catalog says where every video is right now. It
cannot say how fast anything is moving, because one reading has no past. The
board sorts by soonest-to-its-next-milestone, which is a rate question, so the
readings have to be kept. After ~2 weeks of these the ETA column fills itself
in.

WHAT IT RECORDS. Everything above the view floor, whatever its kind — Shorts,
live stages, the lot. The board filters at READ time. Recording broadly costs
nothing (the rows are tiny) and means re-classifying a video later, or changing
our mind about whether dance practice videos count, never destroys history we
cannot re-fetch. YouTube serves a cumulative number and no past, so a reading
not taken is gone for good.

THE DAY LABEL IS THE DATE OF THE READING. Not "the next unrecorded day" —
that rule belongs to the Spotify scripts, where it exists because Spotify
publishes finalised days in batches, late and out of step with the calendar.
YouTube's counter is live and continuous. A run that finds no change is a
failed run, not a run waiting for a publish.

Env:
  BASE                  site base URL (default https://blinksunited.com)
  ADMIN_KEY             admin secret for /api/youtube-catalog
  SUPABASE_URL          Supabase project URL
  SUPABASE_SERVICE_KEY  service_role key
  MIN_VIEWS             view floor (default 50_000_000)
  DRY_RUN=1             fetch and report, write nothing
  OVERRIDE_DATE         label this reading with a given YYYY-MM-DD
"""
import os
import sys
from datetime import datetime, timezone

import httpx

BASE = os.environ.get("BASE", "https://blinksunited.com").rstrip("/")
ADMIN_KEY = os.environ.get("ADMIN_KEY", "")
SUPABASE_URL = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY") or ""
MIN_VIEWS = int(os.environ.get("MIN_VIEWS") or 50_000_000)
DRY_RUN = os.environ.get("DRY_RUN") == "1"
OVERRIDE_DATE = os.environ.get("OVERRIDE_DATE")

CHUNK = 200


def sb(method, path, **kwargs):
    headers = {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
        **kwargs.pop("headers", {}),
    }
    r = httpx.request(method, f"{SUPABASE_URL}/rest/v1{path}",
                      headers=headers, timeout=60, **kwargs)
    if r.is_error:
        print(f"  Supabase error body: {r.text}", file=sys.stderr)
    r.raise_for_status()
    return r.json() if r.content else None


def fetch_catalog():
    """Every video above the floor, of every kind — filtering is the board's job."""
    url = f"{BASE}/api/youtube-catalog?min={MIN_VIEWS}&kinds=all"
    r = httpx.get(url, headers={"x-admin-secret": ADMIN_KEY},
                  timeout=180, follow_redirects=True)   # the apex 308-redirects
    r.raise_for_status()
    d = r.json()
    if d.get("error"):
        raise RuntimeError(f"catalog endpoint: {d['error']}")
    return d


def upsert_videos(videos):
    """video_id -> row id. Title, kind and duration are refreshed every run, so a
    retitled or reclassified video updates in place and keeps its history."""
    rows = [{
        "video_id": v["id"],
        "title": v.get("title"),
        "channel": v.get("channel"),
        "channel_id": v.get("channelId"),
        "kind": v.get("kind"),
        "duration_sec": v.get("durationSec"),
        "published_at": v.get("publishedAt"),
    } for v in videos]

    refs = {}
    for i in range(0, len(rows), CHUNK):
        got = sb("POST", "/youtube_videos",
                 params={"on_conflict": "video_id"},
                 headers={"Prefer": "resolution=merge-duplicates,return=representation"},
                 json=rows[i:i + CHUNK]) or []
        for r in got:
            refs[r["video_id"]] = r["id"]
    return refs


def previous_readings(refs):
    """The latest stored reading per video: {ref: (views, captured_at)}.

    One request, newest first, then keep the first occurrence of each ref — the
    alternative is a query per video, which is hundreds of round trips for a
    table this small.
    """
    if not refs:
        return {}
    out = {}
    rows = sb("GET", "/youtube_video_daily_stats", params={
        "select": "video_ref,views,captured_at",
        "video_ref": f"in.({','.join(str(r) for r in refs)})",
        "order": "captured_at.desc",
        "limit": "20000",
    }) or []
    for r in rows:
        ref = r["video_ref"]
        if ref not in out:
            out[ref] = (r["views"], r["captured_at"])
    return out


def parse_ts(s):
    if not s:
        return None
    s = s.replace("Z", "+00:00")
    try:
        t = datetime.fromisoformat(s)
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def build_rows(videos, refs, prev, now):
    day = OVERRIDE_DATE or now.date().isoformat()
    rows, skipped = [], 0
    for v in videos:
        ref = refs.get(v["id"])
        if ref is None:
            skipped += 1
            continue
        before = prev.get(ref)
        delta = hours = None
        if before:
            prev_views, prev_at = before
            delta = v["views"] - prev_views      # may be negative: YouTube recounts
            t = parse_ts(prev_at)
            if t:
                hours = round((now - t).total_seconds() / 3600.0, 3)
                if hours <= 0:
                    # Same instant or clock skew: a rate cannot be derived from
                    # it, and a bogus hours_since is worse than none.
                    hours = None
        rows.append({
            "video_ref": ref,
            "date": day,
            "views": v["views"],
            "daily_delta": delta,
            "hours_since": hours,
            "captured_at": now.isoformat(),
        })
    return day, rows, skipped


def write(rows):
    for i in range(0, len(rows), CHUNK):
        sb("POST", "/youtube_video_daily_stats",
           params={"on_conflict": "video_ref,date"},
           headers={"Prefer": "resolution=merge-duplicates"},
           json=rows[i:i + CHUNK])


def main():
    if not ADMIN_KEY:
        print("ADMIN_KEY unset", file=sys.stderr)
        return 1
    if not DRY_RUN and not (SUPABASE_URL and SUPABASE_KEY):
        print("SUPABASE_URL/SUPABASE_SERVICE_KEY unset", file=sys.stderr)
        return 1

    d = fetch_catalog()
    videos = d.get("videos") or []
    print(f"catalog: {len(videos)} video(s) at or above {MIN_VIEWS:,} views, "
          f"across {len(d.get('channels') or [])} channel(s)")
    for c in d.get("channels") or []:
        flag = "  [TRUNCATED]" if c.get("truncated") else ""
        print(f"  {c.get('title','?'):<20} {c.get('uploads',0):>4} uploads  "
              f"{c.get('videos',0):>3} above floor{flag}")
    if d.get("unresolved"):
        print(f"  UNRESOLVED: {', '.join(d['unresolved'])}", file=sys.stderr)

    if not videos:
        # Not a quiet day — the catalogue is never legitimately empty.
        print("no videos returned — refusing to record an empty reading", file=sys.stderr)
        return 1

    now = datetime.now(timezone.utc)

    if DRY_RUN:
        day = OVERRIDE_DATE or now.date().isoformat()
        print(f"\nDRY_RUN — would record {len(videos)} row(s) for {day}")
        for v in sorted(videos, key=lambda x: x["gap"])[:10]:
            print(f"  {v['gap']:>12,} to {v['next']/1e6:g}M  {v['views']:>15,}  "
                  f"{v.get('kind',''):<11} {v['title'][:52]}")
        return 0

    refs = upsert_videos(videos)
    prev = previous_readings(set(refs.values()))
    day, rows, skipped = build_rows(videos, refs, prev, now)
    if skipped:
        print(f"  ⚠ {skipped} video(s) had no row id and were skipped", file=sys.stderr)
    write(rows)

    first = sum(1 for r in rows if r["daily_delta"] is None)
    moved = sum(1 for r in rows if (r["daily_delta"] or 0) > 0)
    down = sum(1 for r in rows if (r["daily_delta"] or 0) < 0)
    print(f"\nrecorded {len(rows)} reading(s) for {day}")
    print(f"  {first} first reading(s), {moved} up, {down} down "
          f"(YouTube recounts; a fall is data, not an error)")

    # Only videos that actually gained: a list of "0/day" rows says nothing and
    # buries the ones that moved.
    gained = [r for r in rows
              if r["daily_delta"] and r["hours_since"] and r["daily_delta"] > 0]
    if not gained:
        print("\n  nothing gained since the last reading")
    else:
        top = sorted(gained, key=lambda r: -(r["daily_delta"] / r["hours_since"]))[:5]
        by_ref = {refs[v["id"]]: v for v in videos if v["id"] in refs}
        print("\n  fastest since the last reading (views/day):")
        for r in top:
            v = by_ref.get(r["video_ref"], {})
            rate = r["daily_delta"] / r["hours_since"] * 24
            print(f"    {rate:>12,.0f}/day  over {r['hours_since']:>5.1f}h  "
                  f"{v.get('title','?')[:50]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
