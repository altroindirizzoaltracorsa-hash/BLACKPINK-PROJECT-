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
- **Canary → catalog trigger:** the moment the canary catches today's bump (`canaryCaughtBump` in `api/streams.js`), it fires **two** downstreams fire-and-forget: (1) the catalog-total refresh (`?catalog=1&force=1`), and (2) a `workflow_dispatch` of `fetch-catalog.yml` (`run_artist_fetch:true`) via `dispatchCatalogFetch()` — so the **per-member/per-track artist streams are captured the instant the campaign tracks move**, not only at the fixed nightly GitHub run (which recently missed a small-hours publish and merged Sep 17+18 into one entry). Spotify updates all counters together, so the whole catalog is fresh when the tracks move. The GitHub dispatch is deduped by a 30-min Redis NX lock (`catalog_fetch_dispatch_lock`) so concurrent visitor requests fan in to one run, and is a **no-op unless `GH_DISPATCH_TOKEN` is set** (fine-grained PAT, Actions: write). It fires **only on a real canary bump — never on `force`/`cron`** (fetch-tracks.mjs itself calls `?force=1`, so dispatching there would make `fetch-catalog.yml` re-trigger itself). The 14 `fetch-catalog.yml` slots (below) are the floor for the cron/force cases. Manual kick: `GET /api/streams?action=dispatch-member-fetch&key=ADMIN_SECRET` (bypasses the lock, returns the GitHub dispatch status).
- **Vercel cron:** `0 21 * * *` UTC (11PM Italy) → `/api/streams?cron=1` — campaign tracks only.
- **`fetch-catalog.yml` schedule — 14 slots, 13:23 → 05:19 UTC (15:23 → 07:19 Rome), ≤78-min gaps.** Deliberately the **same span as the site's watch window** (3PM Rome → 7AM) rather than a guess: the publish lands "way after 3PM Rome" and wanders from there (~19:00 to ~01:30 UTC observed), so a fixed nightly slot kept catching a day hours after it landed, or missing one and merging two days into one entry. The 05:19 → 13:23 UTC hole is the documented quiet stretch. Every slot runs `fetch-artist-streams` + `fetch-group-streams`; **only three** (`53 21`, `49 2`, `19 5`) also run the `fetch` job.
  - **A slot that finds nothing is not a late publish.** At 06:00 Rome the day isn't due yet. Every timing inference drawn from a handful of empty or late samples in this repo has been wrong; go by the watch window, not by one run's log.
  - **Why fourteen slots don't cost quota:** *all* RapidAPI spend in the workflow is in the **`fetch` job**, which is gated by an `if:` to those three cron strings *verbatim* — **renumber a cron in the schedule and that slot silently becomes a full one.** The other eleven run only `fetch_artist_streams.py` / `fetch_group_streams.py` (spotifyscraper + Supabase, zero quota), and both hold when the total is unchanged, so a slot firing pre-publish writes nothing (verified in run `36520505572`: all five artists `100.0% unchanged … NOT UPDATED YET, skipping`). This is the point: the per-member/per-track artist streams are the thing that needs to follow the publish, and recording them is free.
  - **Don't move the catalog-total step onto the cheap slots.** `fetch-catalog.mjs` *looks* free (Worker-first) but **`SPOTIFY_WORKER_URL` / `SPOTIFY_WORKER_KEY` are not set in Vercel**, so it falls through to 1 RapidAPI request per provider and then **scrapes kworb** — that's where the site total currently comes from. Verified in run `36520222919`: `worker: … not set; rapidapi: spotify-scraper: HTTP 429; spotify-scraper-api: HTTP 403; … source: kworb`. Once the Worker is configured it becomes free *and* quota-saving (a Worker hit side-caches the 4 campaign tracks in Redis for 4h as `bp_worker_*`, which `fetchTrackMetadata` reads *before* RapidAPI). Re-check that log line before relying on it.
  - **Minutes are deliberately never `:00` or `:30`.** GitHub queues scheduled runs behind the top-of-the-hour crush, and on this repo that delay measured **2h10m–5h on every run** — `0 22` was firing at 00:06–01:24 and `0 5` at 07:24–09:58, which is most of why the old "small-hours floor runs" were actually landing mid-morning.
  - **`concurrency: catalog-fetch`** (`cancel-in-progress: false`) serializes the workflow, so two bunched runs can't both read the same "last recorded day" and write it twice.
  - Sweeping ~5× more often means meeting Spotify mid-publish more often — that's what `publish_unfinished()` + the provisional/open-row path handle, with `checks/sweep_split_publishes.sql` (weekly, every tracked artist) as the backstop. Also workflow_dispatched on demand by the canary (above).
- **`GH_DISPATCH_TOKEN` (Vercel env):** fine-grained GitHub PAT with **Actions: Read and write** on `BLACKPINK-PROJECT-`, used by `dispatchCatalogFetch()` so the Vercel canary can trigger the GitHub artist fetch. If unset, the canary→member-fetch path is silently skipped (the 14 `fetch-catalog.yml` slots still cover it).
- **RapidAPI providers:** `spotify-scraper` (14 keys) + `spotify-scraper-api` (16 keys) = 30 total. Keys rotate but can exhaust on high-traffic afternoons.
- **`SPOTIFY_WORKER_URL` / `SPOTIFY_WORKER_KEY` (Vercel env) are UNSET — open gap.** The Cloudflare Worker is the intended primary catalog source: Cloudflare IPs can mint a fresh Spotify anon token, so it's free, needs no RapidAPI key, and side-caches per-track counts into `bp_worker_*`. With it unset, `/api/streams?catalog=1` burns a request on each provider and then scrapes **kworb** for the 17.5B total — i.e. the headline number on /streams depends on a third-party HTML scrape. Setting these two env vars is the single biggest scraper-quota win available.
- **Network:** Direct HTTP to `blinksunited.com` is blocked in Claude Code sessions — always use GitHub Actions workflows to make HTTP calls against the Vercel deployment.
- **Admin secret:** GitHub Actions secret = `secrets.ADMIN_KEY`; Vercel env var = `ADMIN_SECRET`.
- **Supabase tables:** `artist_tracks` + `track_daily_stats` (written by `fetch_artist_streams.py`); `group_tracks` + `group_track_daily_stats` (written by `fetch_group_streams.py`). The group pair is deliberately **separate** from the artist pair rather than reusing it with a group's `artist_id`: the artist tables carry site-visible meaning (/streams lists from `tracked_artists`, the split-publish sweep walks "every tracked artist", the per-artist pages query them), so seven girl groups' rows in there would quietly widen every one of those queries — first symptom being a girl group on a BLACKPINK page.
  - `group_track_daily_stats.merged_with` = how many OTHER track ids reported this exact figure that day. Spotify sometimes serves several versions of a song as one merged count and then every id returns the same number, so summing them double counts. The group TOTAL still sums as-is (that is what reproduces kworb); this column is what lets a *per-track* read tell "Magnetic did 889.9M" from "Magnetic and four remixes all report 889.9M".
  - `stale` = the fetch failed for that track and the last-known value was carried forward. Unchanged by construction, so a 0 delta there means "not seen", not "didn't move" — rate calculations must exclude it.
  - **"Magnetic" is five track IDs** (original + Sped Up + three remixes), summing ~32M above the original. A "fastest to 1B" figure means the original alone; the summed figure arrives early. The **`Check Magnetic daily streams`** workflow (`check-magnetic.yml` → `check_magnetic.py`, read-only) prints kworb's per-track table, a live spotifyscraper read, and our recorded series side by side, and projects to 1B both ways.

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
