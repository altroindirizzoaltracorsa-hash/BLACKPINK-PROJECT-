# BPVMA — Local Test Environment

A self-contained harness for developing the VMA voting automation **offline**, with no
traffic to `vote.mtv.com` and no real votes cast. Two files:

| File | Role |
|------|------|
| `mock-voting-page.html` | Stand-in for the voting page — Best Pop / Best K-Pop, a login, a submit gate, and a fake server. |
| `bpvma-test.user.js` | The event-driven automation under test (Tampermonkey userscript). |

## Who gets voted for

Mirrors the real slot map in `vote-extension/README.md`:

| Category | Target | Real slot |
|---|---|---|
| Best Pop | **LISA** | `cat06` → `C1` |
| Best K-Pop | **BLACKPINK** | `cat11` → `A1` |

Best K-Pop lists **both** BLACKPINK and LISA (`A1` and `F1` on the real site), so the target
is not just "the BLACKPINK-ish button" — the run has to hit the right one of the two. Every
nominee on the page is votable and separately tallied, so clicking the wrong one shows up
rather than being silently swallowed.

Change the targets at the top of the userscript:

```js
const CATEGORIES = [
    { name: 'Best Pop',   candidate: 'LISA' },
    { name: 'Best K-Pop', candidate: 'BLACKPINK' }
];
```

## Running it

1. Save `mock-voting-page.html` anywhere on disk (Desktop is fine).
2. Install `bpvma-test.user.js` in Tampermonkey — dashboard → **Utilities** → **Install from
   URL**. It matches `file:///*/mock-voting-page.html`, so it runs wherever you keep the page.
3. Enable **"Allow access to file URLs"** for Tampermonkey in `chrome://extensions` →
   Details. Without this the script never injects and no panel appears.
4. Open the page (`Ctrl+O`, or drag it into Chrome). The run starts on its own.

The panel bottom-right shows live state, a `n / 2` category counter, and a log. A run ends
in exactly one terminal state: `ACCOUNT_COMPLETE`, `RUN_STOPPED: <category>`, `RUN_FAILED`,
`ACCOUNT_NOT_COMPLETE`, or `UNEXPECTED_ERROR`.

## Test modes

The script auto-starts ~500 ms after load, so there is no window in which you can click a
mode button and have it reach the run — and a plain variable would be wiped by the reload
anyway. **The mode lives in the URL hash**, which survives a reload:

```
mock-voting-page.html#10/success     10 selections, server always 200
mock-voting-page.html#20/failure     20 selections, server always 500
mock-voting-page.html#10/random      10 selections, ~20% 500s  (opt-in flakiness)
```

Clicking a TEST MODE button writes that hash and reloads, so the next run uses it. **F5
re-runs in the same mode.** The box shows both values so you can see what is active.

**Required selections** — `Normal — 10` / `Power/Double — 20`. **The script reads this off
the page**, so a power/double window is followed automatically with nothing to edit. If the
page publishes no usable number it falls back to 10 and says so in the log; a value outside
1–50 is rejected as a runaway guard.

This does not weaken the check. The assertion that matters is *"the server recorded the same
number of votes I actually cast, all to my target nominee"*, and that is verified against the
real confirmed click count — not against whatever the page asked for.

**Server behaviour** — `success` (always 200, **the default**), `failure` (always 500), `random`
(~20% 500s, opt-in). Login delay is 200–1500 ms and submit latency 100–2500 ms, both random, so
nothing in the script may assume a fixed wait.

A plain open now defaults to `success`, so it passes cleanly. On `#10/random` roughly a third
of runs stop on a genuine mock 500 — that is the fixture working, not a script fault, and the
log now says so outright.

## What the script proves

It is event-driven end to end — no `setTimeout` guesses anywhere in the flow. Every step
waits on real evidence via a `MutationObserver`, with a 5 s timeout:

- **Login** — waits for `"Logged in as …"` in the status line, not for the click.
- **Selection** — clicks the category's target nominee until *that nominee's own*
  `.vote-count` reports the required number, confirming each click individually rather than
  assuming it landed.
- **Submit gate** — waits for the button to actually become enabled and visible.
- **Network** — registers its `mock-vote-completed` listener *before* clicking submit, then
  requires `statusCode` 2xx **and** `candidate` === this category's target **and**
  `votes[target] === REQUIRED_VOTES` **and** `total === REQUIRED_VOTES`. The page reports
  `candidate: "MIXED"` when votes were split across nominees, which fails.
- **UI** — after the 2xx, still requires `"We got your vote today"` on screen. A network
  success with no UI confirmation fails the category.

A category counts as complete only when all of the above pass, and `ACCOUNT_COMPLETE` only
when every category did. Any failure halts the run rather than moving on.

**On the duplicate event:** the mock deliberately fires each success event twice (the second
50 ms later, same timestamp) and the script correctly counts it once — verified: 4 events
dispatched, `2 / 2` categories. Note that this is guaranteed by *listener lifetime* — the
per-submission listener is removed the moment the first event resolves, so the duplicate
arrives with nothing attached. The `seenTimestamps` set never actually fires here; it is a
second line of defence for a duplicate that beats the resolve, not the mechanism under test.

## Verification

Run against Chromium via Playwright, injecting the script at `document-end` with **no UI
interaction** — exactly what a real Tampermonkey install does:

| Scenario | Result |
|---|---|
| `#10/success` | `ACCOUNT_COMPLETE`, 2/2 — **8/8 runs, no flake** |
| Nominees actually tallied | Best Pop `{LISA:10}`, Best K-Pop `{BLACKPINK:10, LISA:0}` |
| `#10/failure` | `RUN_STOPPED: Best Pop`, reason `server_failure` |
| `#20/success` | `ACCOUNT_COMPLETE`, 20/20 — auto-detected, no script edit |
| `#20/failure` | `RUN_STOPPED: Best Pop` |
| Count missing / `abc` / `9999` / `0` | falls back to 10, logs why |
| No hash (defaults) | `10/success` — **6/6 clean** |
| Click `Force Success` → reload → run | hash applied, `ACCOUNT_COMPLETE` |
| Duplicate event | 4 dispatched, counted once, 2/2 |

Negative tests — the harness must **refuse** these, and does:

| Sabotage | Result |
|---|---|
| Script clicks LISA in K-Pop while expecting BLACKPINK | `RUN_STOPPED: Best K-Pop` |
| A stray LISA vote contaminates K-Pop before the run | `RUN_STOPPED` — `wrong_vote_total (server recorded 11, cast 10)` |

## Fixed in v2.1

v2.0 could never get past its first selection. In the click loop, `expected` was computed
*after* the click:

```js
clickElement(lisa);
const expected = getVoteCount(categoryName) + 1;   // ← already incremented
await waitForDOMCondition(() => getVoteCount(categoryName) >= expected);
```

The page updates `.vote-count` synchronously inside its own click handler, so reading after
the click already sees the new value. `expected` therefore became *two* higher than the
pre-click count — a number no single click can reach — and every selection timed out after
5 s with `"selection was not confirmed"`, ending the run at `RUN_STOPPED: Best Pop` with
0/2. The fix reads the baseline before clicking and waits for `before + 1`.

Also in v2.1: `@match` no longer hard-codes one desktop path; `SUBMIT_TIMEOUT` explains
itself; and `waitForMockVote` clears its timeout on resolve instead of leaving it pending.
