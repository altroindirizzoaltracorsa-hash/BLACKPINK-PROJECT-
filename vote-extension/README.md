# Blinks United — VMA Vote Counter (Chrome extension)

Counts the votes you cast on **vote.mtv.com** for **BLACKPINK & members** and logs
them to your **blinksunited.com `/voting`** board automatically — no more typing
numbers into "Add votes". It only *observes* the votes you cast yourself; it never
votes for you.

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
To make the Kiwi build, package the folder with `manifest-mv2.json` copied in as
`manifest.json` (and omit the MV3 one). Kiwi can install the resulting `.zip` directly.

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
