# Blinks United — Vote Counter (Chrome extension)

Counts the votes you cast on **vote.mtv.com** (MTV VMAs) and
**vote.breaktudoawards.com** (BreakTudo Awards) for **BLACKPINK & members** and logs
them to your **blinksunited.com `/voting`** board automatically — no more typing
numbers into "Add votes". It only *observes* the votes you cast yourself; it never
votes for you. The two awards are tracked **separately** (own counts, own board
dimension) but through **one** linked account.

## BreakTudo detection (differs from VMA)
BreakTudo's vote request is a **POST** whose candidate ids live in the **body**, not
the URL: `POST /wp-json/bta/v1/awards/vote/?_wpnonce=… →
action=update_vote&votes=[{"id":"<base64>","pos":N}]&valid=<turnstile>`. So
`background.js` reads it with `onBeforeRequest` + `['requestBody']`, grabs the
`/vote/<slug>/` referer in `onSendHeaders`, and only counts it once `onCompleted`
confirms a 2xx.

**The three events must share state across a service-worker restart.** Under MV3
Chrome tears the worker down between them, so the in-memory `requestId → body` map
this used to keep was empty by the time `onCompleted` fired and **every BreakTudo
vote was dropped, with nothing logged**. (The VMA path never hit this: it reads
everything off the URL in a single `onCompleted`.) The map now lives in
`chrome.storage.local` under `btInflight`, with every touch serialised through
`btQueue` so the three events can't clobber each other's read-modify-write.

**`pos` is decided per batch, not assumed.** BreakTudo has shipped both
`[{id:BP,pos:5}]` (one entry, `pos` = a count) and
`[{id:BP,pos:1},…,{id:BP,pos:5}]` (one entry per mark, `pos` = its index). Summing
blindly turns the second into 15; counting entries blindly turns the first into 1.
A run of distinct positions `1..N`, each appearing once, is an index sequence → one
vote per entry; anything else → `pos` is a count. There's no daily cap (repeat
sequences all count); retries are de-duped by the Turnstile token **plus each mark's
id+pos** so distinct marks under one token still count.

**The path is a hint, not a gate.** What makes a request a vote is a readable
`update_vote` body — pinning it to `/wp-json/bta/v1/awards/vote` meant a silent zero
the day the endpoint moved (WordPress sites routinely post the same action to
`/wp-admin/admin-ajax.php`).

**A category can hold more than one of ours.** Int. Music Video has BLACKPINK's
"GO" *and* LISA's "Dream" in it, and a fan can vote for both — both count, and
each log row names the right one. The payload identifies a nominee only by an
opaque base64 id, so `BT_CATS` lists the members (`who: ['BLACKPINK','LISA']`)
and `btNomineeFor()` resolves which is which by asking the content script on the
page, which can see the id and the name together. A reply is trusted only when it
matches a nominee the category itself declares, so the lookup can never invent a
member or credit the wrong one; unresolved, the row reads "BLACKPINK / LISA"
rather than guessing. Answers are remembered in `btNominees`.

This is also why `pos` is only read as an index when every entry shares the same
id: `[{GO,pos:1},{Dream,pos:2}]` is two nominees with their own counts (3 votes),
not one nominee marked twice.

**The panel never grows past the window.** Its resize grip sits on the bottom
edge, and the BreakTudo build is tall (eight category rows above the activity
log), so on a laptop the bottom edge — grip included — ended up below the fold
and the only way to reach it was to zoom the page out. The column layout and the
scrolling body are now the default, with a `max-height` measured from the panel's
own top (`fitToViewport`, re-run on every render, drag and window resize), and
both dragging and a stale saved position are clamped so a minimum-height panel
always fits below the drop point.

**Only BLACKPINK/member/BLINKs votes are counted**: a vote is ours iff its candidate
id is a known BP id (`BT_CANDIDATES`) OR it's cast on one of our nominated category
pages (`BT_CATS`, keyed by the `/vote/<slug>/` referer). Any other vote — a different
artist or a Brazilian/other category — is skipped.

**A vote that isn't counted says so.** Every non-count is recorded in `btDiag`
(newest first, last 12) and the on-page panel shows the newest one: not linked, held
after a network failure, category not recognised (**with the slug**, so a missing
`BT_CATS` entry can be reported), BreakTudo rejected it, or a body we couldn't read
(with the endpoint). It used to be completely silent — the counter just sat at zero.
POSTs carry `{award:'breaktudo'}`; the VMA path is untouched.

## How it works
1. `background.js` watches the site's own vote request with **`chrome.webRequest`**:
   `POST /api/prod/vote/s2/vote?...&category=cat11&total=10&A1=9&F1=1` (everything —
   category, nominee slots, the voting account — is in the URL). Using webRequest
   instead of a page-world (`world:"MAIN"`) hook keeps it working on older Chromium
   like **Kiwi**, not just Chrome 111+.
2. On a **successful** submission (HTTP 200) it reads `category` + the nominee slots
   (`A1`, `C1`, `F1`…).
3. It keeps only the slots that are BLACKPINK/a member (see `BP_SLOTS`) and POSTs those
   votes to `blinksunited.com/api/vma-votes` using your account **link token**.
4. You link once at **blinksunited.com/vote-link.html** (sign in with Google / X /
   Discord / magic link — same account as the site) — `bu-link.js` stores the token;
   the popup shows your live count.
5. `panel.js` draws an on-page **BLINKS UNITED panel** right on `vote.mtv.com` (in a
   shadow root so MTV's styles can't touch it): the running "counted today" total, a
   BLACKPINK / LISA split, a live activity log, and a **"blinks voting now"** pulse. It's
   draggable and collapsible. The pulse is `GET /api/vma-votes?live=1` — distinct
   accounts that logged a vote in the last 90s, i.e. **our community**, NOT a global MTV
   count (which MTV doesn't expose).

## Two builds: MV3 (desktop Chrome) vs MV2 (Kiwi / Android)
`manifest.json` is Manifest V3 for desktop Chrome. **Kiwi Browser doesn't reliably
inject MV3 content scripts**, so there's also `manifest-mv2.json` (Manifest V2, Kiwi's
native mode). All the JS is identical and works under both — only the manifest differs.
The Kiwi build ships `manifest-mv2.json` copied in as `manifest.json`, with the MV3
one omitted; the Android browsers can install the resulting `.zip` directly.

**Build both with `./.github/scripts/build-extension.sh`** rather than zipping by
hand. It reads the version from the manifests (and refuses to build if the two
disagree), writes `vote-extension-v<version>-{chrome,android}.zip` at the repo root,
and then asserts what it produced: the right `manifest_version` in the right zip,
exactly one manifest in each, the expected nine entries, and no README. Packing this
by hand is how the wrong manifest ends up in the wrong zip.

### "Manifest version 2 is deprecated" on Kiwi / Lemur / Quetta
Expected, and **not a failure**. Chromium prints it — as a WARNING, orange triangle,
not a red error — the moment any MV2 extension is loaded, before you touch it. The
extension still installs and runs.

MV2 here is a deliberate choice, not stale packaging: these Android forks are the
only way to run an extension on mobile at all, and they don't reliably inject MV3
content scripts, which is the whole mechanism the counter depends on. Desktop Chrome
has dropped MV2, which is exactly why the desktop zip is MV3 and only the Android one
is not. Shipping MV3 to Android to silence the warning would trade a cosmetic notice
for a counter that quietly stops counting.

If an Android fork ever stops loading MV2 outright — a real error, not this warning —
the fix is to test whether that browser injects MV3 content scripts on
`vote.breaktudoawards.com`, and switch the Android zip to MV3 only if it does.

## Install (unpacked, for testing)
1. Desktop **Chrome → `chrome://extensions`**.
2. Turn on **Developer mode** (top-right).
3. **Load unpacked** → select this `vote-extension/` folder.
4. Click the extension → **Link my blinksunited account** → sign in on the page that
   opens. Popup should then say **● Linked**.
5. Go to `vote.mtv.com`, vote for BLACKPINK — the popup count goes up and votes appear
   on `/voting`.

## Adding categories (important)
`background.js` only counts categories listed in **`BP_SLOTS`**. It ships with the ones
we've confirmed:

```js
const BP_SLOTS = {
  cat06: ['C1'],         // Best Pop   → C1 = LISA
  cat11: ['A1', 'F1'],   // Best K-pop → A1 = BLACKPINK, F1 = LISA
};
```

These are the only two **fan-voted** categories BLACKPINK/members appear in, so this map
is complete. **The slot key is not fixed** — it varies per category and even per nominee
(Best Pop LISA is `C1`; Best K-pop is `A1` for BLACKPINK and `F1` for LISA), and one
submission can split votes across slots (`{"cat11":{"total":10,"A1":9,"F1":1}}` — we sum
every slot we list). So each entry lists the exact slot(s) for *that* category.

To add the rest: cast one vote for BLACKPINK/a member in a category, open DevTools →
Network → the `vote?...` request → note its **`category`** and which slot (`A1`, `C1`,
…) got the votes, then add `'<category>': ['<slot>']` (list every slot you want counted).
Votes in **un-mapped** categories are logged to the service-worker console
(`chrome://extensions` → the extension's "service worker" link) so you can discover them
as you go.

## Cross-device sync (opt-in)
By default everything the panel shows — counts, the activity log, and the accounts
list — is **local to that browser/device** and never leaves it; only the votes
themselves are logged to your `/voting` account. Flip **⇄ Sync my devices** on (needs
the account linked) and each counted vote also records today's BLACKPINK/LISA split +
the voting account under your BU account, so the counts and accounts-used list **merge
across every device you enable it on**. It's read back only by you (auth'd by your link
token). Turning it off returns to local-only. Requires running `supabase/vma_ext_sync.sql`
once. The `/voting` board total is account-wide either way.

## Notes / limits
- **Desktop Chrome, or mobile Kiwi Browser** — regular mobile Chrome can't run
  extensions, but Kiwi (Android, Chromium-based) can, and this build avoids the
  modern-only features (`world:"MAIN"`) that used to break it there.
- **Count, never auto-vote** — safe under VMA rules; it only reads your own votes.
- **Not tamper-proof**, but far harder to inflate than typing a number — a real
  honour-system upgrade.
- **Brittle to MTV changes** — if MTV changes the vote endpoint/params next cycle,
  `parseVoteUrl` / `BP_SLOTS` in `background.js` need a small update.

## Publishing (optional)
To share it beyond "load unpacked", publish to the **Chrome Web Store** (one-time $5
developer account + a review), or distribute the folder for people to load unpacked.
Add real 16/48/128px icons before publishing (Chrome uses a default puzzle icon now).
