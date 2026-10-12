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
import { readFileSync } from 'node:fs';
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
    .replace(/^export default async function handler/m, 'async function handler')
    .replace(/^export const __test = .*$/m, '');
  if (stripped === src) throw new Error('the handler no longer looks the way this test rewrites it');
  return (now) => {
    // A Date that still parses and formats normally, but whose "now" is ours.
    class FakeDate extends Date {
      constructor(...a) { super(...(a.length ? a : [now])); }
      static now() { return now; }
    }
    FakeDate.parse = Date.parse;
    FakeDate.UTC = Date.UTC;
    return new Function('createClient', 'process', 'Date',
      stripped + '\nreturn { handler, kstDay, roundAt, windowState, MAMA_ROUNDS };')(
      () => fakeSb, { env: { SUPABASE_URL: 'u', SUPABASE_SERVICE_KEY: 'k' } }, FakeDate);
  };
}
const build = loadHandler();

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

  // The two rules that actually cost a vote when ignored.
  const rules = await page.evaluate(() => (document.querySelector('.mama-rules') || {}).textContent || '');
  check(/one vote per X account per day/i.test(rules), 'the per-day cap is in the rules');
  check(/not counted at all/i.test(rules) && /one.{0,12}artist tag/i.test(rules),
        'and so is the one-artist-tag rule, which silently voids a post');
  check(/90%/.test(rules) && /Mnet Plus/i.test(rules),
        'and that Mnet Plus is worth nine times what X is');
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
