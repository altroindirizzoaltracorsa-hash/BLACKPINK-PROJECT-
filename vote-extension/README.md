# Blinks United — Vote Counter (Chrome extension)

Counts the votes you cast on **vote.mtv.com** (MTV VMAs),
**vote.breaktudoawards.com** (BreakTudo Awards) and **kca.nick.tv** (Nickelodeon
Kids' Choice Awards) for **BLACKPINK & members** and logs them to your
**blinksunited.com `/voting`** board automatically — no more typing numbers into
"Add votes". It only *observes* the votes you cast yourself; it never votes for
you. The three awards are tracked **separately** (own counts, own board
dimension) but through **one** linked account.

Each site hides what a vote *is* somewhere different, which is why there are
three detection sections below rather than one: the VMAs put everything in the
request URL, BreakTudo in a form body keyed by an opaque base64 id, and Kids'
Choice in a JSON body that names nobody at all.

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


## Kids' Choice detection (names nobody — the ballot does)
The KCA vote is a **POST with a JSON body** and batched:

```
POST https://kca.nick.tv/api/vote
{"user_id":"<uuid>","region":"us","environment":"production",
 "votes":[{"question_id":"<uuid>","option_id":"<uuid>"}, …]}
```

Three facts about that shape decide the whole module.

**One entry is exactly one vote.** There is no count, weight or position field
anywhere in the body, so the BreakTudo `pos` ambiguity simply does not exist
here — entries are counted. (Confirmed across a captured 36-category session:
six flushes of 5–7 entries, 36 distinct `question_id`s, 36 distinct
`option_id`s, no repeats.)

**A round is submitted in batches, so the referer is useless.** The ballot does
not submit per category: picks accumulate and flush in groups around the
interstitial ads. In the captured session a flush refered from
`/vote/favorite-female-animated-voice-from-a-movie` carried six *earlier*
categories. Attribution therefore comes from the ids, never from the referer —
and `cats` on the POST to `/api/vma-votes` is a **map**, because one submitted
round legitimately carries BLACKPINK *and* ROSÉ *and* Dracula at once.

**Both ids are opaque.** Nothing in the payload says "BLACKPINK". So the counter
needs a map from `option_id` to the nominee's name, and it takes one from the
ballot itself: every `/vote/` page carries all 36 questions, each with
`{id, slug, title}` and options with `{id, title}`. `panel.js` reads it and hands
it to `background.js` (`bu-kca-ballot`), which caches it in `kcaBallot` for six
hours. The pair this yields for BLACKPINK — question `1ae0e782…`, option
`aa2a878e…` — is the exact pair the captured vote request sent, so this is a
decode and not a guess.

**Finding the ballot is the fiddly part.** It is *not* inline — no inline
`<script>` assigns `window.jsonData` itself — and a content script runs in an
isolated world, so the global is out of reach (`world:"MAIN"` is not an option
here: the Kiwi-family Android browsers don't inject it reliably). What *is* in
reach is a same-origin `fetch` and the page's own `script[src]` list. So the
ballot file is identified **by what it contains**, not by its URL, which carries
a UUID that will change; the object is then brace-matched out and `JSON.parse`d,
with string state tracked so a `{` inside a nominee title cannot end it early.

**Two mechanisms were rejected, both for the same reason.** Adobe click
telemetry (`edge.adobedc.net`) carries the nominee's name per click, but any ad
blocker removes it *and* it races the SPA router — in the capture one BLACKPINK
click was reported under the **next** category's URL. And inferring the ids by
matching click order against the flush works right up until the two orders
differ once, after which it credits the wrong nominee silently. The ballot makes
inference unnecessary.

**A rival in our category is not ours.** A vote counts only when the category
*and* the nominee match, which is what stops a BTS vote in Favorite Music Group
or Duo being counted. Names are compared with accents, case and punctuation
folded — without the accent fold, ROSÉ's votes never count at all.

**Dedupe is the opposite of BreakTudo's, deliberately.** KCA allows repeat
voting and a second round casts the very same `(question, option)` pairs again,
so keying on the pairs alone would silently cap every blink at one round. There
is no token, nonce or captcha in the payload to key on instead. So the pairs are
keyed **within a 90-second window**: a network retry arrives seconds later, while
a fresh round takes minutes because it walks all 36 categories.

**Without the ballot, nothing is counted — and the panel says why.** Guessing
which of six entries was BLACKPINK would invent votes, so `kcaDiag` carries a
`no-ballot` reason and the panel shows it. The same goes for an `option_id` the
map doesn't know (`unidentified`). Silence would read as "you cast none".

**`user_id` is never read, stored or sent.** It is the voter's own KCA identity;
`parseKcaBody` takes the votes array and nothing else.

Both halves are covered by `.github/scripts/test_vote_kca_counter.mjs`, which
decodes the real captured flush (de-identified) against the real ballot ids.

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
