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
  - **"Magnetic" (ILLIT) is one track ID: `1aKvZDoLGkNMxoRYgkckZG`** ([open.spotify.com](https://open.spotify.com/track/1aKvZDoLGkNMxoRYgkckZG)). Four other IDs carry "Magnetic" in the title, and **none of their streams are inside it** — they are separate songs, each with its own count. The proof is that the five figures all differ: a Spotify merge makes every ID in the group return the *identical* number (that is what `merged_with` detects), so five different numbers means five independent counts. Summing them therefore does not measure Magnetic harder, it adds four other tracks — ~32M of them, reaching 1B roughly **64 days early**. Never use the sum for a "fastest to 1B" claim. Values as of 2026-09-29, the last published day:

    | track | Spotify ID | streams | daily |
    |---|---|---|---|
    | **Magnetic** — the song, the only one that counts | `1aKvZDoLGkNMxoRYgkckZG` | 889,906,032 | +524,542 |
    | Magnetic - Sped Up | `4AcAYJr7ma4bdcni86Kp7I` | 13,183,827 | +3,133 |
    | Magnetic - Starlight Remix | `1SNbKSraeBuFBuHeSpHLis` | 7,556,000 | +3,822 |
    | Magnetic - R&B Remix | `2KYwtEX70O5wD2xEn4a42J` | 6,131,218 | +1,500 |
    | Magnetic - City Night Remix | `6vkj9UHlADo13y5eHSwdec` | 5,337,537 | +2,127 |
    | *all five summed — NOT Magnetic* | — | *922,114,614* | *+535,124* |

    Days to 1B depends on which rate you pick, and all three of these are real: **580,462/day** is the 25-day span average (4→29 Sep) → **~190 days**; **524,542** was the last observed day → **~210**; and the rate is monotonically falling (+580,979 → +549,747 → +524,542 across 27–29 Sep), so decay pushes it past both. The summed-versions figure would say ~131. The **`Check Magnetic daily streams`** workflow (`check-magnetic.yml` → `check_magnetic.py`, read-only) prints all of it three ways — kworb's per-track table with its Daily column, a live spotifyscraper fetch, and our own recorded series — and projects both ways. Verified 2026-10-02: kworb's Magnetic total and Daily equal our 28 Sep row **to the digit**, so kworb is simply a day behind us, not a second opinion.
  - **A per-track rate must come from the SPAN, never from averaging the daily deltas.** Rows written before the hold rule carry smeared labels — Magnetic's 23 Sep shows +0 with streams identical to 22 Sep and 24 Sep then shows +1,112,328, one two-day publish across two rows (17 Sep likewise). Averaging counts the 2× at full weight while the 0 pulls nothing back: on Magnetic that reads **673,471/day against a true ~580,000**, 16% high, cutting ~27 days off the 1B projection. Streams gained between two observed rows ÷ the calendar days between them is immune — a smeared label moves streams *between* rows but the endpoints still bracket the same real streams, and a missing day inside the span costs nothing because the figures are cumulative. The one thing that **does** break a span is a `merged_with` row: that is a permanent level shift of streams never played in the window, so start the span after it.

---

## Campaign Track IDs

| Track | Spotify ID |
|-------|-----------|
| JUMP | `5H1sKFMzDeMtXwND3V6hRY` |
| Shut Down | `6tCd8bPvYnceDG7W9M1RMk` |
| DDU-DU DDU-DU | `69BIczdH6QMnFx7dsSssN8` |
| GO | `0mYa3o6tlUN5HRippmKmwH` |

---

## Girl group catalogues — upcoming re-seeds

The group catalogues in `data/group_catalogs/` are **pinned**. `fetch_group_streams.py`
sums exactly the ids in those files and nothing adds to them on its own — that is
what keeps all seven groups on kworb's scope so their totals stay comparable, and
it is also why a new release is worth **zero** to a group's total until the
catalogue is re-seeded. There is no auto-discovery for groups (unlike
`fetch_artist_streams.py`, which does discover for BLACKPINK and the members).

**When kworb lists the album, re-seed that group** — do not hand-edit the JSON:

```
Seed group catalogs from kworb  (seed-group-catalogs.yml)
  only:  TWICE        ← or ILLIT
  write: 1
```

It re-reads kworb's id list, re-fetches every track itself, and checks the two
sums agree, so the catalogue stays *defined by* kworb rather than drifting into a
hand-maintained list. Re-seeding **before** kworb lists the album just reproduces
the current list; re-seeding while kworb is mid-update can pin a partial one.

**The streams are recorded in the meantime.** `data/group_watchlist.json` lists
ids to **record but not count**: `fetch_group_streams.py` fetches them each day
and writes their per-track rows to `group_track_daily_stats` with
`counted = false`, so the ramp from release day survives even though kworb has
not listed the album. They are kept out of the group total, out of
`history.json` / `history.csv`, out of the unchanged-ratio that decides whether
Spotify is mid-publish, and out of `last_tracks.json` — a watch track cannot
move a group's number, delay a publish decision or alter a delta. Their baseline
is its own file, `data/group_streams/last_watch.json`.

`counted` is **derived every run**, not declared: a watch id that is also in the
catalogue is ignored by the watchlist and written `counted = true` through the
normal path. So a re-seed flips the flag by itself and the watchlist entries
become harmless no-ops — removing them afterwards is tidying, not maintenance.
Both albums' tracks are already on it.

Unlike the counted path, a watch track whose fetch fails is **not** carried
forward: last-known values exist to stop a TOTAL from shortening, and a watch
track is in no total, so a skipped day leaves an honest gap rather than a day we
did not observe. Its baseline survives the gap, so the next real reading's delta
spans it correctly.

Verified 2026-10-04 via `probe-album.yml` — **0/26 and 0/4 counted today**:

### TWICE — `<THIS IS FOR> WORLD TOUR FINALE in SEOUL - LIVE` · 2026-10-16
Album `3HSgUtzlySkMA6JP288qO2` · 26 tracks, **all "- Live"**. A concert album, not
26 new songs: these are live re-recordings of tracks already in the catalogue, so
expect a far smaller bump than the track count suggests. Not double counting —
separate recordings with their own ids and their own streams, and kworb lists
them under TWICE — but it does mean part of TWICE's growth will be the same songs
performed live.

| # | Track ID | # | Track ID |
|---|---|---|---|
| 1 THIS IS FOR | `2ceQRBraJi6gZmjZpmyhKN` | 14 RIGHT HAND GIRL | `0sZuNgSByTNKzrNL1FuNbj` |
| 2 Strategy | `4jpntrHXRdZIXtqohpndgh` | 15 TT | `6Aax6FMEpCPiJCwuNAtYMt` |
| 3 MAKE ME GO | `4HSr3bZy3Q4mZpEI7JGJdT` | 16 Heart Shaker | `44pR0DMTyZHcSJ9jbT8yLY` |
| 4 SET ME FREE | `3a9s37U2Zs3ItuBLo06Z0I` | 17 Like OOH-AHH | `6DpLRqbD1aWdNIsMe9ai86` |
| 5 I CAN'T STOP ME | `1I5R1HS197HHVoEqovHgwy` | 18 YES or YES | `7JEsqWx0N9qSm3fd2lcDFD` |
| 6 OPTIONS | `2lN2w6dfjbf9rFNcFe9zEN` | 19 Dance The Night Away | `3Ld57MSsltgFgRmYGBsGpo` |
| 7 MOONLIGHT SUNRISE | `7LhevkEVe3dirzHctzR1vL` | 20 What is Love? | `4DwM3fExM73lpmjfyz2IyV` |
| 8 MARS | `4At34q0W9owV0ayMmMajaW` | 21 CHEER UP | `4VDT4dDuYFbFbn7bWonwJj` |
| 9 I GOT YOU | `2OQ3MA8CungsPYzc3q6XZ7` | 22 Feel Special | `0j9XnlwDGRHE1p50ZPHjJG` |
| 10 Talk that Talk | `4Jf9zO2El061h6hF1QghaF` | 23 ONE SPARK | `4OtuQ99K6pP6lWP6gbXHSO` |
| 11 Gone | `733diFQudsyhS1s1cQbI8W` | 24 DAT AHH DAT OOH | `7DB1FoScLHd08C8GqTAN6a` |
| 12 FIREWORK | `6BQWMrVdSJXyTg4xxdscOe` | 25 BATTITUDE | `3NyO0F4voTPzp1bp4nq45I` |
| 13 HELL IN HEAVEN | `7fuAygVwUwrrG4nmlDpglg` | 26 THIS IS FOR ONCE… | `2m8JfLyuj3DsKs9roXJp8J` |

### ILLIT — `BREAK EVEN` · 2026-10-26
Album `4xYpXVSKqRTsL3ucRd8EMM` · 4 tracks. A genuine new EP, and proportionally the
bigger of the two: ILLIT's catalogue is only 64 tracks, and ILLIT is the group the
Road to 1B board leads with (Magnetic).

| Track | Spotify ID |
|-------|-----------|
| Super in Love | `6CpYN9MxjHzzvcn71aQdMD` |
| More | `6oTEeofndrgN1q7et4xypc` |
| You're Under Arrest | `0pMoUGdpD8nupNP1mSdZUn` |
| Pop | `1mre3HoVD50XwY02NvxKZZ` |

**Reading the numbers before a re-seed.** `probe-track-playcount.yml` takes these
ids and prints each track's play_count, its credited artists, whether a pinned
catalogue counts it, and — with `kworb_artist` set — whether kworb lists it. That
last field is the re-seed trigger. `probe-album.yml` does the same per album.

**A separate case, same mechanism.** TWICE's *Bye Bye Inhibitions*
(`0uI8zAUhinOJDIfWYam8lX`, Alok × NAYEON × TWICE) is TWICE-credited but **not on
kworb** as of 2026-10-04, so it is correctly uncounted. At 409,478 streams against
TWICE's 13.03B it is 0.003% — nothing on the board moves either way. Same
resolution: when kworb lists it, re-seed.

---

## Auto-discovery of new releases

`fetch_artist_streams.py` (the daily `fetch-catalog.yml` job) **auto-detects brand-new releases** so a fresh single/EP is counted from day one — no manual `FIXED_TRACKS` edit needed. This is what fixes the old failure mode where a drop (e.g. Jennie's *Fallen Angel* EP) went uncounted until someone noticed.

- **How:** `discover_new_tracks()` walks the newest ~12 discography entries per artist and keeps tracks from releases dated within the last **75 days** (`within_days`) that the member is credited on. The recency gate is deliberate — the established back-catalog stays pinned to `FIXED_TRACKS` (kworb scope); discovery only ever **adds** recent drops, never re-walks/re-scopes the catalog.
- **Dedup:** skips a track whose ID is already tracked **or** whose normalized title already matches a tracked track — so a song re-released under a new track ID (a single later folded into an EP, e.g. the EP reissue of "Less than a Lover") is **not** double-counted.
- **Sticky:** a discovered track is persisted to `artist_tracks` and keeps being counted after it ages out of the 75-day window (`process_artist` unions `FIXED_TRACKS` + persisted `artist_tracks` + this-run discoveries, deduped by id and name).
- **Fail-safe:** the whole discovery/persist step is wrapped so any error falls back to the pinned `FIXED_TRACKS` list — the daily total can never be broken by it.
- **Kill switch:** set env `AUTO_DISCOVER=0` to run the pinned list only.
- **Preview (read-only):** the **`Preview new-release discovery`** workflow (`discover-tracks.yml` → `discover_tracks.py`) prints, per member, what discovery would add — writes nothing. Run it the morning after a drop to confirm it was caught, or any time to confirm nothing spurious is about to be added. Optional `within_days` input overrides the window.
