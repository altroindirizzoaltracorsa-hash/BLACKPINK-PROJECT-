// Background service worker. Receives detected votes, keeps only the ones cast for
// BLACKPINK / a member, logs them to the blinksunited.com voting board using the
// account link token, and maintains the counters + activity log the on-page panel
// (panel.js) reads from chrome.storage. Also serves the "blinks voting now" count.

const BU_ENDPOINT = 'https://blinksunited.com/api/vma-votes';

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

  if (!msg || msg.type !== 'bu-vote' || !msg.detail) return;
  const { category, slots, timestamp, account, method } = msg.detail;

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

  postVotes(n).then(function (res) {
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
