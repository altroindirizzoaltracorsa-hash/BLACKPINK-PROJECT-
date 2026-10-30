// Achievements can be shared: one, several, or all of them.
//
// Run: node .github/scripts/test_achievements_share.mjs
//
// WHY. There are 71 achievements on that page and their wording moves — the
// 10M-followers row was reworded three times in one afternoon. So the share
// post has to be BUILT FROM THE ROWS, and the only way to check that is to
// compare the post against what the rows actually render. A check that held
// the expected post as a string in this file would be checking my typing, and
// would go green on a builder that quotes the site wrongly.
//
// Every assertion below therefore reads its expected value out of the DOM:
// how many achievements there are, what each one says, what the overflow cap
// is. Nothing about the page's content is written down here.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';

const root = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

const TY = { html:'text/html', js:'text/javascript', css:'text/css', json:'application/json',
  png:'image/png', jpg:'image/jpeg', webp:'image/webp', svg:'image/svg+xml', mp4:'video/mp4' };
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/sw.js') { res.writeHead(404); res.end(''); return; }
  try { const b = await readFile(root + (p === '/' ? '/index.html' : p));
    res.writeHead(200, { 'content-type': TY[p.split('.').pop()] || 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end(''); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });

// The share path writes to the clipboard and then opens the share sheet.
// Neither exists in headless Chromium, so both are replaced with recorders —
// the point is what the page PASSES them, which is the post itself.
await page.addInitScript(() => {
  window.__shared = []; window.__copied = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } },
  });
  navigator.share = (d) => { window.__shared.push(d); return Promise.resolve(); };
});
await page.goto(base + '/achievements.html', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.achShareText === 'function', null, { timeout: 30000 }).catch(() => {});

console.log('--- every achievement is pickable');
const rowInfo = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.rec-item, .ms-row')];
  return {
    total: rows.length,
    recs: document.querySelectorAll('.rec-item').length,
    ms: document.querySelectorAll('.ms-row').length,
    wired: rows.filter((r) => r.getAttribute('role') === 'button'
      && r.getAttribute('tabindex') === '0'
      && r.getAttribute('aria-pressed') === 'false').length,
    cap: window.ACH_SHARE_CAP,
  };
});
check(rowInfo.total > 0, `the page has achievements to share`, `${rowInfo.recs} records + ${rowInfo.ms} milestones = ${rowInfo.total}`);
// Both row types, named rather than counted. Wiring only `.rec-item` would
// leave all 18 milestones unshareable while a count-based check still read
// "most of them are wired".
check(rowInfo.recs > 0 && rowInfo.ms > 0, 'both kinds of row are present, so both are being tested',
      `.rec-item ${rowInfo.recs}, .ms-row ${rowInfo.ms}`);
check(rowInfo.wired === rowInfo.total, 'every row is a keyboard-reachable button, unpressed to start',
      `${rowInfo.wired} of ${rowInfo.total}`);
check(typeof rowInfo.cap === 'number' && rowInfo.cap > 0, 'the page exposes its overflow cap', `cap=${rowInfo.cap}`);

console.log('\n--- picking one, and the post quotes THAT row');
// The expected text comes from the row itself. This is the assertion the whole
// file exists for: a builder that emitted a plausible but different sentence
// would pass every other check here.
const one = await page.evaluate(() => {
  const row = document.querySelectorAll('.rec-item')[3];
  row.click();
  const body = row.querySelector('.rec-text').cloneNode(true);
  body.querySelectorAll('.rec-src, .year').forEach((n) => n.remove());
  return {
    line: body.textContent.replace(/\s+/g, ' ').trim(),
    year: row.querySelector('.year').textContent.trim(),
    src: row.querySelector('.rec-src').textContent.replace(/\s+/g, ' ').trim(),
    pressed: row.getAttribute('aria-pressed'),
    barShown: !document.getElementById('ach-bar').hidden,
    count: document.getElementById('ach-count').textContent,
    post: window.achShareText([row]),
  };
});
check(one.pressed === 'true', 'the row reports itself pressed', one.pressed);
check(one.barShown, 'the share bar appears on the first pick');
check(one.count === '1', 'and it counts one', one.count);
check(one.post.includes(one.line), "the post contains the row's own sentence",
      one.post.includes(one.line) ? one.line.slice(0, 54) + '…' : `post says: ${one.post.slice(0, 90)}`);
check(one.post.includes(one.year), "and the row's own year", one.year);
check(one.post.includes(one.src), 'and its source, which is what answers "says who?" for a single pick');
// COUNTED, NOT MERELY FOUND. `.rec-src` sits INSIDE `.rec-text`, so a builder
// that reads the body without stripping it puts the citation in the sentence
// as well as on its own line. Every "contains" assertion above still passes in
// that state, because the run-on sentence starts with the correct one — which
// is how the first version of this check went green on the mutation. What
// gives it away is the source appearing twice.
const srcCount = one.post.split(one.src).length - 1;
check(srcCount === 1, 'the source appears exactly once, so it is not also inside the sentence',
      srcCount === 1 ? 'once' : `${srcCount}× — the sentence is carrying it too`);

console.log('\n--- picking a second one puts both in');
const two = await page.evaluate(() => {
  const row = document.querySelectorAll('.ms-row')[2];   // a milestone, not a record
  row.click();
  const body = row.querySelector('.ms-text').cloneNode(true);
  body.querySelectorAll('.ms-src').forEach((n) => n.remove());
  return {
    line: body.textContent.replace(/\s+/g, ' ').trim(),
    count: document.getElementById('ach-count').textContent,
    post: window.achShareText([...document.querySelectorAll('.ach-picked')]),
  };
});
check(two.count === '2', 'two picked', two.count);
check(two.post.includes(one.line) && two.post.includes(two.line),
      'the post carries both rows, across both row types',
      two.post.includes(two.line) ? 'both present' : `missing the milestone: ${two.line.slice(0, 50)}`);
// And the sources drop out above one pick, which is the whole reason a dozen
// picks stay readable. This also catches the leak the other way round: a
// sentence carrying its citation would put it back in.
check(!two.post.includes(one.src), 'and the long sources are left out of a multi-pick post');

console.log('\n--- sharing hands the clipboard and the sheet the same post');
const shared = await page.evaluate(async () => {
  document.getElementById('ach-share').click();
  await new Promise((r) => setTimeout(r, 120));
  return { copied: window.__copied, shared: window.__shared };
});
check(shared.copied.length === 1, 'the post is written to the clipboard first', `${shared.copied.length} write(s)`);
check(shared.shared.length === 1, 'and the share sheet is opened', `${shared.shared.length} call(s)`);
check(shared.shared[0] && shared.shared[0].text === shared.copied[0],
      'both get the identical text — the clipboard is the fallback, not a variant');
// A `url` field makes Instagram, X and TikTok drop `text` entirely, which is
// why the link lives inside the post. This is the house rule the playlist
// shares already follow.
check(shared.shared[0] && !shared.shared[0].url, 'nothing rides along beside the text');
check(shared.copied[0].includes('blinksunited.com/achievements'), 'and the link is inside the post itself');

console.log('\n--- select all, and the overflow is stated rather than dropped');
const all = await page.evaluate(() => {
  document.getElementById('ach-all').click();
  const post = window.achShareText([...document.querySelectorAll('.ach-picked')]);
  return {
    count: Number(document.getElementById('ach-count').textContent),
    word: document.getElementById('ach-count-word').textContent,
    bullets: (post.match(/^◆ /gm) || []).length,
    post,
  };
});
check(all.count === rowInfo.total, 'select all picks every achievement on the page',
      `${all.count} of ${rowInfo.total}`);
check(/all of them/.test(all.word), 'and the bar says so', all.word);
check(all.bullets === rowInfo.cap, 'the post lists exactly as many as the cap allows',
      `${all.bullets} bullets, cap ${rowInfo.cap}`);
// Computed from the page's own total and cap. Hard-coding "59 more" here would
// break on the next achievement added, and would be checking arithmetic I did
// rather than arithmetic the page does.
const over = rowInfo.total - rowInfo.cap;
check(all.post.includes(`…and ${over} more`), 'and it says how many it left out', `…and ${over} more`);

console.log('\n--- clear puts it back');
const cleared = await page.evaluate(() => {
  document.getElementById('ach-clear').click();
  return {
    picked: document.querySelectorAll('.ach-picked').length,
    pressed: [...document.querySelectorAll('.rec-item, .ms-row')].filter((r) => r.getAttribute('aria-pressed') === 'true').length,
    hidden: document.getElementById('ach-bar').hidden,
  };
});
check(cleared.picked === 0, 'nothing is picked', `${cleared.picked} left`);
// The class and the attribute are set together, so they are checked together:
// a clear that drops the highlight but leaves aria-pressed="true" tells a
// screen reader the opposite of what the page shows.
check(cleared.pressed === 0, 'and no row still reports itself pressed', `${cleared.pressed} left`);
check(cleared.hidden, 'and the bar goes away');

console.log('\n--- the keyboard works, since every row claims to be a button');
const kb = await page.evaluate(async () => {
  const row = document.querySelectorAll('.rec-item')[0];
  row.focus();
  row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  const afterSpace = row.classList.contains('ach-picked');
  row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  return { afterSpace, afterEnter: row.classList.contains('ach-picked') };
});
check(kb.afterSpace, 'Space picks a focused row');
check(!kb.afterEnter, 'Enter picks it again, which un-picks it');

await browser.close();
server.close();
console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
