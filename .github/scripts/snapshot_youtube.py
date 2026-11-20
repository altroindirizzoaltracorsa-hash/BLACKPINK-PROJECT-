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
  FRESH_DAYS            also keep anything published this recently, whatever
                        its view count (default 30; 0 turns it off)
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
# A release is below any sensible view floor on the day it lands, which is the
# day the board is most worth reading — a new MV climbing to its first 100M is
# the fastest-moving row there will ever be. Recency is a second way past the
# floor, so the video is recorded from day one and has a rate by day two.
FRESH_DAYS = int(os.environ.get("FRESH_DAYS") or 30)
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
    """Every video above the floor OR published in the last FRESH_DAYS days, of
    every kind — filtering is the board's job."""
    url = f"{BASE}/api/youtube-catalog?min={MIN_VIEWS}&kinds=all&fresh_days={FRESH_DAYS}"
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
            # NULL IS NOT ZERO. likeCount is absent when the uploader hides it
            # and commentCount when comments are off — common on a soundtrack
            # upload. `or None` would be wrong here and `v.get(...)` is what
            # keeps a genuine 0 distinct from a missing figure.
            "like_count": v.get("likes"),
            "comment_count": v.get("comments"),
            "captured_at": now.isoformat(),
        })
    return day, rows, skipped


def write(rows):
    for i in range(0, len(rows), CHUNK):
        sb("POST", "/youtube_video_daily_stats",
           params={"on_conflict": "video_ref,date"},
           headers={"Prefer": "resolution=merge-duplicates"},
           json=rows[i:i + CHUNK])


def upsert_channels(channels):
    """channel_id -> row id, for the subscriber series."""
    rows = [{"channel_id": c["id"], "title": c.get("title")}
            for c in channels if c.get("id")]
    if not rows:
        return {}
    sb("POST", "/youtube_channels",
       params={"on_conflict": "channel_id"},
       headers={"Prefer": "resolution=merge-duplicates"},
       json=rows)
    got = sb("GET", "/youtube_channels",
             params={"select": "id,channel_id",
                     "channel_id": "in.(" + ",".join(c["channel_id"] for c in rows) + ")"})
    return {r["channel_id"]: r["id"] for r in got}


def write_channel_stats(channels, refs, day, now):
    """One subscriber reading per channel per day.

    NO DELTA COLUMN, deliberately — see the migration. YouTube rounds
    subscriber counts to three significant figures, so on a 95.8M channel the
    step is 100,000 and a day-over-day difference reports the rounding rather
    than the fandom: several days of exactly 0, then a jump of one whole step.
    The level is worth keeping; a daily gain derived from it would not be.
    """
    rows = []
    for c in channels:
        ref = refs.get(c.get("id"))
        if ref is None:
            continue
        rows.append({
            "channel_ref": ref,
            "date": day,
            # None when the channel hides its count — not 0.
            "subscribers": c.get("subscribers"),
            "captured_at": now.isoformat(),
        })
    if rows:
        sb("POST", "/youtube_channel_daily_stats",
           params={"on_conflict": "channel_ref,date"},
           headers={"Prefer": "resolution=merge-duplicates"},
           json=rows)
    return len(rows)


def report_fresh(videos):
    """Say which videos are here only because they are new.

    The job log is served from blob storage a Claude Code session cannot
    fetch, so a run that only prints is a run whose answer never arrives — and
    the question worth asking after a release is the narrow one: did it get in.
    A literal newline would end the workflow command, hence %0A.
    """
    below = [v for v in videos if (v.get("views") or 0) < MIN_VIEWS]
    lines = [f"catalog {len(videos)} video(s); {len(below)} below the "
             f"{MIN_VIEWS:,} floor, kept by the {FRESH_DAYS}-day window"]
    for v in sorted(below, key=lambda x: -(x.get("views") or 0))[:15]:
        lines.append(f"  {v.get('views', 0):>12,}  {v.get('kind', ''):<11} "
                     f"{(v.get('publishedAt') or '?')[:10]}  {v.get('title', '')[:60]}")
    blob = "%0A".join(
        l.replace("%", "%25").replace("\r", "").replace("\n", " ") for l in lines)
    print(f"::notice title=fresh::{blob[:3500]}")


def main():
    if not ADMIN_KEY:
        print("ADMIN_KEY unset", file=sys.stderr)
        return 1
    if not DRY_RUN and not (SUPABASE_URL and SUPABASE_KEY):
        print("SUPABASE_URL/SUPABASE_SERVICE_KEY unset", file=sys.stderr)
        return 1

    d = fetch_catalog()
    videos = d.get("videos") or []
    report_fresh(videos)
    print(f"catalog: {len(videos)} video(s) at or above {MIN_VIEWS:,} views, "
          f"across {len(d.get('channels') or [])} channel(s)")
    for c in d.get("channels") or []:
        flag = "  [TRUNCATED]" if c.get("truncated") else ""
        # Subscribers in the summary, so a DRY_RUN proves the channels call is
        # still asking for part=statistics. A channel that hides its count
        # prints "hidden" rather than 0 — those are different facts.
        subs = c.get("subscribers")
        subs_txt = f"{subs:>12,} subs" if subs else "      hidden subs"
        print(f"  {c.get('title','?'):<20} {c.get('uploads',0):>4} uploads  "
              f"{c.get('videos',0):>3} above floor  {subs_txt}{flag}")
    if d.get("unresolved"):
        print(f"  UNRESOLVED: {', '.join(d['unresolved'])}", file=sys.stderr)

    if not videos:
        # Not a quiet day — the catalogue is never legitimately empty.
        print("no videos returned — refusing to record an empty reading", file=sys.stderr)
        return 1

    now = datetime.now(timezone.utc)

    if DRY_RUN:
        day = OVERRIDE_DATE or now.date().isoformat()
        # Prove the statistics part is still coming through BEFORE a real run
        # writes a day of nulls. All of them missing at once is the catalog
        # having stopped asking, which is otherwise silent.
        have_likes = sum(1 for v in videos if v.get("likes") is not None)
        have_comments = sum(1 for v in videos if v.get("comments") is not None)
        print(f"\nDRY_RUN — would record {len(videos)} row(s) for {day}")
        print(f"  likes published: {have_likes}/{len(videos)} · "
              f"comments published: {have_comments}/{len(videos)}")
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

    # Subscribers, per channel rather than per video. Guarded on its own so a
    # table that has not been migrated yet cannot take the view snapshot down
    # with it — the views are the thing this job exists for, and they are
    # already written by the line above.
    try:
        chans = d.get("channels") or []
        chan_refs = upsert_channels(chans)
        n = write_channel_stats(chans, chan_refs, day, now)
        hidden = sum(1 for c in chans if c.get("subscribers") is None)
        print(f"  subscribers: {n} channel row(s)"
              + (f", {hidden} hidden by the channel" if hidden else ""))
    except Exception as e:                                   # noqa: BLE001
        print(f"  ⚠ subscriber rows skipped ({e}) — views are unaffected",
              file=sys.stderr)

    # How many videos published each figure. A soundtrack upload with comments
    # off is normal; ALL of them going null overnight is the catalog endpoint
    # having stopped asking for the statistics part, which is silent otherwise.
    no_likes = sum(1 for r in rows if r["like_count"] is None)
    no_comments = sum(1 for r in rows if r["comment_count"] is None)
    print(f"  likes: {len(rows) - no_likes}/{len(rows)} published"
          f" · comments: {len(rows) - no_comments}/{len(rows)} published")

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
