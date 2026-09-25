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

// ── DEDUPE RETRIED SUBMISSIONS ───────────────────────────────────────────────
// This list has to OUTLIVE the background script. Under MV3 (manifest.json)
// background.js is a service worker Chrome shuts down after ~30s idle, which
// wiped an in-memory list and let the next retry count a second time; under
// MV2/Kiwi (manifest-mv2.json) the page is "persistent": true, so it survived.
// The same retry was counted differently depending on the build. It's mirrored
// into chrome.storage now, with the in-memory copy kept as the synchronous
// race guard.
const SEEN_KEY = 'buSeenVotes';
const SEEN_MAX = 1000;
let seenVotes = null;    // null until loaded back from storage
let seenLoading = null;

function loadSeen() {
  if (seenVotes) return Promise.resolve(seenVotes);
  if (!seenLoading) {
    seenLoading = getLocal(SEEN_KEY).then(function (cfg) {
      if (!seenVotes) {
        const saved = cfg && cfg[SEEN_KEY];
        seenVotes = Array.isArray(saved) ? saved.slice(-SEEN_MAX) : [];
      }
      return seenVotes;
    });
  }
  return seenLoading;
}

// Identify a submission by WHICH one it was, not merely when. An account can submit
// once per category per voting day, so the key is the day + category + account.
// timestamp is deliberately NOT part of the key: a retried submission is re-signed
// with a fresh timestamp, so keying on timestamp let retries count a second time.
function voteKey(detail) {
  return [etDay(), detail.category || '?', detail.account || '<anon>'].join('|');
}

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
// { bp, lisa, total, accounts } (VMA) or { total, accounts } (BreakTudo) or null.
async function fetchSync(award) {
  const { buToken } = await getLocal('buToken');
  if (!buToken) return null;
  try {
    const q = award === 'breaktudo' ? '?sync=1&award=breaktudo' : '?sync=1';
    const r = await fetch(BU_ENDPOINT + q, { headers: { 'X-Ext-Token': buToken }, cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

// Fetch the community "voting now" pulse for the panel.
async function fetchLive(award) {
  try {
    const q = award === 'breaktudo' ? '?live=1&award=breaktudo' : '?live=1';
    const r = await fetch(BU_ENDPOINT + q, { cache: 'no-store' });
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
  // Panel asks for the live "voting now" number. (award: 'vma' | 'breaktudo')
  if (msg && msg.type === 'bu-live') {
    fetchLive(msg.award).then((liveVoters) => sendResponse({ liveVoters }));
    return true; // async response
  }

  // Panel asks for the cross-device merged view (opt-in sync).
  if (msg && msg.type === 'bu-sync-pull') {
    fetchSync(msg.award).then((data) => sendResponse({ data }));
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
    if (detail) {
      processVote(detail).catch(function (e) {
        console.log('[BU Vote Counter] processVote failed:', e);
      });
    }
  },
  { urls: ['https://vote.mtv.com/*'] } // broad match; parseVoteUrl() filters to the vote path
);

async function processVote(detail) {
  const { category, slots, timestamp, account, method } = detail;

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

  // Dedupe AFTER the slot maths, so the window holds only submissions we
  // actually count — un-mapped categories and votes where no BLACKPINK slot
  // scored used to evict real entries out of the window we keep.
  const seen = await loadSeen();
  const key = voteKey(detail);
  // Check and insert with no await in between: two retries arriving in the
  // same tick would both pass an interleaved check.
  if (seen.indexOf(key) !== -1) return;
  seen.push(key);
  if (seen.length > SEEN_MAX) seen.splice(0, seen.length - SEEN_MAX);
  chrome.storage.local.set({ [SEEN_KEY]: seen });

  // ALWAYS send the anonymous BLACKPINK/LISA split so the board's per-artist
  // columns fill for every extension voter (it's just two counts, same as the
  // website form). The account email/method — used only for the opt-in
  // cross-device view — stays gated behind the sync toggle.
  chrome.storage.local.get(['buSyncOn'], function (cfg) {
    const extra = { breakdown: perMember };
    if (cfg.buSyncOn) {
      extra.sync = true;
      extra.account = account ? { id: account, method: method || 'email', cat: category } : undefined;
    }

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
          upd.buLog = log.slice(0, 500); // keep the full day's chronology (resets at ET midnight)
          // Flush any previously-pending votes now that we're linked/online.
          if (r.buPending) { postVotes(r.buPending); upd.buPending = 0; }
        } else {
          // Not linked yet or offline — remember so the panel/popup can nudge, retry later.
          upd.buPending = (r.buPending || 0) + n;
        }
        // Track which account cast this vote — the user's OWN roster of emails/logins
        // used today, so they know which they have already used. Stored locally.
        // NOTE: this roster is uploaded ONLY when the user turns the "share voting
        // accounts" toggle on — see the buSyncOn branch above, which adds
        // extra.account to the POST. With the toggle off (the default) the body
        // carries only extToken, the vote count and the BLACKPINK/LISA split.
        if (account) {
          const accts = Array.isArray(r.buAccounts) ? r.buAccounts.slice() : [];
          const i = accts.findIndex((a) => a.id === account);
          if (i >= 0) {
            accts[i].votes += n; accts[i].lastTs = Date.now();
            // Track which of the 2 fan-voted categories this account has covered (→ x/2).
            const cats = Array.isArray(accts[i].cats) ? accts[i].cats.slice() : [];
            if (cats.indexOf(category) === -1) cats.push(category);
            accts[i].cats = cats;
          } else {
            accts.push({ id: account, method: method || 'email', votes: n, lastTs: Date.now(), cats: [category] });
          }
          upd.buAccounts = accts;
        }
        chrome.storage.local.set(upd);
      }
    );
  });
  });
}

// ── BreakTudo Awards ─────────────────────────────────────────────────────────
// BreakTudo's vote request is a POST whose candidate ids live in the *body*
// (action=update_vote&votes=[{"id":"<base64>","pos":N}]&valid=<turnstile>), not
// the URL like MTV. So we read the body with onBeforeRequest+['requestBody'],
// grab the referer (→ category slug) in onSendHeaders, and only count it once
// onCompleted confirms a 2xx. Each entry in the votes array is one vote (there's
// no daily cap on BreakTudo — repeat batches all count). Kept fully separate
// from VMA: its own storage keys and its own award dimension on the board.
const BT_VOTE_RE = /\/wp-json\/bta\/v1\/awards\/vote\/?$/i;

// Brasília day (America/Sao_Paulo, UTC-3, no DST) — matches the server boundary.
function brDay() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Known BLACKPINK/member candidate ids (base64, as sent in votes[].id) → member.
// Add more as you confirm them; the console logs each unmapped id (decoded) so
// it's a copy-paste to fill in. Attribution falls back to the category slug and
// then a generic label, so a vote still COUNTS even before its id is here.
//   NjAwNkJUVzI1MTk2MjU4 → 6006BTW25196258 = BLACKPINK · Int. Female Group
const BT_CANDIDATES = {
  NjAwNkJUVzI1MTk2MjU4: 'BLACKPINK',
};
// The ONLY categories we count — the /vote/<slug>/ pages BLACKPINK/members/BLINKs
// are nominated in → { who, label }. A vote counts only if it's cast on one of
// these pages (or its candidate id is a known BP id in BT_CANDIDATES); votes in any
// other category (e.g. a Brazilian/other-artist category) are ignored. Slugs are
// BreakTudo's Portuguese category titles, kebab-cased with accents stripped —
// verified against the site's 2026 category names.
const BT_CATS = {
  'grupo-feminino-internacional':      { who: 'BLACKPINK', label: 'Int. Female Group' },   // Grupo Feminino Internacional — BLACKPINK
  'artista-feminina-internacional':    { who: 'JENNIE',    label: 'Int. Female Artist' },  // Artista Feminina Internacional — JENNIE
  'artista-asiatico':                  { who: 'LISA',      label: 'Asian Artist' },        // Artista Asiático — LISA
  'colaboracao-internacional-do-ano':  { who: 'JISOO',     label: 'Int. Collaboration' },  // Colaboração Internacional do Ano — JISOO × ZAYN
  'hit-internacional-do-ano':          { who: 'JENNIE',    label: 'Int. Hit of the Year' },// Hit Internacional do Ano — Dracula (w/ JENNIE)
  'videoclipe-internacional-do-ano':   { who: 'BLACKPINK', label: 'Int. Music Video' },    // Videoclipe Internacional do Ano — GO / DREAM
  'fandom-internacional-do-ano':       { who: 'BLINKs',    label: 'Int. Fandom' },         // Fandom Internacional do Ano — BLINKs
  'serie-internacional':               { who: 'BLACKPINK', label: 'Int. Series' },         // Série Internacional — Boyfriend On Demand
  // tolerated aliases in case a slug ships slightly differently:
  'videoclipe-internacional':          { who: 'BLACKPINK', label: 'Int. Music Video' },
  'serie-internacional-do-ano':        { who: 'BLACKPINK', label: 'Int. Series' },
};

function btB64(s) { try { return atob(s); } catch (_) { return s; } }
function btSlug(ref) {
  try { const m = new URL(ref).pathname.match(/\/vote\/([^/]+)\/?/i); return m ? m[1].toLowerCase() : null; }
  catch (_) { return null; }
}

// Dedupe retried submissions (mirrors the VMA SEEN list; own storage key).
const BT_SEEN_KEY = 'btSeenVotes';
let btSeenVotes = null, btSeenLoading = null;
function loadBtSeen() {
  if (btSeenVotes) return Promise.resolve(btSeenVotes);
  if (!btSeenLoading) {
    btSeenLoading = getLocal(BT_SEEN_KEY).then((cfg) => {
      if (!btSeenVotes) { const s = cfg && cfg[BT_SEEN_KEY]; btSeenVotes = Array.isArray(s) ? s.slice(-SEEN_MAX) : []; }
      return btSeenVotes;
    });
  }
  return btSeenLoading;
}

// `category` is the /vote/<slug>/ the votes were cast on. One POST is one
// category page, so a single slug covers the batch. Omitted when the referer did
// not yield one — the vote still counts, it is just unattributed.
async function postBtVotes(n, category) {
  const { buToken } = await getLocal('buToken');
  if (!buToken || n <= 0) return { ok: false, reason: 'not-linked' };
  try {
    const body = { award: 'breaktudo', extToken: buToken, votes: n };
    if (category) body.category = category;
    const r = await fetch(BU_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ok: r.ok };
  } catch (_) { return { ok: false, reason: 'network' }; }
}

// requestId → { votes, valid, slug, ts }. The body arrives in onBeforeRequest,
// the referer in onSendHeaders, the status in onCompleted — stitched by id.
const btInflight = new Map();
function btPrune() { const now = Date.now(); for (const [k, v] of btInflight) if (now - v.ts > 60000) btInflight.delete(k); }

function parseBtBody(requestBody) {
  if (!requestBody) return null;
  let action = null, votesRaw = null, valid = null;
  let text = null;
  if (requestBody.raw && requestBody.raw[0] && requestBody.raw[0].bytes) {
    try { text = new TextDecoder('utf-8').decode(requestBody.raw[0].bytes); } catch (_) {}
  }
  if (requestBody.formData) {
    const fd = requestBody.formData;
    action = fd.action && fd.action[0];
    votesRaw = fd.votes && fd.votes[0];
    valid = fd.valid && fd.valid[0];
  } else if (text != null) {
    // form-urlencoded first (action=update_vote&votes=[...]&valid=<turnstile>)
    try {
      const p = new URLSearchParams(text);
      action = p.get('action'); votesRaw = p.get('votes'); valid = p.get('valid');
    } catch (_) {}
    // JSON fallback: {"action":"update_vote","votes":[{...}],"valid":"..."}
    // BreakTudo has shipped both encodings; without this a JSON body parses to
    // nothing and the vote is silently uncounted.
    if (votesRaw == null) {
      try {
        const j = JSON.parse(text);
        if (j && typeof j === 'object' && typeof j.votes !== 'undefined') {
          if (j.action != null) action = String(j.action);
          votesRaw = Array.isArray(j.votes) ? JSON.stringify(j.votes) : String(j.votes);
          if (j.valid != null) valid = String(j.valid);
        }
      } catch (_) {}
    }
  }
  if (action && action !== 'update_vote') return null;
  let votes = null;
  try { votes = JSON.parse(votesRaw); } catch (_) { votes = null; }
  if (!Array.isArray(votes) || !votes.length) return null;
  return { votes, valid: valid || null };
}

function btPathIsVote(url) { try { return BT_VOTE_RE.test(new URL(url).pathname); } catch (_) { return false; } }

chrome.webRequest.onBeforeRequest.addListener(
  function (details) {
    if (details.method !== 'POST' || !btPathIsVote(details.url)) return;
    const parsed = parseBtBody(details.requestBody);
    if (parsed) {
      btPrune(); btInflight.set(details.requestId, Object.assign({ slug: null, ts: Date.now() }, parsed));
    } else {
      // A vote POST we could not read is a vote we will not count, and it is
      // otherwise invisible. Log the body so the encoding can be fixed.
      let ex = '';
      try {
        if (details.requestBody && details.requestBody.raw && details.requestBody.raw[0] && details.requestBody.raw[0].bytes)
          ex = new TextDecoder('utf-8').decode(details.requestBody.raw[0].bytes).slice(0, 300);
      } catch (_) {}
      console.log('[BU BreakTudo] vote POST NOT MATCHED: ' + details.url + ' body="' + ex + '"');
    }
  },
  { urls: ['https://vote.breaktudoawards.com/*'], types: ['xmlhttprequest'] },
  ['requestBody']
);

chrome.webRequest.onSendHeaders.addListener(
  function (details) {
    const e = btInflight.get(details.requestId);
    if (!e) return;
    const ref = (details.requestHeaders || []).find((h) => h.name.toLowerCase() === 'referer');
    if (ref && ref.value) e.slug = btSlug(ref.value);
  },
  { urls: ['https://vote.breaktudoawards.com/*'], types: ['xmlhttprequest'] },
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onCompleted.addListener(
  function (details) {
    const e = btInflight.get(details.requestId);
    if (!e) return;
    btInflight.delete(details.requestId);
    if (details.statusCode < 200 || details.statusCode >= 300) return;
    processBtVote(e).catch((err) => console.log('[BU BreakTudo] processBtVote failed:', err));
  },
  { urls: ['https://vote.breaktudoawards.com/*'], types: ['xmlhttprequest'] }
);

chrome.webRequest.onErrorOccurred.addListener(
  function (details) { btInflight.delete(details.requestId); },
  { urls: ['https://vote.breaktudoawards.com/*'], types: ['xmlhttprequest'] }
);

async function processBtVote(e) {
  const votes = Array.isArray(e.votes) ? e.votes : [];
  if (!votes.length) return;

  // Dedupe *retries*, not distinct marks. BreakTudo's rules are 5 votes = 5 votes
  // (mark 5, clear the Cloudflare check, submit; no total cap), and several of those
  // marks can ride the SAME Turnstile token — so keying on the token alone would
  // wrongly collapse them and undercount. Key on the token PLUS the exact marks
  // (id+pos) in this POST: a true retry (identical token + identical marks) folds,
  // but genuinely different marks always count.
  const seen = await loadBtSeen();
  const sig = votes.map((v) => (v && v.id) + ':' + (v && v.pos)).join(',');
  const key = (e.valid ? 't:' + String(e.valid).slice(0, 48) : brDay() + '|' + (e.slug || '?')) + '|' + sig;
  if (seen.indexOf(key) !== -1) return;
  seen.push(key);
  if (seen.length > SEEN_MAX) seen.splice(0, seen.length - SEEN_MAX);
  chrome.storage.local.set({ [BT_SEEN_KEY]: seen });

  // Count ONLY BLACKPINK/member/BLINKs votes. A vote is ours iff its candidate id
  // is a known BP id (BT_CANDIDATES) OR it's cast on one of our nominated category
  // pages (BT_CATS, keyed by the /vote/<slug>/ referer). Any other vote — a different
  // artist, a Brazilian/other category — is skipped. BreakTudo stacks a sequence's
  // votes onto the candidate as a COUNT in `pos` (votes=[{id:BP,pos:5}] = 5 votes),
  // so we sum `pos`, not array length (missing/invalid → 1).
  const catInfo = e.slug ? BT_CATS[e.slug] : null;
  let n = 0; const perMember = {};
  for (const v of votes) {
    if (!v || v.id == null) continue;
    const known = BT_CANDIDATES[v.id];
    if (!known && !catInfo) {
      // Not a BLACKPINK/member/BLINKs vote — ignore it.
      console.log('[BU BreakTudo] skipped a non-BLACKPINK vote:',
        'slug=' + (e.slug || '?'), 'id=' + v.id + ' (' + btB64(v.id) + ')', 'pos=' + (v.pos != null ? v.pos : '?'),
        '\n→ if this WAS a BLACKPINK/member/BLINKs vote, its category slug isn\'t in BT_CATS yet — send me this slug.');
      continue;
    }
    let c = parseInt(v.pos, 10);
    if (!Number.isFinite(c) || c <= 0) c = 1;
    c = Math.min(c, 50); // per-candidate sanity bound (a sequence is 5)
    n += c;
    const who = known || (catInfo && catInfo.who) || 'BLACKPINK/member';
    perMember[who] = (perMember[who] || 0) + c;
  }
  if (n <= 0) return;   // nothing of ours in this batch
  n = Math.min(n, 500); // batch sanity bound

  const catLabel = (catInfo && catInfo.label) || 'BreakTudo';
  postBtVotes(n, e.slug).then((res) => {
    const today = brDay();
    chrome.storage.local.get(['btCount', 'btLog', 'btPendingN', 'btDay', 'btCats'], (raw) => {
      const r = (raw.btDay === today)
        ? raw
        : { btDay: today, btCount: 0, btLog: [], btCats: {}, btPendingN: raw.btPendingN || 0 };
      const upd = { btDay: today };
      if (res.ok) {
        upd.btCount = (r.btCount || 0) + n;
        // Today's per-category tally for the panel. Keyed by slug so it matches
        // what the server stores; the label is looked up for display.
        const cats = Object.assign({}, r.btCats || {});
        const ck = e.slug || '_other';
        cats[ck] = (Number(cats[ck]) || 0) + n;
        upd.btCats = cats;
        const log = Array.isArray(r.btLog) ? r.btLog.slice() : [];
        const now = Date.now();
        // One log row per member in this batch (reversed so the first-listed sits on top).
        Object.keys(perMember).reverse().forEach((who) => {
          log.unshift({ n: perMember[who], cat: catLabel, who, ts: now });
        });
        upd.btLog = log.slice(0, 500);
        // Flushed backlog carries no slug: it was accumulated across whatever
        // categories were voted while offline and that detail was not kept.
        if (r.btPendingN) { postBtVotes(r.btPendingN); upd.btPendingN = 0; }
      } else {
        upd.btPendingN = (r.btPendingN || 0) + n;
      }
      chrome.storage.local.set(upd);
    });
  });
}
