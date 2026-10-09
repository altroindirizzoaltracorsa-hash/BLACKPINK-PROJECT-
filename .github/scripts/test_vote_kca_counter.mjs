// What the Kids' Choice counter does with a real submitted round.
//
// Run: node .github/scripts/test_vote_kca_counter.mjs
//
// This is the one award whose vote payload names nobody:
//
//   POST https://kca.nick.tv/api/vote
//   {"user_id":"…","region":"us","environment":"production",
//    "votes":[{"question_id":"<uuid>","option_id":"<uuid>"}, …]}
//
// So everything depends on a map from option_id to the nominee's name, read off
// the ballot by panel.js and used by background.js. Two halves, both tested
// here:
//
//   A. background.js — decode. The fixture is the FIRST FLUSH of a real captured
//      voting session (36 categories, six flushes), with the voter's own user_id
//      replaced by zeros because it is theirs and the counter never reads it.
//      Its first entry is question 1ae0e782… / option aa2a878e…, which
//      probe-kca.yml independently read off the live ballot as "Favorite Music
//      Group or Duo" / "BLACKPINK" — so one BLACKPINK vote out of that flush is
//      a fact about the real site, not a fixture agreeing with itself.
//
//   B. panel.js — the ballot parser. The ballot is not inline and this script
//      runs in an isolated world, so it has to find a same-origin file by what
//      it contains and brace-match the object out of it. Tested against titles
//      that contain the things a regex would trip on.
//
// The cases worth having a test for at all are the ones where being wrong is
// invisible: counting a BTS vote in our category, counting a round twice,
// counting a round not at all because ROSÉ's accent did not match, and counting
// something when the ballot could not be read (which would mean inventing it).
import { readFileSync } from 'node:fs';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const root = new URL('../../', import.meta.url).pathname;
let fails = [];
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails.push(m); };

// ── the real captured flush, de-identified ──────────────────────────────────
const FLUSH_1 = {
  user_id: '00000000-0000-0000-0000-000000000000',
  region: 'us',
  environment: 'production',
  votes: [
    { question_id: '1ae0e782-6c39-4329-88ae-137533d9f497', option_id: 'aa2a878e-15d2-455f-9829-1b55fd948c81' },
    { question_id: 'c44886ef-ec4b-45ee-9ce3-c50414087676', option_id: '4bf55e38-9903-43c3-8e04-a294fef8556f' },
    { question_id: '80fc0bb3-c010-46bb-9a9d-f2e582683128', option_id: '6bd5161b-e0b9-411f-a1bb-9ae43b2d2c32' },
    { question_id: '24f5478a-1044-432a-bad9-080bfeb900a4', option_id: '0471a9cd-482b-4209-b8a0-dcafde96115d' },
    { question_id: '4c0284f6-aa12-4849-a71c-79eba8d23e29', option_id: '4fdd8a20-d0e7-4863-a2f2-7f07e88c4ff2' },
    { question_id: 'b70ba75d-a1ca-4e0d-b677-4e9008b53c38', option_id: '4d1d7cd7-6962-4de3-abc4-74e78a1ac033' },
  ],
};

// The ballot entries this test needs. The music-group ones are the real ids
// probe-kca.yml read off the live page; the ROSÉ and Dracula option ids are
// synthetic (those two categories were not dumped), which is fine because what
// is being tested there is the name matching, not the id.
const BALLOT = {
  'aa2a878e-15d2-455f-9829-1b55fd948c81': { t: 'BLACKPINK', q: '1ae0e782-6c39-4329-88ae-137533d9f497', s: 'favorite-music-group-or-duo' },
  'b156d9c1-4905-44c1-8dbb-730e2a77f3e5': { t: 'BTS',       q: '1ae0e782-6c39-4329-88ae-137533d9f497', s: 'favorite-music-group-or-duo' },
  '11111111-1111-1111-1111-111111111111': { t: 'ROSÉ',      q: '22222222-2222-2222-2222-222222222222', s: 'favorite-female-artist' },
  '33333333-3333-3333-3333-333333333333': { t: 'Dracula (with JENNIE)', q: '44444444-4444-4444-4444-444444444444', s: 'favorite-music-collaboration' },
  '55555555-5555-5555-5555-555555555555': { t: 'Fortnite',  q: '66666666-6666-6666-6666-666666666666', s: 'favorite-video-game' },
};
// The other five entries of the real flush, so the fixture is a whole round
// rather than one vote with padding.
for (const v of FLUSH_1.votes.slice(1)) {
  BALLOT[v.option_id] = { t: 'Someone Else', q: v.question_id, s: 'favorite-cartoon' };
}
const freshBallot = () => ({ ts: Date.now(), byOption: JSON.parse(JSON.stringify(BALLOT)) });

// ── a background.js with the browser stubbed out ────────────────────────────
// The module registers its webRequest listeners at load, so those are stubs; the
// pieces under test are reached through the closure the wrapper returns.
function loadBackground() {
  const src = readFileSync(root + 'vote-extension/background.js', 'utf8');
  const store = {};
  const posts = [];
  const listener = { addListener() {} };
  const chrome = {
    runtime: { id: 'test', lastError: null, onMessage: listener, getURL: (p) => p },
    tabs: { sendMessage() {} },
    webRequest: {
      onBeforeRequest: listener, onCompleted: listener,
      onSendHeaders: listener, onErrorOccurred: listener,
    },
    storage: {
      local: {
        get(keys, cb) {
          const k = typeof keys === 'string' ? [keys] : (Array.isArray(keys) ? keys : Object.keys(keys));
          const out = {};
          for (const key of k) if (key in store) out[key] = store[key];
          cb && cb(out);
        },
        set(obj, cb) { Object.assign(store, obj); cb && cb(); },
        remove(key, cb) { delete store[key]; cb && cb(); },
      },
      onChanged: listener,
    },
  };
  const fetch = async (url, opts) => {
    posts.push({ url, body: JSON.parse((opts && opts.body) || '{}') });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const api = new Function('chrome', 'fetch', 'console', src + `
    return { parseKcaBody, kcaNorm, processKcaVote, kcaBallotFresh, KCA_NOMINEES,
             KCA_SEEN_WINDOW, KCA_SEEN_KEY, KCA_BALLOT_KEY };
  `)(chrome, fetch, { log() {} });
  // The seen-list and inflight caches are module-level, so each case gets its
  // own instance rather than inheriting the previous one's dedupe state.
  return Object.assign(api, { store, posts });
}

// webRequest hands the body over as raw bytes, which is what parseKcaBody takes.
const asRequestBody = (obj) => ({ raw: [{ bytes: new TextEncoder().encode(JSON.stringify(obj)).buffer }] });

// processKcaVote posts and updates storage through callbacks, with no promise to
// await — so settle the microtask/callback queue before asserting.
const settle = () => new Promise((r) => setTimeout(r, 30));

console.log('--- A. background.js: reading the vote request');
{
  const bg = loadBackground();
  const parsed = bg.parseKcaBody(asRequestBody(FLUSH_1));
  check(!!parsed, 'a real /api/vote body parses');
  check(parsed && parsed.votes.length === 6, `all six picks in the flush are read (${parsed && parsed.votes.length})`);
  check(parsed && parsed.votes[0].o === 'aa2a878e-15d2-455f-9829-1b55fd948c81',
        'the option_id survives as given — it is the only thing that names the nominee');
  // The voter's own KCA identity must never leave the page.
  check(parsed && !JSON.stringify(parsed).includes('user_id'),
        'and user_id is NOT carried over anywhere');

  check(bg.parseKcaBody(asRequestBody({ hello: 'world' })) === null,
        'a POST that is not a vote is ignored');
  check(bg.parseKcaBody(asRequestBody({ votes: [] })) === null, 'an empty votes array is not a vote');
  check(bg.parseKcaBody(null) === null, 'and a body we were given nothing for is not a vote');
}

console.log('\n--- A. names: the accent must not cost ROSÉ her votes');
{
  const bg = loadBackground();
  check(bg.kcaNorm('ROSÉ') === bg.kcaNorm('ROSE'), 'ROSÉ and ROSE compare equal');
  check(bg.kcaNorm('Dracula (with JENNIE)') === bg.kcaNorm('dracula  with jennie'),
        'punctuation and case do not matter');
  check(bg.kcaNorm('BLACKPINK') !== bg.kcaNorm('BTS'), 'but two different nominees still differ');
  check(Object.keys(bg.KCA_NOMINEES).length === 3, 'three categories are ours');
}

console.log('\n--- A. a submitted round is decoded, and only ours is counted');
{
  const bg = loadBackground();
  bg.store.buToken = 'tok';
  bg.store.kcaBallot = freshBallot();
  await bg.processKcaVote({ votes: FLUSH_1.votes.map(v => ({ q: v.question_id, o: v.option_id })) });
  await settle();
  const p = bg.posts[0];
  check(bg.posts.length === 1, `one post to the board (${bg.posts.length})`);
  check(p && p.body.award === 'kca', 'on the kca award dimension');
  check(p && p.body.votes === 1, `one vote counted out of the six picks (${p && p.body.votes})`);
  check(p && JSON.stringify(p.body.cats) === '{"favorite-music-group-or-duo":1}',
        `attributed to the right category (${p && JSON.stringify(p.body.cats)})`);
  check(p && p.body.extToken === 'tok', 'with the link token, and nothing else identifying');
  check(p && !JSON.stringify(p.body).includes('00000000-0000'), 'the voter id is not in the payload');
  check(bg.store.kcaCount === 1, `the panel's own counter moved to 1 (${bg.store.kcaCount})`);
  check(JSON.stringify(bg.store.kcaCats) === '{"favorite-music-group-or-duo":1}',
        'and so did today\'s per-category tally');
  check(Array.isArray(bg.store.kcaLog) && bg.store.kcaLog[0].who === 'BLACKPINK',
        `the activity row names BLACKPINK (${bg.store.kcaLog && bg.store.kcaLog[0] && bg.store.kcaLog[0].who})`);
}

console.log('\n--- A. a rival in OUR category is not ours');
{
  const bg = loadBackground();
  bg.store.buToken = 'tok';
  bg.store.kcaBallot = freshBallot();
  // Favorite Music Group or Duo, voted for BTS. Same category as ours, so a
  // counter that trusted the category alone would count this.
  await bg.processKcaVote({ votes: [{ q: '1ae0e782-6c39-4329-88ae-137533d9f497', o: 'b156d9c1-4905-44c1-8dbb-730e2a77f3e5' }] });
  await settle();
  check(bg.posts.length === 0, `nothing posted (${bg.posts.length} posts)`);
  check(!bg.store.kcaCount, 'and nothing counted');
}

console.log('\n--- A. all three of ours in one round is three votes');
{
  const bg = loadBackground();
  bg.store.buToken = 'tok';
  bg.store.kcaBallot = freshBallot();
  await bg.processKcaVote({ votes: [
    { q: '1ae0e782-6c39-4329-88ae-137533d9f497', o: 'aa2a878e-15d2-455f-9829-1b55fd948c81' },
    { q: '22222222-2222-2222-2222-222222222222', o: '11111111-1111-1111-1111-111111111111' },
    { q: '44444444-4444-4444-4444-444444444444', o: '33333333-3333-3333-3333-333333333333' },
    { q: '66666666-6666-6666-6666-666666666666', o: '55555555-5555-5555-5555-555555555555' },
  ] });
  await settle();
  const p = bg.posts[0];
  check(p && p.body.votes === 3, `three votes from one round (${p && p.body.votes})`);
  check(p && p.body.cats['favorite-female-artist'] === 1, 'ROSÉ counted despite the accent');
  check(p && p.body.cats['favorite-music-collaboration'] === 1, 'Dracula counted');
  check(p && !('favorite-video-game' in p.body.cats), 'and Fortnite did not come along');
  const sum = Object.values(p ? p.body.cats : {}).reduce((a, b) => a + b, 0);
  check(sum === (p && p.body.votes), `the breakdown adds up to the total (${sum} vs ${p && p.body.votes})`);
  check(Array.isArray(bg.store.kcaLog) && bg.store.kcaLog.length === 3,
        `three activity rows, one per nominee (${bg.store.kcaLog && bg.store.kcaLog.length})`);
}

console.log('\n--- A. a retry folds, a second round does not');
{
  const bg = loadBackground();
  bg.store.buToken = 'tok';
  bg.store.kcaBallot = freshBallot();
  const round = [{ q: '1ae0e782-6c39-4329-88ae-137533d9f497', o: 'aa2a878e-15d2-455f-9829-1b55fd948c81' }];
  await bg.processKcaVote({ votes: round });
  await settle();
  await bg.processKcaVote({ votes: round });          // the same POST, retried
  await settle();
  check(bg.posts.length === 1, `the retry was not counted again (${bg.posts.length} posts)`);

  // KCA allows repeat voting, and a second round casts the very same pairs. Age
  // the dedupe entry past the window and it must count — this is the case that
  // separates "retry" from "voted again", and getting it wrong silently caps
  // every blink at one round.
  bg.store[bg.KCA_SEEN_KEY] = bg.store[bg.KCA_SEEN_KEY].map(([k]) => [k, Date.now() - bg.KCA_SEEN_WINDOW - 1000]);
  const bg2 = loadBackground();                        // reload so the in-memory copy re-reads storage
  bg2.store.buToken = 'tok';
  bg2.store.kcaBallot = freshBallot();
  bg2.store[bg2.KCA_SEEN_KEY] = bg.store[bg.KCA_SEEN_KEY];
  await bg2.processKcaVote({ votes: round });
  await settle();
  check(bg2.posts.length === 1, `a later round with identical picks counts again (${bg2.posts.length} posts)`);
}

console.log('\n--- A. no ballot means count NOTHING, and say so');
{
  const bg = loadBackground();
  bg.store.buToken = 'tok';
  // No kcaBallot at all: the ids are meaningless, so any number here would be
  // invented. The honest answer is zero plus a visible reason.
  await bg.processKcaVote({ votes: FLUSH_1.votes.map(v => ({ q: v.question_id, o: v.option_id })) });
  await settle();
  check(bg.posts.length === 0, `nothing posted (${bg.posts.length} posts)`);
  check(!bg.store.kcaCount, 'nothing counted');
  const diag = bg.store.kcaDiag || [];
  check(diag[0] && diag[0].kind === 'no-ballot',
        `and the panel is told why (${diag[0] && diag[0].kind})`);

  const stale = { ts: Date.now() - 7 * 60 * 60 * 1000, byOption: BALLOT };
  check(bg.kcaBallotFresh(stale) === false, 'a ballot older than the TTL counts as missing');
  check(bg.kcaBallotFresh({ ts: Date.now(), byOption: {} }) === false, 'and so does an empty one');
  check(bg.kcaBallotFresh(freshBallot()) === true, 'a current one is usable');
}

console.log('\n--- A. an unknown option_id is reported, not guessed at');
{
  const bg = loadBackground();
  bg.store.buToken = 'tok';
  bg.store.kcaBallot = freshBallot();
  await bg.processKcaVote({ votes: [{ q: 'x', o: '99999999-9999-9999-9999-999999999999' }] });
  await settle();
  check(bg.posts.length === 0, 'nothing posted for a pick we cannot identify');
  const diag = bg.store.kcaDiag || [];
  check(diag[0] && diag[0].kind === 'unidentified', `and it is reported (${diag[0] && diag[0].kind})`);
}

console.log('\n--- A. not linked yet: held, not lost');
{
  const bg = loadBackground();
  bg.store.kcaBallot = freshBallot();        // no buToken
  await bg.processKcaVote({ votes: [{ q: '1ae0e782-6c39-4329-88ae-137533d9f497', o: 'aa2a878e-15d2-455f-9829-1b55fd948c81' }] });
  await settle();
  check(bg.store.kcaPendingN === 1, `the vote is held (pending ${bg.store.kcaPendingN})`);
  check(!bg.store.kcaCount, 'and not shown as counted');
  const diag = bg.store.kcaDiag || [];
  check(diag[0] && diag[0].kind === 'held' && diag[0].reason === 'not-linked',
        'with "link your account" as the reason');
}

console.log('\n--- A. a round reaches us in pieces, and the backlog adds them up');
{
  // This is what a real round looks like from here: KCA flushes 5–7 picks at a
  // time around the ad breaks, and our three categories are scattered across
  // the ballot — in the captured session they landed in flushes 1, 3 and 4. So
  // three votes arrive as three separate submissions of one, and the backlog is
  // the only number that knows there are three.
  const bg = loadBackground();
  bg.store.kcaBallot = freshBallot();        // no buToken, so each one is held
  const flushes = [
    [{ q: '1ae0e782-6c39-4329-88ae-137533d9f497', o: 'aa2a878e-15d2-455f-9829-1b55fd948c81' }],
    [{ q: '22222222-2222-2222-2222-222222222222', o: '11111111-1111-1111-1111-111111111111' }],
    [{ q: '44444444-4444-4444-4444-444444444444', o: '33333333-3333-3333-3333-333333333333' }],
  ];
  for (const f of flushes) { await bg.processKcaVote({ votes: f }); await settle(); }
  check(bg.store.kcaPendingN === 3, `all three are held, not just the last (${bg.store.kcaPendingN})`);
  const diag = bg.store.kcaDiag || [];
  check(diag.length === 3 && diag.every(d => d.kind === 'held'), `one reason per flush (${diag.length})`);
  check(diag[0].n === 1, 'and each reason describes only its own flush, which is why the panel must not read it as the backlog');
}

// ── B. panel.js: finding and parsing the ballot ─────────────────────────────
console.log('\n--- B. panel.js reads the ballot off the page');
{
  // A ballot shaped like the real one, with the two things a naive parser gets
  // wrong: a brace inside a title, and an escaped quote.
  const ballotFile = 'window.jsonData = ' + JSON.stringify({
    region: { id: 'us' },
    questions: [
      { id: '1ae0e782-6c39-4329-88ae-137533d9f497', slug: 'favorite-music-group-or-duo', title: 'Favorite Music Group or Duo',
        options: [
          { id: 'b3ccd0f4-4308-4455-9fae-873f31d32d95', title: 'Jonas Brothers' },
          { id: 'aa2a878e-15d2-455f-9829-1b55fd948c81', title: 'BLACKPINK' },
          { id: 'b156d9c1-4905-44c1-8dbb-730e2a77f3e5', title: 'BTS' },
        ] },
      { id: '22222222-2222-2222-2222-222222222222', slug: 'favorite-female-artist', title: 'Favorite Female Artist',
        options: [
          { id: '11111111-1111-1111-1111-111111111111', title: 'ROSÉ' },
          { id: 'aaaaaaaa-0000-0000-0000-000000000001', title: 'Someone {else}' },
          { id: 'aaaaaaaa-0000-0000-0000-000000000002', title: 'A "quoted" name' },
        ] },
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `9000000${i}-0000-0000-0000-000000000000`, slug: `filler-${i}`, title: `Filler ${i}`,
        options: Array.from({ length: 3 }, (_, j) => ({ id: `900000${i}${j}-0000-0000-0000-00000000000${j}`, title: `Nominee ${i}-${j}` })),
      })),
    ],
  }) + ';\nwindow.somethingElse = 1;\n';

  const panelSrc = readFileSync(root + 'vote-extension/panel.js', 'utf8');
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));

  // Everything the content script touches, stubbed — including the message
  // channel, which is how the parsed map leaves the page.
  // Storage is backed by a mutable object and the change listener is kept, so a
  // case can put the panel into a given state and make it re-render — which is
  // how the held band is read below.
  await p.addInitScript(() => {
    window.__sent = [];
    window.__store = {};
    const onChanged = [];
    window.__fire = () => onChanged.forEach((f) => f({ kcaDiag: {} }, 'local'));
    window.chrome = {
      runtime: {
        id: 'test', lastError: null,
        getURL: (x) => 'stub://' + x,
        sendMessage: (msg, cb) => {
          window.__sent.push(msg);
          // The panel only fetches the ballot when the background says its copy
          // is stale, so answer that it is.
          if (msg && msg.type === 'bu-kca-ballot-stale' && cb) cb({ stale: true });
          else if (cb) cb({});
        },
        onMessage: { addListener() {} },
      },
      storage: {
        local: {
          get: (k, cb) => cb && cb(window.__store),
          set: (o, cb) => { Object.assign(window.__store, o); cb && cb(); },
        },
        onChanged: { addListener(f) { onChanged.push(f); } },
      },
    };
  });

  await p.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== 'kca.nick.tv') return route.fulfill({ status: 204, body: '' });
    if (u.pathname === '/vote/favorite-music-group-or-duo') {
      return route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><html><head>'
        // The real page loads the ballot from a UUID-named file alongside the
        // Vue bundle, which is why the parser identifies it by content.
        + '<script src="/mik-assets/vite/assets/index-abc123.js"></script>'
        + '<script src="/json/us/ba8f5014-8365-490f-8815-f37f7e00e69d.js"></script>'
        + '</head><body><div id="app"></div></body></html>' });
    }
    if (u.pathname.startsWith('/json/')) return route.fulfill({ contentType: 'application/javascript', body: ballotFile });
    if (u.pathname.startsWith('/mik-assets/')) return route.fulfill({ contentType: 'application/javascript', body: 'window.vue=1;' });
    return route.fulfill({ status: 204, body: '' });
  });

  await p.goto('https://kca.nick.tv/vote/favorite-music-group-or-duo', { waitUntil: 'domcontentloaded' });
  await p.evaluate(panelSrc);
  await p.waitForTimeout(600);

  // The held band is the only thing a blink sees while votes are queueing, so
  // it has to name the BACKLOG. Three flushes held one each reads as "3 votes
  // are held"; the last flush's own count would say 1 and never move.
  const bandText = async (store) => {
    await p.evaluate((s) => { window.__store = s; window.__fire(); }, store);
    await p.waitForTimeout(80);
    return p.evaluate(() => {
      const el = document.getElementById('bu-vote-panel-host').shadowRoot.getElementById('btdiag');
      return el.style.display === 'none' ? '' : el.textContent.replace(/\s+/g, ' ').trim();
    });
  };
  const diag3 = [{ kind: 'held', reason: 'error', n: 1, ts: Date.now() }];
  const three = await bandText({ kcaDiag: diag3, kcaPendingN: 3 });
  check(/3 votes are held/.test(three), `three held votes read as three (${three})`);
  const one = await bandText({ kcaDiag: diag3, kcaPendingN: 1 });
  check(/1 vote is held/.test(one), `and one reads as one, with the verb agreeing (${one})`);
  check((await bandText({ kcaDiag: diag3, kcaPendingN: 0 })) === '',
        'and the band goes away once the backlog has gone through');

  const sent = await p.evaluate(() => window.__sent);
  const asked = sent.find((m) => m.type === 'bu-kca-ballot-stale');
  const handed = sent.find((m) => m.type === 'bu-kca-ballot');
  check(!!asked, 'it asks the background whether the ballot is stale before fetching 325KB');
  check(!!handed, 'and hands over a map when it is');
  const by = (handed && handed.byOption) || {};
  // 3 + 3 nominees in the two real categories, plus 10 filler categories of 3.
  check(Object.keys(by).length === 36, `every option is in the map (${Object.keys(by).length})`);
  check(Object.keys(by).length >= 20, 'and enough of them that the background will accept it');
  check(by['aa2a878e-15d2-455f-9829-1b55fd948c81']
        && by['aa2a878e-15d2-455f-9829-1b55fd948c81'].t === 'BLACKPINK'
        && by['aa2a878e-15d2-455f-9829-1b55fd948c81'].s === 'favorite-music-group-or-duo',
        'BLACKPINK\'s option id maps to her name AND her category');
  check(by['11111111-1111-1111-1111-111111111111'] && by['11111111-1111-1111-1111-111111111111'].t === 'ROSÉ',
        'the accent survives the round trip');
  check(by['aaaaaaaa-0000-0000-0000-000000000001'] && by['aaaaaaaa-0000-0000-0000-000000000001'].t === 'Someone {else}',
        'a brace inside a nominee title does not end the object early');
  check(by['aaaaaaaa-0000-0000-0000-000000000002'] && by['aaaaaaaa-0000-0000-0000-000000000002'].t === 'A "quoted" name',
        'nor does an escaped quote');

  // The panel itself still has to render — it is the only feedback a blink gets.
  const panel = await p.evaluate(() => {
    const host = document.getElementById('bu-vote-panel-host');
    if (!host || !host.shadowRoot) return null;
    const r = host.shadowRoot;
    return {
      sub: r.querySelector('.sub')?.textContent || '',
      splitsHidden: r.querySelector('.splits')?.style.display === 'none',
      hasTotal: !!r.getElementById('total'),
    };
  });
  check(!!panel, 'the on-page panel mounted');
  check(panel && /Kids.{0,3} Choice Vote Counter/.test(panel.sub), `named for this award (${panel && panel.sub})`);
  check(panel && panel.splitsHidden, 'the VMA-only BLACKPINK/LISA chips are hidden');
  check(errs.length === 0, `no page errors (${errs.join(' | ') || 'none'})`);

  await b.close();
}

console.log(`\nFAILURES: ${fails.length}`);
fails.forEach((f) => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
