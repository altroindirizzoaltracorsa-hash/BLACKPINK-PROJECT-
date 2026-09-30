# Blinks United — Vote Counter (Android app)

A thin native wrapper around the vote sites that does what the browser extension does,
for phones that can't run extensions. You vote **inside the app**, and it counts the
BLACKPINK / member / BLINKs votes you cast and logs them to your
**blinksunited.com/voting** board. It only reads your own votes — it **never votes for
you**.

Counts **both awards**, kept apart end to end exactly as the board keeps them:

| | |
|---|---|
| **BreakTudo** | open until 17 Oct — what the Vote button opens |
| **MTV VMAs** | closed since 25 Sep; still counted if you navigate to vote.mtv.com, because the ballot returns next year |

## Why an app
On a phone, a normal app can't watch votes you cast in Safari/Chrome (OS sandboxing).
So instead the app *is* the browser for voting: it opens the vote site in a WebView and
injects the same counting logic the extension uses.

## How it works
- `assets/counter.js` is injected on **both** vote sites and picks its award from its
  own `location.hostname`. It hooks `fetch`/`XMLHttpRequest` and reports only
  **successful** submissions.
  - MTV: everything is in the request URL, so the URL goes over
    (`BUAndroid.recordVote`).
  - BreakTudo: the marks are in the POST **body** and the category comes from the page
    URL, so the payload goes over (`BUAndroid.recordBtVote`).
- `VoteParser.kt` parses the MTV URL (port of the extension's `parseVoteUrl` +
  `BP_SLOTS`): `cat06 → C1 = LISA`, `cat11 → A1 = BLACKPINK, F1 = LISA`.
- `BtVoteParser.kt` parses the BreakTudo payload (port of `BT_CATS`, `BT_CANDIDATES`
  and `processBtVote`), including the `pos` ambiguity — the same nominee marked 1..N is
  an index sequence worth N, while one entry with `pos:N` is a count worth N — and it
  folds BreakTudo's alias category slugs so the board never splits one category in two.
- `VoteApi.kt` POSTs the counted votes to `https://blinksunited.com/api/vma-votes`
  with your account link token (native HTTP → no CORS). BreakTudo posts carry
  `award: "breaktudo"` and the category slug.

### Why the BreakTudo half is simpler here than in the extension
The extension has to stitch one vote together across three `webRequest` events — body,
Referer, outcome — keyed by `requestId`, and that stitching is exactly what MV3's
service-worker teardown kept breaking. In the page, the body and `location.pathname`
are both in hand at the call site, so there is nothing to stitch.

### Two awards, two clocks
The in-app "today" counters roll separately: the VMA day at **midnight ET** (MTV's own
reset) and BreakTudo at **midnight KST**. BreakTudo has no daily reset of its own, so
that bucket is ours and has to match the server — see `breaktudo_day_boundary_kst.sql`
and `kstDay()` in `/api/vma-votes`. Sharing one "today" would reset one award on the
other's clock.
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
