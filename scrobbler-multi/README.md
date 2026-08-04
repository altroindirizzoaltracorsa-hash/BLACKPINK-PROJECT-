# SessionBox Multi-Account Scrobbler

A Manifest V3 browser extension that scrobbles **every SessionBox Spotify tab**
— foreground *and* background — to Last.fm / Libre.fm / ListenBrainz. It can
route each Spotify account to its own scrobbling account, or funnel **many
Spotify accounts into one** scrobbling account.

## How it works

SessionBox isolates each tab's Spotify login, but extensions are shared across
tabs, so the extension routes by the Spotify identity each tab reveals (read
from inside the tab) rather than by SessionBox internals.

The key detail is **how** tabs are read. Chrome heavily throttles and can
suspend timers inside background tabs, so a script polling from *within* each
tab only works for the foreground one. Instead, an **alarm in the background
worker** fires on a schedule (~every 30s) and injects a one-shot reader into
every Spotify tab. Because the read is driven from the worker, it isn't subject
to the target tab's throttling — so background tabs get scrobbled too.

```
alarm (~30s) ─▶ background worker
                  │  for each open.spotify.com tab:
                  │    inject reader → { account, now-playing, playing? }
                  │    advance that tab's play-time (persisted in
                  │      chrome.storage.session so it survives worker restarts)
                  ▼
        map Spotify account ──▶ its scrobble targets (or the shared default)
        apply timing rule ──▶ Last.fm / Libre.fm / ListenBrainz
```

- `src/background.js` — the alarm, the poll/inject, per-tab play tracking, the
  AudioScrobbler timing rule (half the track or 4 min; skip < 30s), and dispatch.
- `src/scrobblers/audioscrobbler.js` — Last.fm **and** Libre.fm (same GNU FM 2.0
  API). Uses `auth.getMobileSession` so each account authenticates with its own
  username/password, independent of any browser login.
- `src/scrobblers/listenbrainz.js` — token-based submit.
- `src/lib/md5.js` — UTF-8-safe MD5 for `api_sig`.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick
   this `scrobbler-multi/` folder. Works in any Chromium browser.
2. Open the extension's options.

## Setup

1. **API credentials** (section 1): create one app at
   <https://www.last.fm/api/account/create> (callback URL can be blank) and paste
   the key + secret. Same for Libre.fm if you use it. ListenBrainz needs nothing.
2. **Many Spotify → one account** (section 2, "Default account"): connect one
   Last.fm / Libre.fm / ListenBrainz account here, and **every** Spotify tab
   scrobbles to it. Type that account's own username + password (or ListenBrainz
   token) and click Connect.
3. **Different targets per account** (section 3): play a track in a SessionBox
   tab so its profile appears, then connect a *different* account on that
   profile — it overrides the default for that profile only.

## Caveats

- **Poll cadence ~30s**, so now-playing and scrobbles can lag up to a minute.
  For full plays that's fine; very short skips may be missed.
- **A tab must stay alive to be read.** Chrome does not freeze tabs that are
  actively producing audio, so simultaneously *playing* tabs are read. But a
  tab that is **muted and long-backgrounded can be frozen/discarded** by Chrome,
  and then neither this extension nor any other in-browser scrobbler can see it.
  For that scenario a server-side scrobbler is the only reliable option.
- **Spotify DOM/endpoints change.** Track title/artist come from `mediaSession`
  (stable); account detection and duration use Spotify endpoints/`data-testid`
  elements that Spotify occasionally renames — update the selectors in the
  `readState` function in `src/background.js` if detection stops working.
- Credentials are used once to obtain a session key; only the key/token is stored
  (in `chrome.storage.local`), on this machine.
- Driving play counts across many accounts is against Spotify's and Last.fm's
  terms of service; this tool only attributes plays you already make.
