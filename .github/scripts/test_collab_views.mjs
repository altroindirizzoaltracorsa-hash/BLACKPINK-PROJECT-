// The two views of the collab block, measured in a browser.
//
// Run: node .github/scripts/test_collab_views.mjs
//
// One selector now switches between two things that count differently:
//
//   BY TRADE — votes an ACT received, per pairing. Cannot be attributed to a
//     fandom in any way, because everyone in a collab votes the whole ballot.
//   BY VOTER — PEOPLE, by the side they say they are on, and what they logged.
//
// Two failures live here and neither one throws.
//
// The first is the selector itself. Putting the two under one control is an
// invitation to read the second as the first split up — "the BLOOM share of
// JENNIE's votes" — which is a claim about other people's voting that this
// page has no data for and has never made. So the voter view has to refuse
// that reading in its own words, and the trade view has to keep its own
// do-not-sum warning rather than inheriting a shared one.
//
// The second is the bar. The voter bars are drawn on VOTES EACH, not on the
// totals, because the headcounts are lopsided for reasons that have nothing to
// do with effort: BLINKs find the counter on their own site and BLOOMs have to
// be told it exists. Drawn on totals, the demo's 34 BLINKs averaging 34.7 get
// a full bar beside 9 BLOOMs averaging 50 — the picture then says the opposite
// of the figure printed next to it, and a screenshot of that looks completely
// healthy. So the widths are measured off the rendered elements, with the two
// orderings deliberately opposite in the sample data: whichever rule is in
// force, the widths say which one it was.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const PAGES = { '/collabs': '/collabs.html' };

const server = createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  const file = PAGES[p] || p;
  try {
    const buf = await readFile(ROOT + file);
    const ext = file.split('.').pop();
    res.writeHead(200, { 'content-type': { html: 'text/html', js: 'text/javascript',
      css: 'text/css', json: 'application/json', svg: 'image/svg+xml', png: 'image/png',
      jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[ext] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end(''); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

const browser = await chromium.launch();
const errs = [];
async function open(path, w = 1200) {
  const page = await browser.newPage({ viewport: { width: w, height: 1200 } });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  return page;
}

// ?demo=b is the page with the sides and with sample numbers in them. The
// numbers are chosen so the two rules disagree, which is what makes the
// measurement below mean anything.
const page = await open('/collabs?demo=b');

console.log('--- the selector offers both views and starts on the trade');
{
  const tabs = await page.$$eval('.pr-tabs .tab', (els) => els.map((e) => ({
    label: e.textContent.trim(), on: e.classList.contains('on'),
    pressed: e.getAttribute('aria-pressed'),
  })));
  check(tabs.length === 2, `there are ${tabs.length} view tab(s)`, tabs.map((t) => t.label).join(' / '));
  check(tabs.filter((t) => t.on).length === 1, 'exactly one is lit');
  // The lit tab and the rendered view have to agree. They are computed from
  // two different expressions, so a view that falls back without the tab
  // following leaves a reader looking at rows the control says are elsewhere.
  check(tabs[0] && tabs[0].on, 'and it is the trade view', tabs.map((t) => `${t.label}${t.on ? '*' : ''}`).join(' '));
  check(tabs.every((t) => t.pressed === (t.on ? 'true' : 'false')),
        'aria-pressed matches what is lit');
  const head = await page.$eval('.pairings-head', (e) => e.textContent.trim());
  check(/trade/i.test(head), 'the heading names the trade view', head);
}

console.log('\n--- switching to the voter view draws one row per declared side');
await page.click('.pr-tabs .tab:nth-child(2)');
await page.waitForTimeout(400);
const voter = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.pairings .pr-row')].map((r) => ({
    name: r.querySelector('.pr-name').textContent.trim(),
    nums: r.querySelector('.pr-nums').textContent.trim(),
    // The DRAWN width, in pixels, off the element. Reading the inline style
    // back would only confirm the string that was written.
    segs: [...r.querySelectorAll('.pr-seg')].map((s) => Math.round(s.getBoundingClientRect().width)),
  }));
  // The sides as the page declares them, and the sample numbers behind them,
  // read from the page's own data rather than copied into this file.
  const c = COLLABS.find((x) => x.id === 'bvp-kca-2026');
  const f = c.tally.periods[PERIOD].fandoms;
  return { rows, keys: c.fandoms.map((x) => x.key), f, view: PAIR_VIEW,
           head: document.querySelector('.pairings-head').textContent.trim() };
});
{
  check(voter.view === 'voter', 'the view switched', voter.view);
  check(/who logged/i.test(voter.head), 'the heading changed with it', voter.head);
  // Every declared side, plus one row for whoever did not answer. A side
  // dropped from this list reads as "they are not in this".
  const want = voter.keys.length + (voter.f.unsaid && voter.f.unsaid.people ? 1 : 0);
  check(voter.rows.length === want, `${voter.rows.length} row(s) for ${want} side(s)`,
        voter.rows.map((r) => r.name.split(/\s{2,}|\n/)[0]).join(' | '));
  check(voter.rows.every((r) => r.segs.length <= 1),
        'each row has ONE bar — a fandom is not an us/them pair');
  // The headcount belongs beside the name and the average beside the bar. The
  // average is the number the bar is drawn on, so it is the one that has to be
  // next to it.
  check(voter.rows.every((r) => /\d+\s+(person|people)/.test(r.name)),
        'every row prints its headcount');
  check(voter.rows.every((r) => /each/.test(r.nums) || r.nums === '—'),
        'and its votes-each figure', voter.rows.map((r) => r.nums).join(' | '));
}

console.log('\n--- and those bars are votes EACH, not the totals');
{
  const by = {};
  for (const r of voter.rows) {
    const key = Object.keys(voter.f).find((k) => new RegExp(k, 'i').test(r.name.replace(/\s+/g, '')))
      || (/didn/i.test(r.name) ? 'unsaid' : null);
    if (key) by[key] = { px: r.segs[0] || 0, ...voter.f[key] };
  }
  const sides = Object.entries(by).map(([k, v]) => ({ k, px: v.px,
    votes: v.votes, people: v.people, each: v.votes / v.people }));
  check(sides.length >= 3, `matched ${sides.length} side(s) to their numbers`,
        sides.map((s) => `${s.k} ${s.px}px`).join(', '));

  // The sample data is built so these two orderings are DIFFERENT. If they
  // were the same, this check could not tell the rules apart and would pass
  // under either.
  const byEach  = [...sides].sort((a, b) => b.each - a.each).map((s) => s.k).join('>');
  const byTotal = [...sides].sort((a, b) => b.votes - a.votes).map((s) => s.k).join('>');
  check(byEach !== byTotal, 'the two rules disagree on this data, so the test can tell them apart',
        `each: ${byEach} · totals: ${byTotal}`);

  const drawn = [...sides].sort((a, b) => b.px - a.px).map((s) => s.k).join('>');
  check(drawn === byEach, 'the widths follow votes-each', `drawn: ${drawn} · each: ${byEach}`);
  check(drawn !== byTotal, 'and NOT the totals', `drawn: ${drawn} · totals: ${byTotal}`);

  // Proportional, not merely ordered: the widest side is full and the rest are
  // in ratio to it. Ordering alone would pass on a bar drawn from the rank.
  const top = sides.reduce((a, b) => (b.each > a.each ? b : a));
  const off = sides.filter((s) => Math.abs(s.px / top.px - s.each / top.each) > 0.04);
  check(off.length === 0, 'and in proportion to the leader, not just in order',
        off.map((s) => `${s.k} ${Math.round(s.px / top.px * 100)}% vs ${Math.round(s.each / top.each * 100)}%`).join(', '));
}

console.log('\n--- a side nobody has joined draws nothing at all');
// A segment of any width is a claim. Two part-filled tracks read as a contest
// nobody is actually in, which is the state of this block before anybody has
// answered the counter's question.
{
  const empty = await page.evaluate(() => {
    const c = COLLABS.find((x) => x.id === 'bvp-kca-2026');
    const rows = voterRows({ fandoms: c.fandoms }, { fandoms: {} });
    const html = voterViewHtml(rows);
    const box = document.createElement('div');
    box.innerHTML = html;
    return { rows: rows.length, people: rows.reduce((a, r) => a + r.people, 0),
             segs: box.querySelectorAll('.pr-seg').length,
             note: box.querySelector('.pr-note').textContent };
  });
  check(empty.rows > 0, `all ${empty.rows} sides are still listed at zero`);
  check(empty.people === 0, 'with nobody in them');
  check(empty.segs === 0, 'and no bar segment is drawn', `${empty.segs} found`);
  check(/nobody has said/i.test(empty.note), 'the note says so in words');
}

console.log('\n--- a side the collab no longer lists is folded in, not dropped');
// This trade carried a second partner for two days. Those people are still in
// the board and still logging, and a key nothing recognises is the same
// situation as never having answered.
{
  const got = await page.evaluate(() => {
    const c = COLLABS.find((x) => x.id === 'bvp-kca-2026');
    const rows = voterRows({ fandoms: c.fandoms },
      { fandoms: { blink: { people: 2, votes: 20 }, gone: { people: 3, votes: 33 },
                   unsaid: { people: 1, votes: 7 } } });
    const other = rows.filter((r) => !c.fandoms.some((x) => x.key === r.key));
    return { rows: rows.length, other: other.map((r) => ({ label: r.label, ...r })) };
  });
  check(got.other.length === 1, 'the strays make one row', got.other.map((r) => r.label).join(', '));
  const o = got.other[0] || {};
  check(o.people === 4 && o.votes === 40,
        'carrying everybody unaccounted for', `${o.people} people / ${o.votes} votes`);
}

console.log('\n--- the voter view refuses the reading the selector invites');
{
  const notes = await page.evaluate(() => {
    const out = {};
    out.voter = document.querySelector('.pairings .pr-note').textContent;
    setPairView('trade');
    out.trade = document.querySelector('.pairings .pr-note').textContent;
    setPairView('voter');
    return out;
  });
  check(/cannot be traced to a fandom/i.test(notes.voter),
        'it says the trade votes cannot be split by fandom');
  check(/votes each/i.test(notes.voter), 'and that the bars are votes each');
  check(/self-declared/i.test(notes.voter), 'and that the sides are self-declared');
  // Each view keeps its OWN warning. The do-not-sum rule is about one ballot
  // slot standing behind three rows; it says nothing about the voter view, and
  // a single shared note would have to drop one of the two.
  check(/do not add these up/i.test(notes.trade), 'the trade view keeps its do-not-sum warning');
  check(notes.trade !== notes.voter, 'and the two notes are different text');
}

console.log('\n--- a collab with no declared sides keeps the trade rows and loses the control');
// One tab on its own is a filter that has lost its other option. ?demo=a is
// this page without the sides, which is the same shape as a collab whose
// partner never set any up.
{
  const plain = await open('/collabs?demo=a');
  const got = await plain.evaluate(() => ({
    tabs: document.querySelectorAll('.pr-tabs').length,
    rows: document.querySelectorAll('.pairings .pr-row').length,
    head: (document.querySelector('.pairings-head') || {}).textContent || '',
  }));
  check(got.tabs === 0, 'no selector is drawn', `${got.tabs} found`);
  check(got.rows === 4, `the four trade rows are still there`, String(got.rows));
  check(/trade/i.test(got.head), 'under the trade heading', got.head.trim());
  await plain.close();
}

console.log('\n--- nothing threw');
check(errs.length === 0, 'no page errors', errs.join(' | '));

await browser.close();
server.close();
console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
