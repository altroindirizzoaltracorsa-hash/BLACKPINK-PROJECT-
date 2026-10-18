// Drive the REAL /collabs in a browser.
//
// Run: node .github/scripts/test_collabs_page.mjs
//
// This page names another fandom's project next to ours, which is the one thing
// on the site that can misrepresent somebody who is not us. So the checks are
// mostly about restraint rather than layout:
//
//   * A collab nobody has agreed to must NOT be visible to the public. It is
//     readable with ?preview=1 so it can be shown to them, and nowhere else.
//   * The categories on the two sides must not overlap. A trade only exists
//     because the two acts are up for different awards; if that ever stopped
//     being true the page would be telling blinks to vote against themselves.
//   * The bar must not draw 0–0. An empty bar reads as a broken feature and,
//     worse, as a claim that counting is happening when it is not.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const PAGES = { '/collabs': '/collabs.html', '/awards': '/awards.html' };
const SPA = /^\/(voting|vote|feedback|votecard-embed)(\/|$)/;

const server = createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  const file = PAGES[p] || (p === '/' ? '/awards.html' : SPA.test(p) ? '/index.html' : p);
  try {
    const buf = await readFile(ROOT + file);
    const ext = file.split('.').pop();
    res.writeHead(200, { 'content-type': { html: 'text/html', js: 'text/javascript', css: 'text/css',
      json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
      jpeg: 'image/jpeg', webp: 'image/webp' }[ext] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end(''); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const ok = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { failures++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };

const browser = await chromium.launch();
const errs = [];
async function open(path, w = 1200) {
  const page = await browser.newPage({ viewport: { width: w, height: 1000 } });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  return page;
}

console.log('--- a collab nobody agreed to stays off the public page');
const pub = await open('/collabs');
const data = await pub.evaluate(() => ({
  all: COLLABS.map((c) => ({ id: c.id, status: c.status })),
  drawn: [...document.querySelectorAll('.collab')].map((el) => el.dataset.collab),
  empty: !!document.querySelector('.empty'),
}));
const proposed = data.all.filter((c) => c.status === 'proposed').map((c) => c.id);
const leaked = proposed.filter((id) => data.drawn.includes(id));
proposed.length
  ? (leaked.length === 0 ? ok(`${proposed.length} proposed collab(s) hidden`, proposed.join(', '))
                         : bad('proposed collabs hidden', `visible: ${leaked.join(', ')}`))
  : ok('no proposed collabs to hide', 'nothing to check');
// And the page still says something rather than rendering a blank slab.
const nonProposed = data.all.filter((c) => c.status !== 'proposed');
(nonProposed.length ? data.drawn.length === nonProposed.length : data.empty)
  ? ok('the public page shows the right thing', data.empty ? 'the empty note' : `${data.drawn.length} collab(s)`)
  : bad('the public page shows the right thing', JSON.stringify(data));
await pub.close();

console.log('--- ?preview=1 shows them, so they can be sent to the partner');
const prev = await open('/collabs?preview=1');
const shown = await prev.evaluate(() => [...document.querySelectorAll('.collab')].map((el) => ({
  id: el.dataset.collab, status: el.dataset.status,
  statusText: (el.querySelector('.collab-status') || {}).textContent || '',
})));
shown.length === data.all.length ? ok('every collab is drawn in preview', `${shown.length}`)
                                 : bad('every collab is drawn in preview', `${shown.length} of ${data.all.length}`);
for (const s of shown.filter((x) => x.status === 'proposed')) {
  // Even in preview it must read as not-a-partnership on its face: this is the
  // view that gets screenshotted and sent around.
  /proposed|not announced/i.test(s.statusText)
    ? ok(`${s.id} is marked as not announced`, s.statusText.trim())
    : bad(`${s.id} is marked as not announced`, s.statusText.trim() || 'no marker');
}

console.log('--- the two sides are genuinely different categories');
// The entire premise. If an act appears on both sides, or a category does,
// there is no trade — and the page would be telling blinks to spend a slot
// they needed for BLACKPINK.
const sides = await prev.evaluate(() => COLLABS.map((c) => ({
  id: c.id,
  ours: c.theyGive.map((p) => p.cat),
  theirs: c.weGive.map((p) => p.cat),
  ourNames: c.theyGive.map((p) => p.nominee),
  theirNames: c.weGive.map((p) => p.nominee),
})));
for (const s of sides) {
  const norm = (x) => x.trim().toLowerCase();
  const clash = s.ours.map(norm).filter((c) => s.theirs.map(norm).includes(c));
  clash.length === 0 ? ok(`${s.id}: no category appears on both sides`)
                     : bad(`${s.id}: no category appears on both sides`, clash.join(', '));
  const nameClash = s.ourNames.map(norm).filter((n) => s.theirNames.map(norm).includes(n));
  nameClash.length === 0 ? ok(`${s.id}: no nominee appears on both sides`)
                         : bad(`${s.id}: no nominee appears on both sides`, nameClash.join(', '));
  (s.ours.length && s.theirs.length) ? ok(`${s.id}: both sides have something to do`,
      `${s.theirs.length} for us → ${s.ours.length} for them`)
    : bad(`${s.id}: both sides have something to do`, JSON.stringify(s));
}

console.log('--- the bar never claims to be counting when it is not');
const bars = await prev.evaluate(() => [...document.querySelectorAll('.collab')].map((el) => {
  const id = el.dataset.collab;
  const c = COLLABS.find((x) => x.id === id);
  const counting = !!(c.tally && (c.tally.us || c.tally.them));
  return { id, counting,
           hasBar: !!el.querySelector('.bar'),
           // The fills are the claim. An empty track is honest furniture; a
           // track with segments in it asserts a score.
           fills: el.querySelectorAll('.bar-us, .bar-them').length,
           label: (el.querySelector('.tally-nums') || {}).textContent || '',
           why: (el.querySelector('.tally-why') || {}).textContent || '',
           note: (el.querySelector('.tally-note') || {}).textContent || '' };
}));
for (const b of bars) {
  if (b.counting) {
    (b.hasBar && b.fills === 2) ? ok(`${b.id}: the bar is filled from both sides`)
                                : bad(`${b.id}: the bar is filled from both sides`, JSON.stringify(b));
    /logged, not verified/i.test(b.note)
      ? ok(`${b.id}: the bar says logged, not verified`)
      : bad(`${b.id}: the bar says logged, not verified`, b.note.trim());
  } else {
    // The track may be drawn — it holds the place the bar will take. What it
    // must not do is put anything IN it, because a segment of any width is a
    // score, and a 50/50 one reads as a real tie.
    b.fills === 0 ? ok(`${b.id}: no numbers, so nothing is drawn in the bar`)
                  : bad(`${b.id}: no numbers, so nothing is drawn in the bar`, `${b.fills} fill(s)`);
    /not counting yet/i.test(b.label)
      ? ok(`${b.id}: and the label says so`, b.label.trim())
      : bad(`${b.id}: and the label says so`, b.label.trim() || '(no label)');
    // The reasons stay reachable even though they are folded away.
    /extension|record|counting/i.test(b.why)
      ? ok(`${b.id}: what is missing is still readable`)
      : bad(`${b.id}: what is missing is still readable`, b.why.slice(0, 60));
  }
}

console.log('--- and when there ARE numbers, the bar draws them in proportion');
// Nothing on the page has a tally yet, so without this the filled branch would
// ship having never rendered once. Feed it numbers and re-render: the widths
// are the only thing on this page that could be silently wrong in a way a
// reader would still believe.
const filled = await prev.evaluate(() => {
  const before = JSON.parse(JSON.stringify(COLLABS[0].tally || null));
  COLLABS[0].tally = { us: 1200, them: 400, asOf: new Date().toISOString(), themSource: 'their page' };
  render();
  const el = document.querySelector('.collab');
  const pct = (sel) => {
    const n = el.querySelector(sel);
    if (!n) return null;
    const track = el.querySelector('.bar').getBoundingClientRect().width;
    return Math.round(n.getBoundingClientRect().width / track * 100);
  };
  const out = { us: pct('.bar-us'), them: pct('.bar-them'),
                nums: (el.querySelector('.tally-nums') || {}).textContent || '',
                note: (el.querySelector('.tally-note') || {}).textContent || '',
                stillHasWhy: !!el.querySelector('.tally-why') };
  COLLABS[0].tally = before;                 // leave the page as it was
  render();
  return out;
});
// 1200 of 1600 is 75/25. Allow a point of rounding on either side.
(Math.abs(filled.us - 75) <= 1 && Math.abs(filled.them - 25) <= 1)
  ? ok('the two sides are drawn in proportion', `${filled.us}% / ${filled.them}%`)
  : bad('the two sides are drawn in proportion', `${filled.us}% / ${filled.them}% — expected 75/25`);
(/1,200/.test(filled.nums) && /400/.test(filled.nums))
  ? ok('and the numbers are written out with separators', filled.nums.trim())
  : bad('and the numbers are written out with separators', filled.nums.trim());
/logged, not verified/i.test(filled.note)
  ? ok('and it says logged, not verified')
  : bad('and it says logged, not verified', filled.note.trim());
!filled.stillHasWhy ? ok('and the "what has to happen first" note is gone')
                    : bad('and the "what has to happen first" note is gone', 'both states showing');

console.log('--- the bar sits under the countdown, not at the bottom');
// Its position is the point: once a trade is running this is the live number
// people reopen the page for, and it belongs above the reference material
// rather than below two columns of it. Ordering of template expressions, which
// nothing else would notice a change to.
const order = await prev.evaluate(() => [...document.querySelectorAll('.collab')].map((el) => {
  const y = (sel) => { const n = el.querySelector(sel); return n ? Math.round(n.getBoundingClientRect().top) : null; };
  return { id: el.dataset.collab, deadline: y('.collab-deadline'), tally: y('.tally'),
           why: y('.collab-why'), sides: y('.sides') };
}));
for (const o of order) {
  const seq = [o.deadline, o.tally, o.why, o.sides];
  if (seq.some((v) => v === null)) { bad(`${o.id}: every block is present`, JSON.stringify(o)); continue; }
  seq.every((v, i) => i === 0 || v > seq[i - 1])
    ? ok(`${o.id}: countdown → bar → why → the two sides`, seq.join(' < '))
    : bad(`${o.id}: countdown → bar → why → the two sides`, JSON.stringify(o));
}

console.log('--- the page itself');
// It carries the same escape hatch as the other standalone pages.
const backOk = await prev.evaluate(() => {
  const a = document.querySelector('a.back');
  return !!(a && a.getAttribute('href') === '/index.html' && a.getClientRects().length);
});
backOk ? ok('links back to the homepage') : bad('links back to the homepage');

const links = await prev.evaluate(() => [...document.querySelectorAll('a[href^="/"]')].map((a) => a.getAttribute('href')));
for (const href of [...new Set(links)]) {
  const r = await prev.request.get(base + href);
  r.ok() ? ok(`${href} resolves`) : bad(`${href} resolves`, `HTTP ${r.status()}`);
}
// A deadline that has already passed would show a live "open the ballot" button.
const stale = await prev.evaluate(() => COLLABS.filter((c) =>
  c.status !== 'ended' && c.deadline && new Date(c.deadline).getTime() <= Date.now()).map((c) => c.id));
stale.length === 0 ? ok('no collab is past its deadline but still marked open')
                   : bad('no collab is past its deadline but still marked open', stale.join(', '));

for (const w of [390, 1200]) {
  await prev.setViewportSize({ width: w, height: 1000 });
  await prev.waitForTimeout(300);
  const over = await prev.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  over <= 0 ? ok(`no sideways scroll at ${w}px`) : bad(`no sideways scroll at ${w}px`, `${over}px`);
}
if (errs.length) bad('no page errors', errs.join(' | ')); else ok('no page errors', 'none');

await prev.close();
await browser.close();
server.close();
console.log(`\nFAILURES: ${failures}`);
process.exit(failures ? 1 : 0);
