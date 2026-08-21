// Background service worker. Receives detected votes, keeps only the ones cast for
// BLACKPINK / a member, and logs them to the blinksunited.com voting board using the
// account link token (minted by /extension-link.html → /api/extension-link).

const BU_ENDPOINT = 'https://blinksunited.com/api/vma-votes';

// ── WHICH VOTES COUNT ────────────────────────────────────────────────────────
// Map each VMA category (the `category=` value in the vote request) to the nominee
// slot(s) that are BLACKPINK / a member. NOTE: the slot key is NOT fixed — it varies
// per category (Best Pop uses C1, Best K-pop uses A1, …), so each entry lists the exact
// slot letter+number for THAT category. A category may have more than one of our
// nominees (e.g. Best K-pop has both BLACKPINK and LISA) — list every slot we count.
// Add entries as you confirm them: cast one vote for BLACKPINK/a member, look at the
// request, and note its `category` and which slot (A1, C1, …) got the votes. Un-mapped
// categories are logged to the service-worker console (chrome://extensions → “service
// worker”) so you can discover them.
//   cat06 (Best Pop)   → C1 = LISA
//   cat11 (Best K-pop) → A1 = LISA or BLACKPINK (confirmed slot; add the 2nd nominee's
//                        slot once captured — both should count)
const BP_SLOTS = {
  cat06: ['C1'],
  cat11: ['A1'],
};

const seenTimestamps = []; // dedupe retried submissions

async function postVotes(n) {
  const { buToken } = await chrome.storage.local.get('buToken');
  if (!buToken || n <= 0) return { ok: false, reason: 'not-linked' };
  try {
    const r = await fetch(BU_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extToken: buToken, votes: n }),
    });
    return { ok: r.ok };
  } catch (_) {
    return { ok: false, reason: 'network' };
  }
}

chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg || msg.type !== 'bu-vote' || !msg.detail) return;
  const { category, slots, timestamp } = msg.detail;

  // Dedupe identical retried submissions.
  if (timestamp) {
    if (seenTimestamps.indexOf(timestamp) !== -1) return;
    seenTimestamps.push(timestamp);
    if (seenTimestamps.length > 60) seenTimestamps.shift();
  }

  const ourSlots = BP_SLOTS[category];
  if (!ourSlots) {
    console.log('[BU Vote Counter] vote in un-mapped category:', category, 'slots:', slots,
      '\n→ if this was a BLACKPINK/member vote, add it to BP_SLOTS in background.js');
    return;
  }

  let n = 0;
  for (const s of ourSlots) n += (slots[s] || 0);
  if (n <= 0) return;

  postVotes(n).then(function (res) {
    chrome.storage.local.get(['buCount', 'buPending'], function (r) {
      const upd = {};
      if (res.ok) {
        upd.buCount = (r.buCount || 0) + n;
        // Flush any previously-pending votes now that we're linked/online.
        if (r.buPending) { postVotes(r.buPending); upd.buPending = 0; }
      } else {
        // Not linked yet or offline — remember so the popup can nudge, and retry later.
        upd.buPending = (r.buPending || 0) + n;
      }
      chrome.storage.local.set(upd);
    });
  });
});
