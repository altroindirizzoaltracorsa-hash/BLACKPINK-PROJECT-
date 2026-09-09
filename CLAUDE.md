# BLACKPINK Project — Claude Context

## Slash Commands

### `/update-streams`
Triggers the **BLACKPINK Spotify Catalog** GitHub Actions workflow (`fetch-catalog.yml`, workflow ID `316054383`) on `altroindirizzoaltracorsa-hash/BLACKPINK-PROJECT-`, dispatched to `main` branch with `run_artist_fetch: "true"`.

This updates:
- The 17.5B catalog total on **blinksunited.com/streams**
- The four campaign track cards (JUMP / Shut Down / DDU-DU DDU-DU / GO)
- Artist member stream counts (JISOO / JENNIE / ROSÉ / LISA) via Supabase

To trigger via GitHub Actions MCP:
```
mcp__github__actions_run_trigger
  owner: altroindirizzoaltracorsa-hash
  repo: BLACKPINK-PROJECT-
  workflow_id: 316054383
  ref: main
  inputs: { run_artist_fetch: "true" }
```

---

### `/update-tracks`
Triggers the **Update Streams** GitHub Actions workflow (`update-streams.yml`, workflow ID `326700649`) on `altroindirizzoaltracorsa-hash/BLACKPINK-PROJECT-`, dispatched to `main` branch.

Fires **only the RapidAPI Spotify-scraper keys for the four campaign track cards** on blinksunited.com:
- JUMP
- Shut Down
- DDU-DU DDU-DU
- GO

Under the hood it calls `/api/streams?force=1&tracks_only=1&key=ADMIN_KEY` — `force=1` bypasses the canary gate and immediately fetches all four, and `tracks_only=1` skips the catalog-total recompute. Does NOT update the catalog total or artist member stream counts. Use `/update-streams` for a full refresh.

To trigger via GitHub Actions MCP:
```
mcp__github__actions_run_trigger
  owner: altroindirizzoaltracorsa-hash
  repo: BLACKPINK-PROJECT-
  workflow_id: 326700649
  ref: main
```

---

### `/update-charts`
Triggers the **Fetch Spotify Charts** GitHub Actions workflow (`fetch-spotify-artists.yml`, workflow ID `345354131`) on `altroindirizzoaltracorsa-hash/BLACKPINK-PROJECT-`, dispatched to `main` branch with `type: "floor"`.

Full manual refresh of the **/spotify-charts** page (official charts.spotify.com data for BLACKPINK + members, all countries):
- **Top Songs** — daily + weekly
- **Top Artists** — daily + weekly
- **Top Albums** — weekly

Under the hood the job triggers the Vercel `charts=fetch-songs` / `charts=fetch-artists` / `charts=fetch-albums` handlers (the fetch must run on Vercel — Spotify blocks GitHub IPs). `type=floor` sweeps everything, spacing each 74-country pass apart so each starts with a fresh Spotify rate budget (avoids the 429 country-skips) — so the run takes **~13 min**. Charts already refresh automatically (daily songs+artists nightly + a 2-hourly canary; weekly songs/artists/albums each on their own Fri+Sat slot), so this is only for an on-demand "refresh now."

Lighter variants (same workflow, different `type` input): `daily` (daily songs+artists only, ~2½ min), `weeklyfloor` (weekly songs+artists+albums only), or per-type `weekly-songs` / `weekly-artists` / `weekly-albums`.

To trigger via GitHub Actions MCP:
```
mcp__github__actions_run_trigger
  owner: altroindirizzoaltracorsa-hash
  repo: BLACKPINK-PROJECT-
  workflow_id: 345354131
  ref: main
  inputs: { type: "floor" }
```

---

## Branch Rules (CRITICAL)

- **Shazam work** → branch `claude/shazam-import-setup-8zdbzs` ONLY. Never push Shazam code to `main`.
- **Battle prototype** → branch `claude/battle-prototype`. Do NOT merge to `main` without explicit user confirmation.

---

## Key API / Infra Context

- **`/api/streams`** — powers campaign card stream counts. Supports `?force=1&key=ADMIN_SECRET`, `?force=1&tracks_only=1&key=…` (campaign tracks only, skips catalog), `?cron=1`, `?catalog=1`, `?action=set-entry`.
- **Day boundary (2AM Rome):** Spotify's streaming day resets worldwide at **00:00 UTC = 2AM Rome (summer)**, and the whole site — leaderboard, badges, scrobblers — resets on that same boundary. The campaign-track day label (`getDateLabel`, `todayLabel`) is **UTC-based on purpose** to stay aligned. Do NOT switch it to Rome-local time — that desyncs the tracks from the site reset.
- **Watch window:** 3PM Italy → **7AM next morning** (extended overnight to catch Spotify's daily refresh, which lately lands in the small hours *after* the 2AM reset — the old midnight-Rome cutoff was the main cause of "2-day gap" entries). Quiet 7AM–3PM. In-window cache TTL = 15 min (visitor-triggered, NOT automatic cron).
- **Canary gate:** while waiting for the daily bump, only ONE campaign track (`CANARY = 'jump'` in `api/streams.js`) is polled with the scraper keys; the moment it shows new streams, the handler fans out and fetches the other 3 once. All 4 move in lockstep, so this cuts waiting-phase quota ~4×. `?cron=1` / `?force=1` bypass the gate and sweep all 4 (guaranteed daily floor). The 11PM Vercel cron is that floor.
- **Canary → catalog trigger:** the moment the canary catches today's bump (`canaryCaughtBump` in `api/streams.js`), it fires the catalog-total refresh (`?catalog=1&force=1`) fire-and-forget. Spotify updates all counters together, so the catalog total is fresh the instant the campaign tracks move — this is the **primary** catalog-total refresh path now (catches it in the small hours). The 11PM cron catalog trigger stays as a fallback floor. (Note: this is the catalog **total** only; per-member/per-track artist streams still come from the separate midnight `fetch-catalog.yml` GitHub job.)
- **Vercel cron:** `0 21 * * *` UTC (11PM Italy) → `/api/streams?cron=1` — campaign tracks only.
- **`fetch-catalog.yml` schedule:** `0 22 * * *` UTC (midnight Italy) — full catalog + artist streams.
- **RapidAPI providers:** `spotify-scraper` (14 keys) + `spotify-scraper-api` (16 keys) = 30 total. Keys rotate but can exhaust on high-traffic afternoons.
- **Network:** Direct HTTP to `blinksunited.com` is blocked in Claude Code sessions — always use GitHub Actions workflows to make HTTP calls against the Vercel deployment.
- **Admin secret:** GitHub Actions secret = `secrets.ADMIN_KEY`; Vercel env var = `ADMIN_SECRET`.
- **Supabase tables:** `artist_tracks` + `track_daily_stats` (written by `fetch_artist_streams.py`).

---

## Campaign Track IDs

| Track | Spotify ID |
|-------|-----------|
| JUMP | `5H1sKFMzDeMtXwND3V6hRY` |
| Shut Down | `6tCd8bPvYnceDG7W9M1RMk` |
| DDU-DU DDU-DU | `69BIczdH6QMnFx7dsSssN8` |
| GO | `0mYa3o6tlUN5HRippmKmwH` |

---

## Auto-discovery of new releases

`fetch_artist_streams.py` (the daily `fetch-catalog.yml` job) **auto-detects brand-new releases** so a fresh single/EP is counted from day one — no manual `FIXED_TRACKS` edit needed. This is what fixes the old failure mode where a drop (e.g. Jennie's *Fallen Angel* EP) went uncounted until someone noticed.

- **How:** `discover_new_tracks()` walks the newest ~12 discography entries per artist and keeps tracks from releases dated within the last **75 days** (`within_days`) that the member is credited on. The recency gate is deliberate — the established back-catalog stays pinned to `FIXED_TRACKS` (kworb scope); discovery only ever **adds** recent drops, never re-walks/re-scopes the catalog.
- **Dedup:** skips a track whose ID is already tracked **or** whose normalized title already matches a tracked track — so a song re-released under a new track ID (a single later folded into an EP, e.g. the EP reissue of "Less than a Lover") is **not** double-counted.
- **Sticky:** a discovered track is persisted to `artist_tracks` and keeps being counted after it ages out of the 75-day window (`process_artist` unions `FIXED_TRACKS` + persisted `artist_tracks` + this-run discoveries, deduped by id and name).
- **Fail-safe:** the whole discovery/persist step is wrapped so any error falls back to the pinned `FIXED_TRACKS` list — the daily total can never be broken by it.
- **Kill switch:** set env `AUTO_DISCOVER=0` to run the pinned list only.
- **Preview (read-only):** the **`Preview new-release discovery`** workflow (`discover-tracks.yml` → `discover_tracks.py`) prints, per member, what discovery would add — writes nothing. Run it the morning after a drop to confirm it was caught, or any time to confirm nothing spurious is about to be added. Optional `within_days` input overrides the window.
