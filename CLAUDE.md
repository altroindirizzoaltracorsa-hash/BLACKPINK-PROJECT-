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
