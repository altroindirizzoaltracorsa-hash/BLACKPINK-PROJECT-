# BPVMA — Local Test Environment

A self-contained harness for developing the VMA voting automation **offline**, with no
traffic to `vote.mtv.com` and no real votes cast. Two files:

| File | Role |
|------|------|
| `mock-voting-page.html` | Stand-in for the voting page — Best Pop / Best K-Pop, LISA, a login, a submit gate, and a fake server. |
| `bpvma-test.user.js` | The event-driven automation under test (Tampermonkey userscript). |

## Running it

1. Open `mock-voting-page.html` from disk (`file://…`).
2. Install `bpvma-test.user.js` in Tampermonkey. It matches
   `file:///*/mock-voting-page.html`, so it runs wherever you keep the page — Tampermonkey
   needs **"Allow access to file URLs"** enabled for the extension in `chrome://extensions`.
3. Pick a **TEST MODE** on the page, then reload. The panel bottom-right shows live state,
   a `n / 2` category counter, and a log.

A run ends in exactly one terminal state: `ACCOUNT_COMPLETE`, `RUN_STOPPED: <category>`,
`RUN_FAILED`, `ACCOUNT_NOT_COMPLETE`, or `UNEXPECTED_ERROR`.

## Test modes

**Required selections** — `Normal — 10` / `Power/Double — 20`. This is set on the page and
in the script *independently*: `REQUIRED_VOTES` in the userscript is the **assertion**, not
a reading of the page, so a mismatch is supposed to fail the run. Because a bare
`SUBMIT_TIMEOUT` reads like a script bug, a pre-flight check logs a loud `MODE MISMATCH`
line when the two disagree.

**Server behaviour** — `Force Success` (always 200), `Force Failure` (always 500), `Random`
(~20% 500s, the default). Login delay is 200–1500 ms and submit latency 100–2500 ms, both
random, so nothing in the script may assume a fixed wait.

## What the script proves

It is event-driven end to end — no `setTimeout` guesses anywhere in the flow. Every step
waits on real evidence via a `MutationObserver`, with a 5 s timeout:

- **Login** — waits for `"Logged in as …"` in the status line, not for the click.
- **Selection** — clicks LISA until `.vote-count` *itself* reports the required number,
  confirming each click individually rather than assuming it landed.
- **Submit gate** — waits for the button to actually become enabled and visible.
- **Network** — registers its `mock-vote-completed` listener *before* clicking submit, then
  requires `statusCode` 2xx **and** `candidate === 'LISA'` **and**
  `total === REQUIRED_VOTES`.
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

Run against Chromium via Playwright, driving the page and injecting the script:

| Scenario | Result |
|---|---|
| Force Success + Normal (10) | `ACCOUNT_COMPLETE`, 2/2 — **8/8 runs, no flake** |
| Force Success + Power/Double (20), script set to 20 | `ACCOUNT_COMPLETE`, 2/2 |
| Force Failure | `RUN_STOPPED: Best Pop`, reason `server_failure` |
| Mode mismatch (page 20, script 10) | `MODE MISMATCH` warning, then `SUBMIT_TIMEOUT` |
| Random ×6 | 5 complete, 1 stopped on a genuine mock 500 |
| Duplicate event | 4 dispatched, counted once, 2/2 |

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
