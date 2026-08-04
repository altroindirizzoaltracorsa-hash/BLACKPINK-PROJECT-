# SessionBox Multi-Account Scrobbler

A Manifest V3 browser extension that scrobbles **each SessionBox Spotify tab to
its own Last.fm / Libre.fm / ListenBrainz account** — something the standard Web
Scrobbler can't do, because it holds only one account connection per browser
profile.

## How it works

SessionBox isolates each tab's Spotify **login**, but browser extensions are
shared across all tabs. So the trick is not to look at SessionBox at all — it's
to route by the Spotify identity the tab reveals:

```
Spotify tab (SessionBox profile A)          Spotify tab (SessionBox profile B)
        │  content script reads:                     │
        │  • now-playing (mediaSession)              │
        │  • THIS tab's Spotify account              │
        └───────────────┬────────────────────────────┘
                       ▼
              Background service worker
              maps Spotify account ──▶ Last.fm / Libre.fm / ListenBrainz
              applies scrobble timing, sends to the right accounts
```

- `src/inject-main.js` runs in the page's **MAIN world** so it can read
  `navigator.mediaSession` and fetch the tab's Spotify account with that tab's
  isolated cookies.
- `src/content.js` (isolated world) relays those payloads to the worker.
- `src/background.js` tracks playback per tab, enforces the AudioScrobbler
  timing rule (half the track or 4 minutes, whichever comes first; tracks under
  30s are skipped), and dispatches to every service mapped to that account.
- `src/scrobblers/audioscrobbler.js` handles Last.fm **and** Libre.fm (Libre.fm
  runs GNU FM, same 2.0 API — only the URL differs). `listenbrainz.js` handles
  the token-based ListenBrainz API.

## Install (unpacked)

1. Go to `chrome://extensions`, enable **Developer mode**, click **Load
   unpacked**, and select this `scrobbler-multi/` folder. (Works in any
   Chromium browser — Chrome, Edge, Brave — where you run SessionBox.)
2. Open the extension's options.

## Setup

1. **API credentials** (options → section 1):
   - Last.fm: create one app at <https://www.last.fm/api/account/create> and
     paste the API key + shared secret.
   - Libre.fm: register at <https://libre.fm/> and paste its key + secret.
   - ListenBrainz needs nothing here.
2. **Detect accounts**: play a track in each SessionBox Spotify tab once. Each
   account then appears under section 2. Click **Refresh** if needed.
3. **Connect services** per profile, using **that account's own** credentials:
   - Last.fm / Libre.fm: type the account's username + password and click
     **Connect**. This uses the `auth.getMobileSession` API, so it authenticates
     that specific account directly — it does **not** depend on which account the
     browser is logged into, which is what lets each profile reach a different
     Last.fm account.
   - ListenBrainz: paste the user token from
     <https://listenbrainz.org/settings/> and click **Save**.
4. Toggle a profile off to pause scrobbling for that account.

> Credentials are used once to obtain a session key, which is what's stored
> (in `chrome.storage.local`); for Last.fm the password itself is not kept.

## Caveats

- **Spotify DOM/endpoints change.** Account detection uses the web player's
  access-token endpoint (falling back to the account widget), and duration comes
  from a `data-testid` element. If Spotify changes these, update the selectors in
  `src/inject-main.js`. Track title/artist come from `mediaSession`, which is
  stable.
- Account detection needs a non-anonymous (logged-in) Spotify session in the tab.
- Credentials and session keys are stored in `chrome.storage.local` on this
  machine only.
- Running many Spotify accounts to drive play counts is against Spotify's and
  Last.fm's terms of service; this tool only attributes plays you already make.
