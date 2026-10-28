// MAMA's X vote — one per X account per day, and the ways that could quietly
// stop being true.
//
// Run: node .github/scripts/test_mama_votes.mjs
//
// This endpoint is unlike the other three awards on the site. They count
// self-reported votes and more is better; Mnet counts ONE PER X ACCOUNT PER
// DAY, so the number here is distinct accounts and nothing is gained by
// casting twice. What that makes worth pinning:
//
//   * THE X ACCOUNT MUST COME FROM THE TOKEN. If the browser could name the
//     account, it could name a different one each time and the primary key
//     would protect nothing — the whole reason this is better than an honour
//     system is that the identity is not self-asserted.
//   * A SECOND VOTE IS NOT AN ERROR. The key refuses it, and the honest reply
//     is "already counted today", not a 500 and not a silent success that
//     implies a second vote was recorded.
//   * OUTSIDE A ROUND, NOTHING COUNTS. MAMA runs two rounds with a gap. A vote
//     logged in the gap is a number that means nothing, and the page is not
//     the only thing that can call this.
//   * NO X ACCOUNT IS NOT A FAULT. Most accounts here signed in with Google.
//     That path has to offer the link, not report an error.
//
// Supabase is stubbed and the clock is injected, so this needs no database, no
// network and no waiting until November.
import { readFileSync, existsSync } from 'node:fs';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const root = new URL('../../', import.meta.url).pathname;
let fails = [];
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails.push(m); };

// The handler, with its one import stripped and its clock replaceable.
// node_modules is not installed in this repo, so a test that needed the real
// client would simply never be run.
function loadHandler() {
  const src = readFileSync(root + 'api/mama-votes.js', 'utf8');
  const stripped = src
    .replace(/^import \{ createClient \} from '@supabase\/supabase-js';$/m, '// import stubbed by the test')
    .replace(/^import \{ Redis \} from '@upstash\/redis';$/m, '// import stubbed by the test')
    .replace(/^export default async function handler/m, 'async function handler')
    .replace(/^export const __test = .*$/m, '');
  // Every import has to be accounted for, not just the ones this test knew
  // about when it was written: adding one to the handler used to make the whole
  // file die with "Cannot use import statement outside a module" partway
  // through a run, which reads like a broken test rather than a stale loader.
  const leftover = (stripped.match(/^import .*$/gm) || []);
  if (leftover.length) {
    throw new Error('the handler imports something this test does not stub: ' + leftover.join(' / '));
  }
  if (stripped === src) throw new Error('the handler no longer looks the way this test rewrites it');
  return (now) => {
    // A Date that still parses and formats normally, but whose "now" is ours.
    class FakeDate extends Date {
      constructor(...a) { super(...(a.length ? a : [now])); }
      static now() { return now; }
    }
    FakeDate.parse = Date.parse;
    FakeDate.UTC = Date.UTC;
    // Redis is stubbed as absent: these tests are about the vote table and the
    // windows, and `redis()` returning null is the path the handler already has
    // to survive, because Upstash being down must not take the page with it.
    const FakeRedis = { fromEnv: () => { throw new Error('no redis in tests'); } };
    return new Function('createClient', 'Redis', 'process', 'Date',
      stripped + '\nreturn { handler, kstDay, roundAt, windowState, MAMA_ROUNDS, sanitizeEmbed };')(
      () => fakeSb, FakeRedis, { env: { SUPABASE_URL: 'u', SUPABASE_SERVICE_KEY: 'k', ADMIN_SECRET: 'admin-secret' } }, FakeDate);
  };
}
const build = loadHandler();

// ── the post's markup, before it is stored ─────────────────────────────────
// This is the one string in the system that comes from a third party and ends
// up in a page via innerHTML. It arrives from publish.twitter.com, for a URL
// the pin endpoint has already checked is one of ours, so the realistic threat
// is small — but "small" is not a reason to put unfiltered remote HTML into
// every visitor's DOM, and the filter is only worth having if it is exercised.
{
  console.log('\n--- the embed markup is cut down before it is stored');
  const { sanitizeEmbed } = build(Date.parse('2026-10-18T12:00:00Z'));
  const real = '<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">'
    + 'I vote #BLACKPINK #2026MAMAVOTE</p>&mdash; Blinks United (@blinksunitedtwt) '
    + '<a href="https://twitter.com/blinksunitedtwt/status/1234567890123456789">October 18, 2026</a></blockquote>';
  const kept = sanitizeEmbed(real);
  check(/I vote #BLACKPINK #2026MAMAVOTE/.test(kept) && /<blockquote/.test(kept),
        'a normal post keeps its text and its blockquote');
  check(/href="https:\/\/twitter\.com\/blinksunitedtwt\/status\/1234567890123456789"/.test(kept),
        'and the link back to the post survives');

  for (const [name, bad, gone] of [
    ['a script tag', real + '<script>fetch("//evil")</script>', /<script/i],
    ['an inline handler', '<blockquote onclick="steal()">hi</blockquote>', /onclick/i],
    ['a single-quoted handler', "<blockquote onload='x()'>hi</blockquote>", /onload/i],
    ['an unquoted handler', '<blockquote onmouseover=x()>hi</blockquote>', /onmouseover/i],
    ['an iframe', real + '<iframe src="//evil"></iframe>', /<iframe/i],
    ['a javascript: href', '<blockquote><a href="javascript:x()">t</a></blockquote>', /javascript:/i],
    ['a style block', real + '<style>body{display:none}</style>', /<style/i],
  ]) {
    check(!gone.test(sanitizeEmbed(bad)), `${name} is stripped`);
  }
  // The shape gate in fetchEmbed is the other half: anything that is not a
  // blockquote is not stored at all, whatever the sanitizer left behind.
  check(!/^<blockquote/i.test(sanitizeEmbed('<div>not a post</div>')),
        'and markup that is not a blockquote fails the shape gate');
}

// ── the stand-in database ───────────────────────────────────────────────────
let rows = [];          // mama_x_votes
let identities = [];    // what getUserById returns
let tokenUser = null;   // what getUser(token) returns
let inserted = [];      // every insert the handler attempted
let fakeSb;

function resetDb() {
  rows = []; inserted = [];
  fakeSb = {
    auth: {
      getUser: async (tok) => tok === 'good' ? { data: { user: tokenUser } } : { data: {}, error: new Error('bad token') },
      admin: { getUserById: async (id) => ({ data: { user: { id, identities } } }) },
    },
    from: () => ({
      insert: async (row) => {
        inserted.push(row);
        if (rows.some(r => r.x_user_id === row.x_user_id && r.day === row.day)) {
          return { error: { code: '23505', message: 'duplicate key' } };   // the PK doing its job
        }
        rows.push(row); return { error: null };
      },
      select: (_c, opts) => {
        const q = { _f: {} };
        q.eq = (k, v) => { q._f[k] = v; return q; };
        q.maybeSingle = async () => ({ data: rows.find(r => Object.entries(q._f).every(([k, v]) => r[k] === v)) || null });
        if (opts && opts.head) {
          // count mode: thenable so `await` resolves it
          q.then = (fn) => fn({ count: rows.filter(r => Object.entries(q._f).every(([k, v]) => r[k] === v)).length });
        }
        return q;
      },
    }),
    rpc: async (name, args) => {
      if (name === 'mama_vote_totals') {
        return { data: { day: args.p_day, today: rows.filter(r => r.day === args.p_day).length,
                         accounts: new Set(rows.map(r => r.x_user_id)).size, votes: rows.length, days: [] } };
      }
      if (name === 'mama_vote_board') return { data: [] };
      return { data: null };
    },
  };
}

const res = () => {
  const r = { code: 0, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
};

// Mid round 1: 14 Oct 2026, 12:00 KST.
const INSIDE_R1 = Date.parse('2026-10-14T03:00:00Z');

console.log('--- when voting is open');
{
  const { windowState, roundAt } = build(INSIDE_R1);
  check(windowState().open === true && windowState().round === 1, 'mid-round-1 is open, as round 1');
}
{
  // THE EXACT BOUNDARIES MAMA PUBLISHED, to the minute:
  //   1st VOTE  2026.10.12 19:00 – 2026.10.22 23:59 KST
  //   2nd VOTE  2026.10.28 18:00 – 2026.11.08 23:59 KST
  // Pinned because the first version of these came from a fan write-up and was
  // wrong by an hour at the start and by TEN DAYS at the end — long enough to
  // have counted votes against a ballot that had already closed.
  const shut = (iso) => build(Date.parse(iso)).windowState().open === false;
  const open = (iso) => build(Date.parse(iso)).windowState().open === true;
  check(shut('2026-10-12T09:59:00Z'), 'round 1 is shut at 18:59 KST');
  check(open('2026-10-12T10:00:00Z'), 'and opens at 19:00 KST, not 18:00');
  check(open('2026-11-08T14:59:00Z'), 'round 2 still counts at 23:59 KST on 8 Nov');
  check(shut('2026-11-08T15:00:00Z'), 'and is over a minute later — not ten days later');
  const w = build(Date.parse('2026-10-12T09:59:00Z')).windowState();
  check(w.round === 1 && !!w.opensAt, 'and before it opens the page can say when it does');
}
{
  // 22 Oct 23:59 KST — the last minute of round 1.
  const { windowState } = build(Date.parse('2026-10-22T14:59:00Z'));
  check(windowState().open === true, 'the last minute of round 1 still counts');
}
{
  // 25 Oct — the gap between the rounds.
  const { windowState } = build(Date.parse('2026-10-25T03:00:00Z'));
  const w = windowState();
  check(w.open === false && w.round === 2 && !w.ended, 'the gap between rounds is shut, pointing at round 2');
}
{
  const { windowState } = build(Date.parse('2026-12-01T00:00:00Z'));
  check(windowState().ended === true, 'after round 2 it is over, not merely shut');
}
{
  // The day boundary is Mnet's, not UTC's: 15:30Z is already tomorrow in Seoul.
  const a = build(Date.parse('2026-10-14T14:30:00Z')).kstDay();
  const b = build(Date.parse('2026-10-14T15:30:00Z')).kstDay();
  check(a === '2026-10-14' && b === '2026-10-15', `the day rolls at KST midnight (${a} → ${b})`);
}

console.log('\n--- the X account comes from the token, never the request');
{
  resetDb();
  tokenUser = { id: 'app-user-1' };
  identities = [{ provider: 'x', id: 'ignore-me', identity_data: { provider_id: '777', user_name: 'realblink' } }];
  const { handler } = build(INSIDE_R1);
  const r = res();
  // The body tries to name a different X account, and a handle of its own.
  await handler({ method: 'POST', query: {}, headers: {},
    body: { accessToken: 'good', x_user_id: '999', x_handle: 'imposter' } }, r);
  check(r.code === 200 && r.body.ok === true, `the vote is accepted (${r.code})`);
  check(inserted.length === 1 && inserted[0].x_user_id === '777',
        `and recorded against the token's X account, not the body's (${inserted[0] && inserted[0].x_user_id})`);
  check(inserted[0].x_handle === 'realblink', `with the identity's handle (${inserted[0].x_handle})`);
  check(inserted[0].round === 1, 'stamped with the round it was cast in');
}

console.log('\n--- a second vote the same day');
{
  const { handler } = build(INSIDE_R1);
  const r = res();
  await handler({ method: 'POST', query: {}, headers: {}, body: { accessToken: 'good' } }, r);
  check(r.code === 200, `is not an error (${r.code})`);
  check(r.body.already === true, 'and says so plainly');
  check(rows.length === 1, `with still one row for the day (${rows.length})`);
}

console.log('\n--- two site accounts, one X account');
{
  // The case the primary key exists for: same person, second Blinks United
  // account, same X account linked. Mnet would see one vote; so do we.
  tokenUser = { id: 'app-user-2' };
  const { handler } = build(INSIDE_R1);
  const r = res();
  await handler({ method: 'POST', query: {}, headers: {}, body: { accessToken: 'good' } }, r);
  check(r.body.already === true && rows.length === 1,
        `still one vote for the day (${rows.length} row, already=${r.body.already})`);
}

console.log('\n--- an account with no X identity');
{
  resetDb();
  tokenUser = { id: 'google-only' };
  identities = [{ provider: 'google', id: 'g1', identity_data: {} }];
  const { handler } = build(INSIDE_R1);
  const r = res();
  await handler({ method: 'POST', query: {}, headers: {}, body: { accessToken: 'good' } }, r);
  check(r.code === 409 && r.body.error === 'no-x-account', `is refused with a reason (${r.code} ${r.body.error})`);
  check(rows.length === 0, 'and nothing is written');
  const r2 = res();
  await handler({ method: 'GET', query: { me: '1' }, headers: { authorization: 'Bearer good' } }, r2);
  check(r2.code === 200 && r2.body.linkedX === false,
        'but reading my status is a 200 saying "not linked", not a fault');
}

console.log('\n--- the provider is whatever this project calls X');
{
  // Verified against the live auth table: Supabase stores 'x' here. It has
  // been 'twitter' elsewhere, so both are accepted rather than guessed.
  for (const prov of ['x', 'twitter']) {
    resetDb();
    tokenUser = { id: 'u-' + prov };
    identities = [{ provider: prov, id: 'i', identity_data: { provider_id: 'id-' + prov, user_name: prov } }];
    const { handler } = build(INSIDE_R1);
    const r = res();
    await handler({ method: 'POST', query: {}, headers: {}, body: { accessToken: 'good' } }, r);
    check(r.code === 200 && r.body.ok, `'${prov}' is recognised as an X identity`);
  }
}

console.log('\n--- outside a round');
{
  resetDb();
  tokenUser = { id: 'app-user-1' };
  identities = [{ provider: 'x', id: 'i', identity_data: { provider_id: '777', user_name: 'realblink' } }];
  const { handler } = build(Date.parse('2026-10-25T03:00:00Z'));   // the gap
  const r = res();
  await handler({ method: 'POST', query: {}, headers: {}, body: { accessToken: 'good' } }, r);
  check(r.code === 409 && r.body.error === 'closed', `nothing is counted (${r.code} ${r.body.error})`);
  check(rows.length === 0, 'and nothing is written');
}

console.log('\n--- signed out');
{
  resetDb();
  const { handler } = build(INSIDE_R1);
  const r = res();
  await handler({ method: 'POST', query: {}, headers: {}, body: { accessToken: 'nope' } }, r);
  check(r.code === 401, `a bad token cannot vote (${r.code})`);
  const r2 = res();
  await handler({ method: 'GET', query: { me: '1' }, headers: {} }, r2);
  check(r2.code === 401, `and cannot read a status (${r2.code})`);
  const r3 = res();
  await handler({ method: 'GET', query: {}, headers: {} }, r3);
  check(r3.code === 200 && typeof r3.body.today === 'number',
        'while the community total stays public');
}

// ── the page ────────────────────────────────────────────────────────────────
console.log('\n--- the panel');
{
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await b.newPage({ viewport: { width: 1100, height: 1200 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname.includes('fonts.g')) return route.continue();
    if (u.pathname === '/api/mama-votes') {
      if (u.searchParams.get('board')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ board: [{ handle: 'blinkone', days: 3 }] }) });
      if (u.searchParams.get('me')) return route.fulfill({ status: 401, body: '{}' });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ today: 42, accounts: 55, votes: 120, window: { open: true, round: 1 } }) });
    }
    if (u.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{"board":{"ranked":[],"unranked":[]},"messages":[],"total":0}' });
    if (/supabase/i.test(u.href) && u.hostname !== 'www.blinksunited.com') {
      return route.fulfill({ contentType: 'application/javascript', body:
        'window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:null}}),'
        + 'onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),linkIdentity:async()=>({})},'
        + 'from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:null})})})}),rpc:async()=>({data:null})})};' });
    }
    const f = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
    if (/\.(html|js|json|css|png|jpg|svg|webp)$/.test(f)) return route.fulfill({ path: root + f }).catch(() => route.fulfill({ status: 204, body: '' }));
    if (u.hostname === 'www.blinksunited.com') return route.fulfill({ path: root + 'index.html', contentType: 'text/html' });
    return route.fulfill({ status: 204, body: '' });
  });
  await page.goto('https://www.blinksunited.com/voting', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  await page.evaluate(() => {
    try { closeTutorial(); } catch (e) {}
    document.getElementById('tutorial-overlay')?.remove();
    document.getElementById('ext-update-overlay')?.remove();
  });
  const tabs = await page.evaluate(() => [...document.querySelectorAll('.vv-awardsw-btn')].map(b => b.textContent.trim()));
  check(tabs.some(t => /MAMA/.test(t)), `MAMA is one of the award tabs (${tabs.join(' | ')})`);

  await page.evaluate(() => vmaSetAward('mama'));
  await page.waitForTimeout(900);
  const panel = await page.evaluate(() => {
    const el = document.getElementById('vma-vote-panel');
    return { text: el.innerText, nums: [...el.querySelectorAll('.vv-mama-top span')].map(s => s.textContent.trim()) };
  });
  check(panel.nums[0] === '42', `today's count is shown (${panel.nums.join(' / ')})`);
  check(/once per X account per day|one vote per X account per day/i.test(panel.text),
        'the one-a-day rule is stated on the panel');
  check(/our turnout|not the whole fandom/i.test(panel.text),
        'and so is what the number does not cover');
  check(/Sign in/i.test(panel.text), 'a signed-out blink is asked to sign in');

  // THE NOMINATIONS, AND WHICH ONE A VOTE CAN MOVE. Only Fans' Choice is
  // decided by voting; the rest are judged. A page showing four nominations
  // and one vote button, without saying which the button is for, sends people
  // to tweet at categories they cannot affect.
  const noms = await page.evaluate(() => [...document.querySelectorAll('.mama-nom')].map(n => ({
    cat: n.querySelector('.mama-nom-cat').textContent.trim(),
    votable: n.classList.contains('votable'),
    tag: n.querySelector('.mama-nom-tag').textContent.trim(),
  })));
  check(noms.length >= 4, `the nominations are listed (${noms.length})`);
  const votable = noms.filter(n => n.votable);
  check(votable.length === 1 && /Fans/i.test(votable[0].cat),
        `exactly one is marked as the one you vote for, and it is Fans' Choice (${votable.map(v => v.cat).join(', ')})`);
  check(noms.filter(n => !n.votable).every(n => /not a fan vote/i.test(n.tag)),
        'and every other nomination says it is not a fan vote');
  // The list is the COMPLETE set, confirmed by the site owner — LISA, ROSÉ and
  // JISOO really did not land a solo nomination. Without a heading saying so,
  // four rows read as "the four we found", and the obvious reaction is that
  // the page is missing some. The count has to come from the array, or it
  // becomes a lie the first time a nomination is corrected.
  const nhead = await page.evaluate(() => (document.querySelector('.mama-noms-head') || {}).textContent || '');
  check(new RegExp('All ' + noms.length + '\\b').test(nhead),
        `the nominations are presented as the full list, counted from the data (${nhead || 'no heading'})`);
  check(new RegExp('\\b' + votable.length + ' you can vote for').test(nhead),
        'and it says how many of them a vote can actually move');

  // The rules that actually cost a vote when ignored. Each of these is a line
  // from Mnet's own 1st Vote Guide, and each was either missing or softened in
  // the first version of this list — which is why they are pinned rather than
  // trusted to stay put.
  const rules = await page.evaluate(() => (document.querySelector('.mama-rules') || {}).textContent || '');
  check(/one vote per X account per day/i.test(rules), 'the per-day cap is in the rules');
  check(/not counted at all/i.test(rules) && /one.{0,12}artist tag/i.test(rules),
        'and so is the one-artist-tag rule, which silently voids a post');
  check(/90%/.test(rules) && /Mnet Plus/i.test(rules),
        'and that Mnet Plus is worth nine times what X is');
  // THE STRICT VERSION OF THE PER-DAY CAP. "More posts do not add votes" and
  // "only the first post is read" sound alike and are not: under the second, a
  // badly-tagged post cannot be corrected by posting again. Someone who
  // believes the first can lose a day without knowing it.
  check(/\bfirst\b/i.test(rules) && /not the (best or the )?last/i.test(rules),
        'only the FIRST voting post of the day is read — not merely "extra posts do not add votes"');
  check(/repost/i.test(rules) && /counts as your vote/i.test(rules),
        'a repost of a valid post counts as a vote');
  check(/public/i.test(rules) && /protected accounts are not counted/i.test(rules),
        'and a protected account is not counted at all');
  check(/capitals do not matter/i.test(rules), 'the artist tag is case-insensitive');
  check(/both Male and Female/i.test(rules) && /1 to 3 teams/i.test(rules),
        'the Mnet Plus session rules are stated (both categories, 1–3 teams)');
  check(/one ID on one device/i.test(rules), 'as is its one-ID-one-device cap');
  // The two halves have different rules, so the page must say which half each
  // rule belongs to. A flat list mixes "1 to 3 teams" (Mnet Plus) with "one
  // nominee" (X) and reads as a contradiction.
  const heads = await page.evaluate(() => [...document.querySelectorAll('.mama-rules-head')].map(h => h.textContent.trim()));
  check(heads.length >= 2 && heads.some(h => /\bX\b/.test(h)) && heads.some(h => /Mnet Plus/i.test(h)),
        `the rules are split by where the vote is cast (${heads.join(' | ') || 'no headings'})`);

  // WHAT THE PRE-FILLED POST MUST CARRY. The guide requires the campaign tag
  // and the artist tag; everything else in the text is ours. If a rewrite of
  // the suggested wording ever drops one of the two tags, the button hands
  // every blink an invalid vote.
  const tweet = await page.evaluate(() => MAMA_TWEET);
  check(tweet.includes('#2026MAMAVOTE'), `the suggested post carries the campaign tag (${tweet})`);
  check(/#BLACKPINK/i.test(tweet), 'and exactly one artist tag');
  check(tweet.match(/#(?!2026MAMAVOTE)[A-Za-z0-9_]+/g).length === 1,
        'only one — several artist hashtags void the post entirely');
  check(errs.length === 0, `no page errors (${errs.join(' | ') || 'none'})`);

  // Linking sends the browser to X and back. The tab it comes back to is the
  // soonest-closing ballot unless the return URL says otherwise — so a blink
  // who links lands on BreakTudo and cannot tell whether it worked.
  const back = await b.newPage({ viewport: { width: 1000, height: 1000 } });
  await back.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname.includes('fonts.g')) return route.continue();
    if (u.pathname === '/api/mama-votes') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ today: 7, accounts: 9, votes: 11, board: [] }) });
    if (u.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{"board":{"ranked":[],"unranked":[]},"total":0}' });
    const f = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
    if (/\.(html|js|json|css|png|jpg|svg|webp)$/.test(f)) { try { return await route.fulfill({ path: root + f }); } catch { return route.fulfill({ status: 204, body: '' }); } }
    if (u.hostname === 'www.blinksunited.com') return route.fulfill({ path: root + 'index.html', contentType: 'text/html' });
    return route.fulfill({ status: 204, body: '' });
  });
  await back.goto('https://www.blinksunited.com/voting#mama', { waitUntil: 'domcontentloaded' });
  await back.waitForTimeout(1800);
  check(await back.evaluate(() => _vvAward) === 'mama',
        'coming back to /voting#mama lands on the MAMA tab, not the default one');
  // The query param is what the real return uses, because an OAuth redirect
  // overwrites the fragment with its own payload.
  await back.goto('https://www.blinksunited.com/voting?award=mama', { waitUntil: 'domcontentloaded' });
  await back.waitForTimeout(1500);
  check(await back.evaluate(() => _vvAward) === 'mama',
        '?award=mama does too, which is what survives the trip to X and back');

  // A FAILED LINK MUST SAY SO. X returns the reason in the URL; the page used
  // to drop it, so the flow read as a loop with no explanation — and the
  // database confirmed nothing was being created, so it was a real failure
  // being hidden rather than a cosmetic one.
  // about:blank first: the previous URL differs only by its fragment, and a
  // fragment-only change is a same-document navigation — the page would not
  // re-run, and the error is read once at load. (Which is the same property
  // that made the fragment a bad place to carry the tab name.)
  await back.goto('about:blank');
  await back.goto('https://www.blinksunited.com/voting?award=mama#error=server_error&error_code=manual_linking_disabled&error_description=Manual+linking+is+disabled',
                  { waitUntil: 'domcontentloaded' });
  // Long enough for the panel to render on its own — calling showPage() here
  // raced the load and read the message before it was drawn.
  await back.waitForTimeout(2600);
  const shown = await back.evaluate(() => (document.getElementById('mama-msg') || {}).textContent || '');
  check(/manual_linking_disabled/.test(shown),
        `the reason X sent back is on the page (${shown.slice(0, 90) || 'nothing'})`);

  // ── REPOSTING OURS ──────────────────────────────────────────────────────
  // Mnet counts a repost of a valid post as the reposter's own vote, which
  // makes our daily post the shortest route for a blink: one tap and no chance
  // of fumbling the tags. The link is a search rather than a pinned URL — X
  // will not tell us our latest post for free — so what matters is that it is
  // scoped to BOTH our handle and the campaign tag. Scoped to only one of them
  // it would surface other people's posts, or our non-voting ones, and a
  // repost of the wrong thing is a wasted day.
  console.log('\n--- reposting ours');
  const rp = await page.evaluate(() => ({ url: mamaRepostUrl(), handle: MAMA_X_HANDLE, tag: MAMA_TAG_CAMPAIGN }));
  const q = decodeURIComponent(new URL(rp.url).searchParams.get('q') || '');
  check(/^https:\/\/x\.com\/search\?/.test(rp.url), `it is an X search (${rp.url.slice(0, 48)}…)`);
  check(q.includes('from:' + rp.handle), `scoped to our account (${q})`);
  check(q.includes(rp.tag), 'and to the campaign tag, so only voting posts come back');
  check(new URL(rp.url).searchParams.get('f') === 'live',
        'sorted newest first, so the top result is today’s');

  // ── WHO MAY PIN ─────────────────────────────────────────────────────────
  // The paste box only APPEARS for a browser holding the admin key, and that
  // is cosmetic — localStorage is the visitor's to edit. The gate is the
  // server, and this proves it: the key is checked against ADMIN_SECRET before
  // the handler looks at anything else, so faking the box gets you a 401 and
  // nothing pinned.
  {
    const { handler } = build(INSIDE_R1);
    const post = async (query) => {
      const r = res();
      await handler({ method: 'POST', query, headers: {},
                      body: { url: 'https://x.com/blinksunitedtwt/status/1234567890123' } }, r);
      return r;
    };
    check((await post({ action: 'pin' })).code === 401, 'pinning with no key is refused');
    check((await post({ action: 'pin', key: 'guessed' })).code === 401, 'and with the wrong key');
    // With the right key it gets past auth and dies on Redis, which is absent
    // in tests — a 500 here is the proof that the 401 above was the auth check
    // and not the handler failing before it ever looked at the key.
    const ok = await post({ action: 'pin', key: 'admin-secret' });
    check(ok.code !== 401, `the right key gets past the gate (${ok.code}: ${(ok.body || {}).error || 'pinned'})`);
  }

  // ── THE PINNED POST ─────────────────────────────────────────────────────
  // A pasted URL beats the search while it is fresh, and the server only
  // returns one under 24h old — so forgetting to pin degrades to the search
  // rather than to a link from last week. Checked against the API's own
  // validator, because what may be pinned is the part that matters: a pin is a
  // link the whole site tells people to repost.
  console.log('\n--- the pinned post');
  {
    const src = readFileSync(root + 'api/mama-votes.js', 'utf8');
    const grab = (name) => {
      const i = src.indexOf('function ' + name);
      const j = src.indexOf('\nfunction ', i + 1);
      return src.slice(i, j > 0 ? j : src.indexOf('\n\n// ──', i));
    };
    const mod = "const PIN_HANDLE='blinksunitedtwt'; const PIN_TTL_MS=24*3600*1000;\n"
      + grab('parsePostUrl') + '\n' + grab('freshPin') + '\nexport { parsePostUrl, freshPin };';
    const { parsePostUrl, freshPin } = await import('data:text/javascript,' + encodeURIComponent(mod));

    check(parsePostUrl('https://x.com/blinksunitedtwt/status/1234567890123').url
            === 'https://x.com/blinksunitedtwt/status/1234567890123',
          'our own post link is accepted');
    // Share links arrive with ?t= and ?s= on them; handing those to every blink
    // would pass our share session along with the post.
    check(!/[?&]t=/.test(parsePostUrl('https://x.com/blinksunitedtwt/status/1234567890123?t=abc&s=20').url),
          'and its share tracking is stripped before anyone is sent to it');
    check(parsePostUrl('https://twitter.com/BlinksUnitedTwt/status/1234567890123').url
            === 'https://x.com/blinksunitedtwt/status/1234567890123',
          'twitter.com and odd capitals normalise to the same link');
    // The one that would really hurt: a post from another account, pinned by a
    // paste from the wrong tab, with the whole site then amplifying it.
    check(/not @blinksunitedtwt/.test(parsePostUrl('https://x.com/someoneelse/status/1234567890123').error || ''),
          'someone else’s post is refused, and the message says whose it was');
    check(!!parsePostUrl('https://x.com/blinksunitedtwt').error, 'a profile link is not a post');
    check(parsePostUrl('') === null, 'and an empty url means "clear the pin", not an error');

    const pin = (ageMs) => ({ url: 'https://x.com/blinksunitedtwt/status/1', id: '1', at: Date.now() - ageMs });
    check(!!freshPin(pin(0)) && !!freshPin(pin(23 * 3600e3)), 'a pin from today is served');
    check(!freshPin(pin(25 * 3600e3)), 'one older than a day is not, so the search takes back over');
    check(!freshPin(null), 'and no pin at all is simply no pin');
  }

  // ── THE CAMPAIGN CARD ───────────────────────────────────────────────────
  // The nominations used to exist only inside the MAMA tab, so a blink reading
  // the BreakTudo or Kids' Choice tab never saw that MAMA was happening at all
  // — every other award on this page has a standing box of its own and MAMA
  // did not. The card is that box.
  console.log('\n--- the campaign card');
  const card = await page.evaluate(() => {
    // Found by the TITLE, which is the line that has to name the awards. The
    // first version of this looked at .vote-platform and would have gone on
    // passing after the two lines were swapped — a locator that survives the
    // thing it is meant to pin is not pinning it.
    const c = [...document.querySelectorAll('.vote-card')]
      .find((x) => /MAMA/i.test((x.querySelector('.vote-title') || {}).textContent || ''));
    if (!c) return null;
    return {
      title: (c.querySelector('.vote-title') || {}).textContent.trim(),
      platform: (c.querySelector('.vote-platform') || {}).textContent.trim(),
      deadline: (c.querySelector('.vote-deadline') || {}).textContent || '',
      votable: [...c.querySelectorAll('.vote-cat-link')].length,
      locked: [...c.querySelectorAll('.vote-cat-pro')].length,
      rows: [...c.querySelectorAll('.vote-cat-row')].length,
      chips: [...c.querySelectorAll('.vote-chip')].map((n) => n.textContent.trim()),
      rules: (c.querySelector('.vote-rules') || {}).textContent || '',
      href: (c.querySelector('.vote-btn') || {}).href || '',
      linkColour: (() => {
        const a = c.querySelector('.vote-rules a');
        return a ? getComputedStyle(a).color : null;
      })(),
    };
  });
  check(!!card, 'MAMA has a campaign box like the other awards, not just a tab');
  // The headline names the show. Someone scrolling the page has to be able to
  // tell WHICH awards this is from the big line alone; the category is context
  // for it, not a replacement.
  check(card && /2026 MAMA Awards/i.test(card.title) && /Fans.{0,3} Choice/i.test(card.platform),
        `the white line names the awards and the pink line the category (“${card && card.platform}” / “${card && card.title}”)`);
  check(card && !/Fans/i.test(card.title),
        'and the headline is not the category on its own, which never said which awards it was');
  check(card && card.rows === 4 && card.votable === 1 && card.locked === 3,
        `with all four nominations, one votable and three marked judged (${card && card.rows} rows, ${card && card.votable} link, ${card && card.locked} locked)`);
  // Derived from MAMA_NOMS, so the card and the tab cannot come to list
  // different nominations — which is the bug this card would otherwise add a
  // second copy of.
  const noms2 = await page.evaluate(() => MAMA_NOMS.map((n) => n.who));
  check(card && JSON.stringify(card.chips) === JSON.stringify(noms2),
        `and they are read from the same list the tab uses (${(card && card.chips || []).join(' / ')})`);
  check(card && /90%/.test(card.rules) && /#2026MAMAVOTE/.test(card.rules) && /first<?\/?b?>? voting post|first voting post/.test(card.rules.replace(/\s+/g, ' ')),
        'the card carries the rules that cost a vote, not just the dates');
  check(card && /mnetplus\.world/.test(card.href), `and Vote Now goes to Mnet Plus (${(card && card.href || '').slice(0, 60)}…)`);
  // THE BALLOT, not the front door: the deep link drops you on the vote itself.
  check(card && /deeplink=/.test(card.href) && /mama-fans-choice-vote/.test(decodeURIComponent(card.href)),
        'straight to the Fans’ Choice ballot rather than the event page');
  // TWO PARAMETERS THAT MUST NEVER COME BACK. The link was copied out of the
  // app's share sheet and arrived carrying both.
  //
  // `refererCode` is the one that matters: it arrived empty, but it is a
  // referral slot, and a link on a public page that has one is a link that
  // quietly credits a single account the day somebody pastes a code into it.
  // `missionType` claims a share mission on the visitor's behalf, which is not
  // ours to claim.
  check(card && !/refererCode/.test(card.href),
        'with no referral slot in it — an empty one is still a loaded one');
  check(card && !/missionType/.test(card.href),
        'and no share-mission tracking claimed on the visitor’s behalf');
  // The Fans' Choice row links to the same place the button does; two links to
  // one ballot that disagree is how one of them goes stale unnoticed.
  const rowHref = await page.evaluate(() => {
    const c = [...document.querySelectorAll('.vote-card')]
      .find((x) => /MAMA/i.test((x.querySelector('.vote-title') || {}).textContent || ''));
    return (c.querySelector('.vote-cat-link') || {}).href || '';
  });
  check(rowHref === card.href, 'and the category’s own Vote link is the same URL');

  // ROUND 2 HAS A DIFFERENT BALLOT. The deep link names the round and carries a
  // template id, so round 1's link is dead the moment round 2 opens.
  //
  // Round 2's link arrived on 2026-10-28 and this check changed with it: it
  // used to assert the event-page FALLBACK, which was right while the id was
  // unknown and is wrong now. What never changes is the thing underneath — a
  // card must never point at a closed ballot — so every window is checked
  // against `vote-r1` leaking into it, whatever it does point at.
  //
  // Round 2's template is `mama-fans-choice-vote-r2-v2`, a different NAME as
  // well as a different id, which is why the test matches on r1's absence and
  // r2's own string rather than on a round number spliced into a pattern.
  const urls = await page.evaluate(() => ({
    r1:   mamaVoteUrl(Date.parse('2026-10-15T00:00:00Z')),
    gap:  mamaVoteUrl(Date.parse('2026-10-25T00:00:00Z')),
    r2:   mamaVoteUrl(Date.parse('2026-11-01T00:00:00Z')),
    over: mamaVoteUrl(Date.parse('2026-12-01T00:00:00Z')),
    event: MAMA_EVENT_URL,
  }));
  const plain = (u) => decodeURIComponent(u);
  check(/vote-r1/.test(plain(urls.r1)), 'round 1 uses round 1’s ballot');
  check(/vote-r2/.test(plain(urls.r2)) && !/vote-r1/.test(plain(urls.r2)),
        'round 2 uses round 2’s own ballot, not round 1’s', urls.r2);
  // The gap sits between a closed round and an open one, and it points forward.
  check(!/vote-r1/.test(plain(urls.gap)), 'the gap never points back at round 1', urls.gap);
  // After the last round there is no ballot to name, so the event page is still
  // the only honest answer.
  check(!/vote-r1|vote-r2/.test(plain(urls.over)) && urls.over === urls.event,
        'after the last round it falls back to the event page', urls.over);
  // Both stored links are trimmed. The share sheet hands over a tracking
  // parameter and an empty referral slot; the second is the dangerous one,
  // because the day it is copied with a code in it every blink who taps Vote
  // Now is quietly crediting one account.
  for (const [name, u] of [['round 1', urls.r1], ['round 2', urls.r2]]) {
    check(!/missionType|refererCode/.test(u), `${name}’s link carries no share tracking`,
          (u.match(/(missionType|refererCode)[^&]*/g) || []).join(' '));
  }
  check(card && card.linkColour && card.linkColour !== 'rgb(0, 0, 238)',
        `the rules link is styled, not browser-default blue (${card && card.linkColour})`);

  // ONE SOURCE FOR THE DATES. BreakTudo shipped 02:53Z on the card and 02:59Z
  // on the tab and the countdown hit zero six minutes early; this is the same
  // shape of bug, made impossible rather than fixed again.
  check(await page.evaluate(() => VV_AWARD_CLOSES.mama === MAMA_ROUNDS[MAMA_ROUNDS.length - 1].to),
        'the tab closes on the same instant the rounds data says the last round ends');

  // THE SIX-DAY HOLE. A single deadline cannot express two rounds with a gap,
  // so the card picks one per state. Each is checked at a moment inside it.
  const timing = await page.evaluate(() => {
    const at = (s) => mamaCardTiming(Date.parse(s));
    return {
      r1:   at('2026-10-15T00:00:00Z'),
      gap:  at('2026-10-25T00:00:00Z'),
      r2:   at('2026-11-01T00:00:00Z'),
      over: at('2026-12-01T00:00:00Z'),
      ends: MAMA_ROUNDS.map((r) => new Date(r.to).toISOString()),
    };
  });
  check(timing.r1.deadline === timing.ends[0],
        'inside round 1 the countdown runs to round 1’s end, not to November');
  check(timing.r2.deadline === timing.ends[1], 'inside round 2 it runs to round 2’s end');
  check(timing.gap.deadline === timing.ends[1] && /paused/i.test(timing.gap.restriction || ''),
        `between the rounds it says voting is paused (${timing.gap.restriction || 'no warning'})`);
  check(Date.parse(timing.over.deadline) < Date.parse('2026-12-01T00:00:00Z'),
        'and once it is over the date is in the past, so the card files itself away');

  // ── THE SHARE CAPTION ───────────────────────────────────────────────────
  // Hitting Share copies a caption to the clipboard. For MAMA that caption is
  // ITSELF A VALID VOTE — it opens with the exact post Mnet counts — so a blink
  // who shares has voted, not merely told people to vote. Everything below
  // protects that property.
  console.log('\n--- the share caption');
  const cap = await page.evaluate(() => {
    const t = mamaShareText();
    const noUrl = t.replace(/\S*blinksunited\.com\S*/g, '');
    const emoji = (noUrl.match(/\p{Extended_Pictographic}/gu) || []).length;
    return { t, tweet: MAMA_TWEET, weighted: [...noUrl].length + emoji + 23,
             close: MAMA_ROUNDS.find((r) => Date.now() <= r.to).to };
  });
  check(cap.t.startsWith(cap.tweet),
        `it opens with the post Mnet counts, so sharing IS voting (“${cap.t.split('\n')[0]}”)`);
  // A post naming two artists is not counted AT ALL, so a stray second artist
  // tag here would silently void every share. Counted, not assumed.
  const artistTags = (cap.t.match(/#(?!2026MAMAVOTE\b)[A-Za-z][A-Za-z0-9_]*/g) || []);
  check(artistTags.length === 1,
        `and carries exactly one artist tag, or it would void the vote (${artistTags.join(' ') || 'none'})`);
  check(/#2026MAMAVOTE/.test(cap.t), 'plus the campaign tag');
  // X truncates past 280 for accounts without a subscription, and the line it
  // would cut is the deadline.
  check(cap.weighted <= 280, `and fits in a post without a subscription (${cap.weighted} weighted chars)`);
  const kstClose = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', day: 'numeric', month: 'short' }).format(new Date(cap.close));
  check(cap.t.includes(kstClose), `the deadline in it is the real one from MAMA_ROUNDS (${kstClose})`);
  check(/90%/.test(cap.t) && /10%/.test(cap.t) && /both/i.test(cap.t) && /FIRST/.test(cap.t),
        'and it carries the four things worth knowing: the split, both categories, first post only');

  // NO MARKUP IN ANY CAPTION. The rules render as HTML on the cards, and the
  // generic caption pasted them in raw — Kids' Choice was shipping fourteen
  // literal <b> tags per share. Checked for every campaign, not just MAMA.
  const tagLeak = await page.evaluate(() => VOTE_CAMPAIGNS
    .filter((c) => c.rules?.length)
    .map((c) => ({ id: c.id, bad: c.rules.map((r) => String(r).replace(/<[^>]+>/g, '')).join(' ') }))
    .filter((c) => /[<>]/.test(c.bad)).map((c) => c.id));
  check(tagLeak.length === 0, `no campaign's rules leave markup in a caption (${tagLeak.join(', ') || 'all clean'})`);

  // BreakTudo and Kids' Choice get their own captions too. Unlike MAMA's these
  // are NOT votes — those awards are voted on their own sites — so what each
  // has to carry is the one rule that costs people a vote there.
  const others = await page.evaluate(() => ['breaktudo-2026', 'kca-2026'].map((id) => {
    const c = VOTE_CAMPAIGNS.find((x) => x.id === id);
    const t = c.shareText(c);
    return { id, t, w: xWeight(t) };
  }));
  for (const o of others) {
    check(o.w <= 280, `${o.id}'s caption fits a post (${o.w} weighted chars)`);
    check(!/[<>]/.test(o.t), `and carries no markup`);
    check(/blinksunited|breaktudoawards|kca\.nick/.test(o.t), 'and says where to go');
  }
  check(/Cloudflare/.test(others[0].t) && /Enviar Votos/.test(others[0].t),
        'BreakTudo says votes go in batches behind the Cloudflare check');
  check(/EVERY category/.test(others[1].t) && /nothing is submitted/.test(others[1].t),
        'and Kids’ Choice says nothing submits until the round is finished');
  // These two must NOT look like MAMA's, which is a vote in itself. Telling
  // people to post a hashtag for an award that is not counted that way sends
  // them to do something useless.
  check(!others.some((o) => /2026MAMAVOTE/.test(o.t)),
        'and neither pretends a hashtag is a vote');
  // The nominee names in the Kids' Choice caption are read off the data, so a
  // longer one could push it past 280. It names them when they fit and counts
  // them when they do not, rather than overflowing — checked by adding one.
  const fellBack = await page.evaluate(() => {
    const c = VOTE_CAMPAIGNS.find((x) => x.id === 'kca-2026');
    const fat = { deadline: c.deadline, categories: c.categories.concat([{ name: 'X',
      nominees: [{ name: 'A Really Very Long Nominee Name That Will Not Fit At All' }] }]) };
    const t = kcaShareText(fat);
    return { w: xWeight(t), named: /ROSÉ/.test(t) };
  });
  check(fellBack.w <= 280 && !fellBack.named,
        `and falls back to a count rather than overflowing when the names grow (${fellBack.w} chars)`);

  // ── THE SHAREABLE GUIDE ─────────────────────────────────────────────────
  // mama-guide.html is rendered to a PNG and posted. A poster is the worst
  // place for a stale fact: it keeps circulating after the page is fixed, and
  // nobody looking at it can tell it is out of date. So the three things it
  // asserts that the site also asserts are checked against the site.
  console.log('\n--- the shareable guide');
  {
    const guide = readFileSync(root + 'mama-guide.html', 'utf8');
    const tweet = await page.evaluate(() => MAMA_TWEET);
    // The copy-paste box is the one bit people act on directly. Compared on the
    // tags rather than the whole string, because the poster marks them up.
    const copy = (guide.match(/<div class="copy-text">([\s\S]*?)<\/div>/) || [])[1] || '';
    const plain = copy.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    check(plain === tweet, `the copy-paste post matches the site's button (“${plain}” vs “${tweet}”)`);
    // The deadline, in the one place on the poster that shouts it.
    const closes = new Date(await page.evaluate(() => MAMA_ROUNDS[0].to));
    const kst = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', month: 'short', day: 'numeric' }).format(closes);
    check(guide.includes(kst), `and the deadline block says round 1's real close date (${kst})`);
    check(/90%/.test(guide) && /10%/.test(guide), 'the two weights are on it');
    // The rules that cost a vote. If one of these ever leaves the site's rule
    // list it has to leave the poster too — and vice versa.
    for (const [re, what] of [
      [/first post of the day/i, 'only the first post of the day counts'],
      [/one artist tag only/i, 'one artist tag only'],
      [/public/i, 'public accounts only'],
      [/repost/i, 'a repost counts'],
      [/both categories/i, 'both Male and Female to submit'],
    ]) check(re.test(guide), `and it carries: ${what}`);
    // It must not pick up the language picker: every other page loads i18n.js,
    // and a floating picker would be baked into the middle of the image.
    // Matched on a script TAG, not the bare filename: the file explains in a
    // comment why it does not load the runtime, and the first version of this
    // check failed on that comment — a test that cannot tell a <script> from
    // the prose about it will fail every time someone documents the decision.
    check(!/<script[^>]+i18n\.js/.test(guide),
          'the poster loads no i18n runtime, so no picker is rendered into the image');

    // THE POSTER'S HERO IS THE SITE'S HERO. /streams (.as-title/.as-sub) and
    // /leaderboard (.lb-header-title/.lb-header-sub) share one recipe, and the
    // poster is supposed to be a third copy of it. It was not: the headline
    // shipped at 0.012em tracking against the site's 0.055em, and the subtitle
    // in Bodoni Moda — the site's OTHER serif, used for display numerals and
    // never for this line. Both read as "nearly right", which is the hardest
    // kind of wrong to notice, so the values are compared against index.html
    // rather than written down here.
    const site = readFileSync(root + 'index.html', 'utf8');
    const siteTrack = (site.match(/\.as-title\s*\{[^}]*letter-spacing:\s*([\d.]+)em/) || [])[1];
    const posterTrack = (guide.match(/\bh1\s*\{[^}]*letter-spacing:\s*([\d.]+)em/) || [])[1];
    check(siteTrack && posterTrack && Math.abs(+siteTrack - +posterTrack) <= 0.01,
          `the headline is tracked like the site's (${posterTrack}em vs /streams ${siteTrack}em)`);
    check(/\.as-sub\s*\{[^}]*var\(--light-serif\)/.test(site) && /\.sub\s*\{[^}]*var\(--light-serif\)/.test(guide),
          'and the subtitle uses the same serif the site uses, not the other one');
    // Matched on a font-family DECLARATION and on the webfont request, not on
    // the bare word: the file explains in a comment why Bodoni is the wrong
    // serif here, and a check that cannot tell CSS from the prose about it
    // fails every time someone writes the reason down. Second time this exact
    // shape of over-broad match has bitten in this file.
    check(!/font-family:[^;]*Bodoni/.test(guide) && !/family=Bodoni/.test(guide),
          'with no Bodoni actually used or loaded');
    check(/Cormorant\+Garamond/.test(guide), 'and Cormorant Garamond actually loaded');

    // ROUNDED, LIKE EVERY OTHER SURFACE ON THE SITE. /streams builds its track
    // rows as 14px-radius cards with a diagonal pink wash; the leaderboard's
    // panels are 10-12px. The poster's cards shipped square, which is the kind
    // of thing that reads as "not quite ours" without being nameable.
    const siteRadius = (site.match(/\.as-tracks-table tbody tr:not\(\.as-album-row\) td:first-child\s*\{[^}]*border-radius:\s*(\d+)px/) || [])[1];
    const cardRadius = (guide.match(/\.method\s*\{[^}]*border-radius:\s*(\d+)px/) || [])[1];
    check(siteRadius && cardRadius === siteRadius,
          `the cards are rounded like /streams' track rows (${cardRadius}px vs ${siteRadius}px)`);
    check(/\.method\s*\{[^}]*linear-gradient\(135deg[^}]*rgba\(255,0,102/.test(guide),
          'and carry the same diagonal pink wash');

    // THE INSTRUCTIONS ARE PROSE, SO THEY ARE SET IN A PROSE FACE. They shipped
    // in DM Mono, which is the site's default and therefore felt safe, and read
    // badly: a monospace is for labels, counters and literal strings, not for
    // five lines of explanation someone has to get through. IBM Plex Sans is
    // already one of the site's faces.
    check(/\.method li\s*\{[^}]*var\(--sans\)/.test(guide),
          'the rules are set in the sans, not the monospace');
    check(/IBM\+Plex\+Sans/.test(guide), 'and IBM Plex Sans is actually loaded');
    // The literal you copy stays mono — that one IS a string, and a proportional
    // face would make the two hashtags harder to check character by character.
    check(/\.copy-text\s*\{[^}]*var\(--mono\)/.test(guide),
          'while the post you copy stays monospace, because it is a literal');

    // ── TAKING IT AWAY ──────────────────────────────────────────────────────
    // A poster nobody can save is a poster nobody posts. Checked as a real
    // download attribute pointing at a file that exists, not as the presence of
    // the word "download" — and the rendered PNG has to be on disk, because the
    // link is useless if the asset was never built.
    check(existsSync(root + 'mama-guide.png'), 'the rendered poster exists to be downloaded');

    // THE CAPTION COMES WITH THE DOWNLOAD. It was only copied by Share, which
    // is a different gesture: downloading the guide is the moment the words are
    // wanted, and the first person to try it got a picture and nothing to say
    // with it. Checked on all three download points.
    check(/onclick="copyGuideCaption\('mama-2026'\)"/.test(site),
          'the rules panel copies the caption as it downloads');
    check(/download="\$\{c\.guideName[^}]*\}"[^>]*onclick="copyGuideCaption/.test(site),
          'and so does the campaign card');
    check(/class="dl-btn"[^>]*onclick="copyCaption\(\)"/.test(guide),
          'and so does the poster page');
    // The poster page is standalone and cannot call the site's generator, so it
    // holds its own copy. Compared against the real one here, because a
    // duplicated string with a round number and a date in it is exactly the
    // thing that goes stale quietly.
    const inlineCap = (guide.match(/<script type="text\/plain" id="caption-src">([\s\S]*?)<\/script>/) || [])[1];
    check(inlineCap && inlineCap === cap.t,
          'and the caption it holds is identical to the one the site generates');
    // The fallback block has to say the same thing too, or the one person who
    // hits a refused clipboard gets a different post from everyone else.
    const fallbackCap = (guide.match(/<pre id="caption-fallback"[^>]*>([\s\S]*?)<\/pre>/) || [])[1];
    check(fallbackCap === cap.t, 'as is the copy shown when the clipboard is refused');

    // HOW MANY ADVANCE IS ONE FACT IN FOUR PLACES — two sentences on the site
    // and two on the poster, all hand-written, none derived from the others.
    // Mnet changed it from 20 to 10 and every copy had to be found by hand;
    // the one that gets missed is on a poster people download and post, where
    // it outlives the correction.
    //
    // Not checked against a number written here, which would be a fifth copy
    // to go stale. Checked for AGREEMENT: pull every statement of the cut out
    // of both files and require them to say the same thing.
    {
      // Scoped to MAMA's own phrasing. A looser pattern caught BreakTudo's
      // "Top 20 advance to the next round" — a different award, with its own
      // cut, which is not a disagreement at all. The count floor is what keeps
      // the narrowing honest: reword one of these and it drops out of the
      // match, the count falls, and this fails rather than passing on three
      // copies that happen to agree.
      const cuts = [/top\s+(\d+)<\/b>[^.<]{0,40}go through/gi, /makes the top\s+(\d+)/gi];
      const found = [];
      for (const [file, text] of [['index.html', site], ['mama-guide.html', guide]]) {
        for (const re of cuts) {
          for (const m of text.matchAll(re)) found.push({ file, n: m[1], at: m[0].replace(/\s+/g, ' ') });
        }
      }
      check(found.length === 4, `found ${found.length} statements of the advancement cut, expected 4`,
            found.map((f) => `${f.file}:${f.n}`).join(', '));
      const ns = [...new Set(found.map((f) => f.n))];
      check(ns.length === 1, 'and they all name the same number',
            ns.length === 1 ? `top ${ns[0]}` : found.map((f) => `${f.file}: ${f.at}`).join(' | '));
    }
    const dl = guide.match(/<a[^>]+class="dl-btn"[^>]*>/) || [];
    check(dl[0] && /download="[^"]*\.png"/.test(dl[0]) && /href="\/mama-guide\.png"/.test(dl[0]),
          `the poster page offers it as a download (${(dl[0] || 'no button').slice(0, 72)}…)`);
    // (That the bar sits OUTSIDE the screenshotted frame is asserted in
    // render_mama_guide.mjs, against the live DOM. Trying to establish it by
    // matching tags in the source was a test that would have passed almost
    // anything — the question is whether .dl-bar is a descendant of #poster,
    // and only a parser can answer that.)
    // The campaign card and the rules panel both offer it, since those are the
    // two places someone reading about MAMA actually is.
    check(/guide:\s*'\/mama-guide\.png'/.test(site), 'the campaign card carries the guide download');
    check(/class="mama-guide-dl"[^>]*href="\/mama-guide\.png"[^>]*download=/.test(site),
          'and so does the rules panel on the MAMA tab');
  }

  await back.goto('https://www.blinksunited.com/voting#nonsense', { waitUntil: 'domcontentloaded' });
  await back.waitForTimeout(1200);
  check(await back.evaluate(() => _vvAward) !== 'nonsense',
        'and an unrecognised hash falls through to the usual order');
  await back.close();
  await b.close();
}

console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
