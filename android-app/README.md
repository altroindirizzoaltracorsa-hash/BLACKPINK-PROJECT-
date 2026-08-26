# Blinks United — VMA Vote Counter (Android app)

A thin native wrapper around **vote.mtv.com** that does what the browser extension does,
for phones that can't run extensions. You vote **inside the app**, and it counts the
BLACKPINK & LISA votes you cast and logs them to your **blinksunited.com/voting** board.
It only reads your own votes — it **never votes for you**.

## Why an app
On a phone, a normal app can't watch votes you cast in Safari/Chrome (OS sandboxing).
So instead the app *is* the browser for voting: it opens vote.mtv.com in a WebView and
injects the same counting logic the extension uses.

## How it works
- `assets/counter.js` is injected on **vote.mtv.com** — it hooks `fetch`/`XMLHttpRequest`
  and, on a **successful** vote, hands the request URL to the native side
  (`BUAndroid.recordVote`).
- `VoteParser.kt` parses that URL (port of the extension's `parseVoteUrl` + `BP_SLOTS`):
  `cat06 → C1 = LISA`, `cat11 → A1 = BLACKPINK, F1 = LISA`.
- `VoteApi.kt` POSTs the counted votes to `https://blinksunited.com/api/vma-votes`
  with your account link token (native HTTP → no CORS).
- `assets/link.js` is injected on **blinksunited.com** — a port of `bu-link.js`. Tap
  **Link**, sign in on `extension-link.html`, and it hands the token to the app
  (`BUAndroid.setToken`).

## Build
Pushed changes under `android-app/` trigger `.github/workflows/build-android.yml`, which
builds a signed release APK and commits it to the repo root as
`blinks-united-vote-counter.apk` (served from the site). To build locally:

```
cd android-app
gradle assembleRelease      # or: gradle assembleDebug
# → app/build/outputs/apk/release/app-release.apk
```

## Install (sideload)
1. Download `blinks-united-vote-counter.apk` from blinksunited.com/voting.
2. Open it; allow **Install unknown apps** for your browser when prompted.
3. Open the app → **Link** → sign in → vote on the MTV page inside the app.

## Notes / limits
- **Count, never auto-vote** — safe under VMA rules.
- **Android only.** iPhone can't sideload apps; that path needs the App Store.
- Sign in with **email / password** works fully in-app; Google OAuth may require the
  system browser (some identity providers refuse embedded WebViews).
- The signing keystore is committed so updates install over old versions. It only
  identifies the publisher — it does not protect user data.
