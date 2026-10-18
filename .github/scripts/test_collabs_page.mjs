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
           hasPending: !!el.querySelector('.tally-pending'),
           pendingText: (el.querySelector('.tally-pending') || {}).textContent || '',
           note: (el.querySelector('.tally-note') || {}).textContent || '' };
}));
for (const b of bars) {
  if (b.counting) {
    b.hasBar && !b.hasPending ? ok(`${b.id}: draws a bar because it has numbers`)
                              : bad(`${b.id}: draws a bar because it has numbers`, JSON.stringify(b));
    /logged, not verified/i.test(b.note)
      ? ok(`${b.id}: the bar says logged, not verified`)
      : bad(`${b.id}: the bar says logged, not verified`, b.note.trim());
  } else {
    (!b.hasBar && b.hasPending) ? ok(`${b.id}: no numbers, so no bar`, 'says what is missing')
                                : bad(`${b.id}: no numbers, so no bar`, JSON.stringify(b));
    /not counting yet/i.test(b.pendingText)
      ? ok(`${b.id}: and says so plainly`)
      : bad(`${b.id}: and says so plainly`, b.pendingText.slice(0, 60));
  }
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
