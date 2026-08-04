# BLACKPINK Project — Claude Context

## Slash Commands

### `/update-streams`
Triggers the **BLACKPINK Spotify Catalog** GitHub Actions workflow (`fetch-catalog.yml`, workflow ID `316054383`) on `altroindirizzoaltracorsa-hash/BLACKPINK-PROJECT-`, dispatched to `main` branch with `run_artist_fetch: "true"`.

This updates:
- The 17.5B catalog total on **blinksunited.com/streams**
- The four campaign track cards (JUMP / Shut Down / DDU-DU DDU-DU / GO)
- Artist member stream counts (JISOO / JENNIE / ROSÉ / LISA) via Supabase

Do NOT use `update-streams.yml` (workflow ID 326700649) for this — that only refreshes campaign tracks.

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

## Branch Rules (CRITICAL)

- **Shazam work** → branch `claude/shazam-import-setup-8zdbzs` ONLY. Never push Shazam code to `main`.
- **Battle prototype** → branch `claude/battle-prototype`. Do NOT merge to `main` without explicit user confirmation.

---

## Key API / Infra Context

- **`/api/streams`** — powers campaign card stream counts. Supports `?force=1&key=ADMIN_SECRET`, `?cron=1`, `?catalog=1`, `?action=set-entry`.
- **Watch window:** 2PM–11PM Italy. After 2PM, cache TTL = 15 minutes (visitor-triggered, NOT automatic cron).
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
