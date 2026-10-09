// Drive the real /voting page and check the Kids' Choice TAB — the board, not
// the campaign card (that is test_vote_kca.mjs).
//
// Run: node .github/scripts/test_vote_kca_board.mjs
//
// Three awards now share one panel and one endpoint, and the ways that goes
// wrong are all quiet ones:
//
//   * the tab order. A live ballot has to lead, and among the live ones the one
//     closing soonest, because that is where a vote not cast today is a vote
//     lost. The VMA tab must stay reachable and marked final rather than
//     vanishing.
//   * one award's data rendering under another's heading. The fetches are keyed
//     off _vvAward, so a missed ?award= shows the VMA board titled "Kids'
//     Choice" and every number looks plausible.
//   * the per-category chips. They explain PART of a row — a vote whose nominee
//     the counter could not identify is counted but unattributed — so the
//     remainder has to be named rather than folded into a category.
//   * the manual form. It posts {votes, cats}; if those disagree the board shows
//     a breakdown bigger than the total it breaks down.
//
// The round rule gets its own checks because it is the one thing that costs a
// blink the whole round: KCA submits at the END, so stopping after BLACKPINK
// casts nothing at all, and the counter then has nothing to count.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const INDEX = new URL('../../index.html', import.meta.url).pathname;
let fails = [];
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails.push(m); };

const KCA_BOARD = {
  ranked: [
    { name: 'alpha', total: 17, today: 5, week: 7, month: 7, streams: 40, usedExtension: true,
      cats_total: { 'favorite-music-group-or-duo': 13, 'favorite-female-artist': 3 },
      cats_today: { 'favorite-music-group-or-duo': 3, 'favorite-female-artist': 1, 'favorite-music-collaboration': 1 },
      cats_week: {}, cats_month: {} },
    // 6 today with only 4 attributed: the 2 unattributed must show as their own
    // "no category" chip, and an unknown slug must still read as something.
    { name: 'gamma', total: 6, today: 6, week: 6, month: 6, streams: 12, usedExtension: false,
      cats_total: { 'favorite-music-group-or-duo': 4 },
      cats_today: { 'favorite-music-group-or-duo': 3, 'favorite-bonus-round': 1 },
      cats_week: {}, cats_month: {} },
  ],
  unranked: [
    { name: 'beta', total: 3, today: 3, week: 3, month: 3, streams: 0, usedExtension: false,
      cats_total: { 'favorite-female-artist': 2 }, cats_today: { 'favorite-female-artist': 2 },
      cats_week: {}, cats_month: {} },
  ],
};
const KCA_TOTALS = { total: 26, today: 14, blinksTotal: 3, blinksToday: 3 };
const KCA_ME = { linked: true, extToday: false, ranked: true, streams: 40,
  today: 5, week: 7, month: 7, total: 17,
  cats: { 'favorite-music-group-or-duo': 13, 'favorite-female-artist': 3, 'favorite-bonus-round': 1 },
  catsToday: { 'favorite-music-group-or-duo': 3 }, days: [], daysFrom: '2026-10-08', todayKey: '2026-10-09' };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 412, height: 1400 }, deviceScaleFactor: 2 });
const errs = [];
const posts = [];
p.on('pageerror', (e) => errs.push(String(e)));

await p.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url());
  if (u.pathname === '/voting' || u.pathname === '/')
    return route.fulfill({ path: INDEX, contentType: 'text/html' });
  if (u.hostname.includes('fonts.g')) return route.continue();
  if (u.pathname === '/api/vma-votes') {
    if (req.method() === 'POST') {
      let body = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch {}
      posts.push(body);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    const award = u.searchParams.get('award') || 'vma';
    // Deliberately 404 anything that asks for another award while the Kids'
    // Choice tab is open — a fetch that forgot its ?award= must fail loudly in
    // this test rather than quietly render the wrong board.
    if (award !== 'kca') return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    if (u.searchParams.get('board')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ board: KCA_BOARD }) });
    if (u.searchParams.get('me')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(KCA_ME) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(KCA_TOTALS) });
  }
  if (u.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{}' });
  return route.fulfill({ status: 204, body: '' });
});

await p.goto('https://www.blinksunited.com/voting', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2500);
await p.evaluate(() => {
  try { closeTutorial(); } catch {}
  document.getElementById('tutorial-overlay')?.remove();
  document.getElementById('ext-update-overlay')?.remove();
});

console.log('--- the award switch carries all three');
// Order and labels come from the award table + the close dates, with no network.
const sw = await p.evaluate(() => ({
  order: vmaAwardOrder(),
  labels: vmaAwardOrder().map(a => _vvAwardMeta[a].label),
  closed: vmaAwardOrder().map(a => vmaAwardClosed(a)),
  dflt: _vvAward,
}));
check(sw.order.length === 3, `three awards (${sw.order.join(', ')})`);
check(sw.order.includes('kca'), 'Kids’ Choice is one of them');
check(sw.labels.every(Boolean) && sw.labels.includes('Kids’ Choice'), `each has a label (${sw.labels.join(' · ')})`);
// The VMAs closed in September; whatever else moves, they must sort last and be
// marked final rather than disappear.
check(sw.order[sw.order.length - 1] === 'vma', `the closed VMA ballot sorts last (${sw.order.join(', ')})`);
check(sw.closed[sw.order.indexOf('vma')] === true, 'and is reported as closed');
check(sw.closed[sw.order.indexOf('kca')] === false, 'while Kids’ Choice is open');
// Open ballots in closing order, so the most urgent leads.
const openCloses = await p.evaluate(() => vmaAwardOrder().filter(a => !vmaAwardClosed(a)).map(a => VV_AWARD_CLOSES[a]));
check(openCloses.every((c, i) => i === 0 || openCloses[i - 1] <= c),
      'the open ballots are ordered by which closes soonest');
check(sw.dflt === sw.order[0], `and the default tab is the first of them (${sw.dflt})`);
// The deadline the switch uses must be the one the campaign card shows, or the
// countdown and the tab disagree about whether voting is over.
const sameDeadline = await p.evaluate(() =>
  VV_AWARD_CLOSES.kca === Date.parse(VOTE_CAMPAIGNS.find(c => c.id === 'kca-2026').deadline));
check(sameDeadline, 'the Kids’ Choice tab and its campaign card share one deadline');

console.log('\n--- switching to it loads ITS board');
await p.evaluate(() => vmaSetAward('kca'));
await p.waitForTimeout(900);
const view = await p.evaluate(() => {
  const el = document.getElementById('vma-vote-panel');
  const t = el.textContent.replace(/\s+/g, ' ');
  return {
    title: el.querySelector('.vv-title')?.textContent.trim() || '',
    award: _vvAward,
    rows: [...el.querySelectorAll('.vv-table tbody tr')].map(tr =>
      [...tr.querySelectorAll('td')].map(td => td.textContent.replace(/\s+/g, ' ').trim())),
    headers: [...el.querySelectorAll('.vv-table thead th')].map(th => th.textContent.trim()),
    chips: [...el.querySelectorAll('.vv-rowcat')].map(c => c.textContent.replace(/\s+/g, ' ').trim()),
    unranked: [...el.querySelectorAll('.vv-unranked-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim()),
    community: el.querySelector('.vv-community-big')?.textContent.trim() || '',
    notes: [...el.querySelectorAll('.vv-daynote')].map(n => n.textContent.replace(/\s+/g, ' ').trim()),
    text: t,
  };
});
check(view.award === 'kca', 'the panel is on the kca award');
check(/Kids.{0,3} Choice Voting Leaderboard/.test(view.title), `titled for it (${view.title})`);
check(view.rows.length === 2, `both ranked blinks render (${view.rows.length})`);
// The table sorts by the SELECTED period, not by all-time — the tab says
// "Votes today", so it has to be today's order. gamma's 6 today outranks
// alpha's 5 even though alpha leads 17-6 overall.
check(view.rows[0] && view.rows[0][1].startsWith('gamma'),
      `sorted by the period on screen, not all-time (${view.rows.map(r => r[1].split(/[A-Z]/)[0]).join(' then ')})`);
check(view.headers.includes('Streams'), `with a Streams column (${view.headers.join(' | ')})`);
const alphaRow = view.rows.find(r => r[1].startsWith('alpha'));
check(alphaRow && alphaRow[2] === '40', `and each blink's streams in it (${alphaRow && alphaRow[2]})`);
check(alphaRow && alphaRow[3] === '5', `with the period's votes, not the total (${alphaRow && alphaRow[3]})`);
check(view.unranked.length === 1 && /beta/.test(view.unranked[0]),
      `the non-streaming voter is listed but not ranked (${view.unranked.join(' / ')})`);
check(!view.rows.some(r => /beta/.test(r[1])), 'and is NOT in the ranked table');
check(view.community === '26', `the community total is this award's (${view.community})`);

console.log('\n--- the chips name our categories, and name the remainder');
check(view.chips.some(c => /^Music Group or Duo 3$/.test(c)), `our category reads in words (${view.chips.join(' · ')})`);
check(view.chips.some(c => /^Female Artist 1$/.test(c)), 'and so does the second one');
check(view.chips.some(c => /^Music Collaboration 1$/.test(c)), 'and the third');
check(!view.chips.some(c => /favorite-/.test(c)), 'no raw slug is shown to anyone');
// A Bonus/Live category Nickelodeon adds mid-campaign is not in our table, and
// must still render as something rather than being dropped.
check(view.chips.some(c => /^Bonus Round 1$/.test(c)),
      `an unknown category is prettified, not dropped (${view.chips.join(' · ')})`);
// gamma: 6 today, 4 attributed → 2 unaccounted for.
check(view.chips.some(c => /^no category 2$/.test(c)),
      `the unattributed remainder is named (${view.chips.join(' · ')})`);

console.log('\n--- the rule that costs the whole round');
const band = view.notes.find(n => /submitted/i.test(n)) || '';
check(/Nothing is submitted until you finish the round/i.test(band), `the panel says it (${band.slice(0, 90)}…)`);
check(/no votes at all/i.test(band), 'and says what stopping early actually costs');
check(view.notes.some(n => /no vote limit/i.test(n)), 'the no-published-limit rule is stated');
check(view.notes.some(n => /100 a day/i.test(n) && /different award/i.test(n)),
      'and the circulating "100 a day" figure is corrected, not repeated');
check(view.notes.some(n => /midnight KST/i.test(n)), 'the day boundary is stated');

console.log('\n--- signed in: my own totals and the manual form');
await p.evaluate((me) => {
  // The panel reads these three globals; faking them is how this test reaches
  // the signed-in branch without an auth round trip.
  _vvSession = { user: { user_metadata: { display_name: 'alpha' } }, access_token: 'tok' };
  _vvToken = 'tok';
  _vvMe = me;
  drawKcaVoting();
}, KCA_ME);
await p.waitForTimeout(300);
const mine = await p.evaluate(() => {
  const el = document.getElementById('vma-vote-panel');
  return {
    head: el.querySelector('.vv-me-head')?.textContent.replace(/\s+/g, ' ').trim() || '',
    stats: [...el.querySelectorAll('.vv-me-stats div span')].map(s => s.textContent.trim()),
    rank: el.querySelector('.vv-rank')?.textContent.replace(/\s+/g, ' ').trim() || '',
    myCats: [...el.querySelectorAll('.vv-btcats .vv-btcat-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim()),
    formHidden: document.getElementById('kca-manual')?.style.display === 'none',
    inputs: [...document.querySelectorAll('[data-kcacat]')].map(i => i.getAttribute('data-kcacat')),
  };
});
check(/Your Kids.{0,3} Choice votes/.test(mine.head), `my own section is this award's (${mine.head})`);
check(mine.stats.join(',') === '5,7,7,17', `today/week/month/all-time (${mine.stats.join(', ')})`);
// #2, because the ranking follows the period on screen and alpha's 5 today is
// behind gamma's 6 — same reason as the table order above.
check(/#2 of 2/.test(mine.rank), `my rank is shown, on the period's order (${mine.rank})`);
check(mine.myCats.length === 3, `my per-category list has one row per category I voted in (${mine.myCats.join(' · ')})`);
// 17 all time against 13+3+1 attributed: nothing left over, so no remainder row.
check(!mine.myCats.some(r => /Not attributed/.test(r)),
      'and no remainder row when the categories already add up');
check(mine.formHidden === true, 'the manual form starts closed, so typing in votes takes a deliberate click');
check(mine.inputs.length === 3 && mine.inputs.every(s => /^favorite-/.test(s)),
      `one box per category of ours (${mine.inputs.join(', ')})`);

console.log('\n--- the manual form posts a breakdown that adds up');
await p.evaluate(() => {
  const el = document.getElementById('kca-manual'); if (el) el.style.display = 'block';
  const set = (slug, n) => { const i = document.querySelector(`[data-kcacat="${slug}"]`); if (i) i.value = String(n); };
  set('favorite-music-group-or-duo', 2);
  set('favorite-music-collaboration', 1);
});
await p.evaluate(() => kcaAddVotes());
await p.waitForTimeout(700);
const post = posts[posts.length - 1] || {};
check(posts.length >= 1, `a vote was posted (${posts.length})`);
check(post.award === 'kca', `on the kca dimension (${post.award})`);
check(post.votes === 3, `the total is the sum of the boxes (${post.votes})`);
check(post.cats && post.cats['favorite-music-group-or-duo'] === 2 && post.cats['favorite-music-collaboration'] === 1,
      `with the per-category split (${JSON.stringify(post.cats)})`);
check(Object.values(post.cats || {}).reduce((a, c) => a + c, 0) === post.votes,
      'and the split adds up to the total exactly');
check(!post.cats || !('favorite-female-artist' in post.cats), 'an empty box is not sent as 0');
check(typeof post.accessToken === 'string', 'authenticated as the signed-in blink');
const msg = await p.evaluate(() => document.getElementById('kca-msg')?.textContent || '');
check(/Added 3/.test(msg), `and it says so (${msg})`);

console.log('\n--- nothing else broke');
check(errs.length === 0, `no page errors (${errs.join(' | ') || 'none'})`);
const of_ = await p.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
check(of_ <= 1, `no horizontal overflow at 412px (${of_}px)`);
// Every other award must still be reachable from here.
const back = await p.evaluate(() => {
  const btns = [...document.querySelectorAll('.vv-awardsw-btn')].map(x => x.textContent.replace(/\s+/g, ' ').trim());
  return btns;
});
check(back.length === 3, `the switch still offers all three from this tab (${back.join(' | ')})`);
check(back.some(x => /final/i.test(x)), 'with the finished ballot marked final');

await p.screenshot({ path: '/tmp/kca-board.png', fullPage: true }).catch(() => {});
await b.close();
console.log(`\nFAILURES: ${fails.length}`);
fails.forEach((f) => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
