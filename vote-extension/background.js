// Background service worker. Receives detected votes, keeps only the ones cast for
// BLACKPINK / a member, logs them to the blinksunited.com voting board using the
// account link token, and maintains the counters + activity log the on-page panel
// (panel.js) reads from chrome.storage. Also serves the "blinks voting now" count.

const BU_ENDPOINT = 'https://blinksunited.com/api/vma-votes';

// Promisified storage.get — MV2 / older Chromium (Kiwi) doesn't support the
// promise-returning form of chrome.storage.local.get, only the callback form.
function getLocal(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

// ── WHICH VOTES COUNT ────────────────────────────────────────────────────────
// Each VMA category (the `category=` value in the vote request) maps its nominee
// slot(s) → the member they belong to. The slot key is NOT fixed — it varies per
// category and per nominee (Best Pop LISA is C1; Best K-pop is A1 for BLACKPINK and
// F1 for LISA), and one submission can split across slots
// ({"cat11":{"total":10,"A1":9,"F1":1}}). Add entries as you confirm them; un-mapped
// categories are logged to the service-worker console.
//   cat06 (Best Pop)   → C1 = LISA
//   cat11 (Best K-pop) → A1 = BLACKPINK, F1 = LISA
// These are the only two fan-voted categories BLACKPINK/members are in.
const BP_SLOTS = {
  cat06: { C1: 'LISA' },
  cat11: { A1: 'BLACKPINK', F1: 'LISA' },
};
const CATEGORY_NAMES = { cat06: 'Best Pop', cat11: 'Best K-Pop' };

const seenTimestamps = []; // dedupe retried submissions

// MTV's voting day resets at midnight ET — align the panel's "today" counters to it.
function etDay() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function postVotes(n, extra) {
  const { buToken } = await getLocal('buToken');
  if (!buToken || n <= 0) return { ok: false, reason: 'not-linked' };
  try {
    const r = await fetch(BU_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ extToken: buToken, votes: n }, extra || {})),
    });
    return { ok: r.ok };
  } catch (_) {
    return { ok: false, reason: 'network' };
  }
}

// Pull this account's cross-device merged view (opt-in sync). Returns
// { bp, lisa, total, accounts } or null.
async function fetchSync() {
  const { buToken } = await getLocal('buToken');
  if (!buToken) return null;
  try {
    const r = await fetch(BU_ENDPOINT + '?sync=1', { headers: { 'X-Ext-Token': buToken }, cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

// Fetch the community "voting now" pulse for the panel.
async function fetchLive() {
  try {
    const r = await fetch(BU_ENDPOINT + '?live=1', { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j.liveVoters === 'number' ? j.liveVoters : null;
  } catch (_) { return null; }
}

// Reset the day's counters/log when the ET date rolls over, so the panel's
// "counted today" tracks the same boundary as the /voting board.
function rolledOver(store, today) {
  if (store.buDay === today) return store;
  return { buDay: today, buCount: 0, bpCount: 0, lisaCount: 0, buLog: [], buAccounts: [],
           buPending: store.buPending || 0, buToken: store.buToken, buProfile: store.buProfile };
}

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  // Panel asks for the live "voting now" number.
  if (msg && msg.type === 'bu-live') {
    fetchLive().then((liveVoters) => sendResponse({ liveVoters }));
    return true; // async response
  }

  // Panel asks for the cross-device merged view (opt-in sync).
  if (msg && msg.type === 'bu-sync-pull') {
    fetchSync().then((data) => sendResponse({ data }));
    return true; // async response
  }
});

// Query params on the vote request that are never nominee slots.
const RESERVED = new Set(['apikey', 'timestamp', 'action_type', 'user_id', 'method', 'category', 'total']);

// Read a vote submission straight off its URL — everything we need (category, the
// nominee slots, total, timestamp, and the voting account) is in the query string:
//   .../api/prod/vote/s2/vote?...&category=cat11&total=10&A1=9&F1=1&user_id=…&method=…
// We watch this with chrome.webRequest instead of hooking page-world fetch/XHR, so
// there's no `world:"MAIN"` content script — which keeps it working on older
// Chromium (e.g. Kiwi) as well as current Chrome.
function parseVoteUrl(url) {
  try {
    const u = new URL(url);
    if (!/\/api\/prod\/vote\/s2\/vote/i.test(u.pathname)) return null;
    const p = u.searchParams;
    if ((p.get('action_type') || '') !== 'vote') return null;
    const slots = {};
    for (const [k, v] of p.entries()) {
      if (!RESERVED.has(k.toLowerCase()) && /^[A-Z]\d+$/i.test(k)) slots[k.toUpperCase()] = parseInt(v, 10) || 0;
    }
    return {
      category: p.get('category') || null,
      slots,
      total: parseInt(p.get('total'), 10) || 0,
      timestamp: p.get('timestamp') || null,
      account: p.get('user_id') || null,
      method: p.get('method') || null,
    };
  } catch (_) { return null; }
}

chrome.webRequest.onCompleted.addListener(
  function (details) {
    if (details.statusCode < 200 || details.statusCode >= 300) return;
    const detail = parseVoteUrl(details.url);
    if (detail) processVote(detail);
  },
  { urls: ['https://vote.mtv.com/*'] } // broad match; parseVoteUrl() filters to the vote path
);

function processVote(detail) {
  const { category, slots, timestamp, account, method } = detail;

  // Dedupe identical retried submissions.
  if (timestamp) {
    if (seenTimestamps.indexOf(timestamp) !== -1) return;
    seenTimestamps.push(timestamp);
    if (seenTimestamps.length > 60) seenTimestamps.shift();
  }

  const map = BP_SLOTS[category];
  if (!map) {
    console.log('[BU Vote Counter] vote in un-mapped category:', category, 'slots:', slots,
      '\n→ if this was a BLACKPINK/member vote, add it to BP_SLOTS in background.js');
    return;
  }

  // Sum our slots, split by member.
  let n = 0; const perMember = {};
  for (const slot in map) {
    const c = slots[slot] || 0;
    if (c > 0) { n += c; const who = map[slot]; perMember[who] = (perMember[who] || 0) + c; }
  }
  if (n <= 0) return;

  // When cross-device sync is on, also send the per-member split + the voting
  // account so the server can merge this device's activity into the account view.
  chrome.storage.local.get(['buSyncOn'], function (cfg) {
    const extra = cfg.buSyncOn ? {
      sync: true,
      breakdown: perMember,
      account: account ? { id: account, method: method || 'email' } : undefined,
    } : undefined;

  postVotes(n, extra).then(function (res) {
    const today = etDay();
    chrome.storage.local.get(
      ['buCount', 'bpCount', 'lisaCount', 'buLog', 'buAccounts', 'buPending', 'buDay', 'buToken', 'buProfile'],
      function (raw) {
        const r = rolledOver(raw, today);
        const cat = CATEGORY_NAMES[category] || category;
        const upd = { buDay: today };
        if (res.ok) {
          upd.buCount = (r.buCount || 0) + n;
          upd.bpCount = (r.bpCount || 0) + (perMember.BLACKPINK || 0);
          upd.lisaCount = (r.lisaCount || 0) + (perMember.LISA || 0);
          // Newest-first activity log, ONE entry per member so a split submission shows
          // its real breakdown (e.g. 9 BLACKPINK + 1 LISA → two rows). Keep the last 20.
          const log = Array.isArray(r.buLog) ? r.buLog.slice() : [];
          const now = Date.now();
          // unshift LISA first, then BLACKPINK, so BLACKPINK sits on top of the pair.
          ['LISA', 'BLACKPINK'].forEach((who) => {
            if (perMember[who]) log.unshift({ n: perMember[who], cat, who, ts: now });
          });
          upd.buLog = log.slice(0, 20);
          // Flush any previously-pending votes now that we're linked/online.
          if (r.buPending) { postVotes(r.buPending); upd.buPending = 0; }
        } else {
          // Not linked yet or offline — remember so the panel/popup can nudge, retry later.
          upd.buPending = (r.buPending || 0) + n;
        }
        // Track which account cast this vote — the user's OWN roster of emails/logins
        // used today, so they know which to rotate. Stored locally only, never sent
        // to our server (the POST body carries only extToken + a vote count).
        if (account) {
          const accts = Array.isArray(r.buAccounts) ? r.buAccounts.slice() : [];
          const i = accts.findIndex((a) => a.id === account);
          if (i >= 0) { accts[i].votes += n; accts[i].lastTs = Date.now(); }
          else accts.push({ id: account, method: method || 'email', votes: n, lastTs: Date.now() });
          upd.buAccounts = accts;
        }
        chrome.storage.local.set(upd);
      }
    );
  });
  });
}
