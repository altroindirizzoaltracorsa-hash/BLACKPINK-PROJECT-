# Blinks United — VMA Vote Counter (Chrome extension)

Counts the votes you cast on **vote.mtv.com** for **BLACKPINK & members** and logs
them to your **blinksunited.com `/voting`** board automatically — no more typing
numbers into "Add votes". It only *observes* the votes you cast yourself; it never
votes for you.

## How it works
1. On `vote.mtv.com`, `interceptor.js` (page world) watches the site's own vote
   request:
   `POST /api/prod/vote/s2/vote?...&category=cat06&total=10&C1=10` → response
   `{"votestring":"{\"cat06\":{\"total\":10,\"C1\":10}}","response_code":"20"}`.
2. On a **successful** submission it reads `category` + the nominee slots (`C1`, `C2`…).
3. `background.js` keeps only the slots that are BLACKPINK/a member (see `BP_SLOTS`)
   and POSTs those votes to `blinksunited.com/api/vma-votes` using your account
   **link token**.
4. You link once at **blinksunited.com/extension-link.html** (same login link the
   scrobbler uses) — `bu-link.js` stores the token; the popup shows your live count.

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
  cat06: ['C1'],   // Best Pop   → LISA
  cat11: ['A1'],   // Best K-pop → LISA / BLACKPINK
};
```

**The slot key is not fixed** — it varies per category (Best Pop uses `C1`, Best K-pop
uses `A1`, …), and a category can have more than one of our nominees (Best K-pop has
both BLACKPINK and LISA). So each entry lists the exact slot(s) for *that* category.

To add the rest: cast one vote for BLACKPINK/a member in a category, open DevTools →
Network → the `vote?...` request → note its **`category`** and which slot (`A1`, `C1`,
…) got the votes, then add `'<category>': ['<slot>']` (list every slot you want counted).
Votes in **un-mapped** categories are logged to the service-worker console
(`chrome://extensions` → the extension's "service worker" link) so you can discover them
as you go.

## Notes / limits
- **Desktop Chrome only** — Chrome extensions don't run on mobile.
- **Count, never auto-vote** — safe under VMA rules; it only reads your own votes.
- **Not tamper-proof**, but far harder to inflate than typing a number — a real
  honour-system upgrade.
- **Brittle to MTV changes** — if MTV changes the vote endpoint/params next cycle,
  `interceptor.js` / `BP_SLOTS` need a small update.
- **Requires Chrome 111+** (uses a `world: "MAIN"` content script).

## Publishing (optional)
To share it beyond "load unpacked", publish to the **Chrome Web Store** (one-time $5
developer account + a review), or distribute the folder for people to load unpacked.
Add real 16/48/128px icons before publishing (Chrome uses a default puzzle icon now).
