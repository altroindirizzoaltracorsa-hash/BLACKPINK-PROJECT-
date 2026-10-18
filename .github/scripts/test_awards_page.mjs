// Drive the REAL /awards in a browser and prove the two embedded ballots work.
//
// Run: node .github/scripts/test_awards_page.mjs
//
// /awards is the site's front door (vercel.json redirects / to it). It shows
// nothing of its own: each half is index.html in card-embed mode, so the
// countdowns, rules, nominations and MAMA's round switch stay correct without
// a second copy. That makes three things worth checking, none of which are
// visible from the page source:
//   * each frame mounts the card it ASKED for — both frames are the same
//     document with a different query, so a mix-up renders two plausible
//     pages that are silently the wrong way round,
//   * each frame reports its height and the parent applies it to the right
//     frame — the message is tagged precisely because two frames post to one
//     window,
//   * nothing of the main site leaks into the frame (nav, footer, the rest of
//     the vote list).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
// The routes vercel.json rewrites, mirrored so links resolve as in production.
const PAGES = { '/awards': '/awards.html', '/breaktudo': '/breaktudo.html', '/vmas': '/vmas.html',
                '/projects': '/projects.html', '/achievements': '/achievements.html' };
const SPA = /^\/(votecard-embed|vma-board-embed|ltal-embed|countdowns|voting|vote|streams|charts|badges|leaderboard|account|feedback)(\/|$)/;

const BALLOTS = [
  { key: 'mama', expect: /MAMA/i, frame: 'frame-mama' },
  { key: 'kca', expect: /Kids.{0,3} Choice/i, frame: 'frame-kca' },
];

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
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem('bu_tutorial_seen', '1'); } catch (e) {} });
await page.goto(base + '/awards', { waitUntil: 'domcontentloaded' });

console.log('--- the two frames');
for (const b of BALLOTS) {
  // The card is mounted by JS after the embedded page boots, so wait for it.
  let handle = null;
  try {
    handle = await page.frameLocator(`#${b.frame}`).locator('#vc-embed-root .vote-card').first()
      .waitFor({ timeout: 30000 }).then(() => true);
  } catch { handle = false; }
  if (!handle) { bad(`${b.key}: the card mounted`); continue; }
  ok(`${b.key}: the card mounted`);

  const f = page.frameLocator(`#${b.frame}`);
  const title = (await f.locator('#vc-embed-root .vote-title').first().textContent().catch(() => '')) || '';
  b.expect.test(title) ? ok(`${b.key}: it is the right card`, title.trim())
                       : bad(`${b.key}: it is the right card`, `got "${title.trim()}"`);

  // Exactly one card — the rest of the vote list must not come along.
  const n = await f.locator('#vc-embed-root .vote-card').count();
  n === 1 ? ok(`${b.key}: one card only`) : bad(`${b.key}: one card only`, `${n} cards`);

  // And nothing of the surrounding site is visible inside the frame.
  const leaked = await page.frames()
    .find((fr) => fr.url().includes(`card=${b.key}`))
    ?.evaluate(() => [...document.body.children]
      .filter((el) => el.id !== 'vc-embed-root' && getComputedStyle(el).display !== 'none')
      .map((el) => el.tagName + (el.id ? '#' + el.id : '')));
  (leaked && leaked.length === 0) ? ok(`${b.key}: nothing else of the site shows`)
                                  : bad(`${b.key}: nothing else of the site shows`, (leaked || []).join(', '));
}

console.log('--- each half carries its award\'s own logo');
// An <img> that 404s or fails to decode has no intrinsic size, and a logo
// that silently vanished would leave a column with no identity at all — the
// whole reason these are logos rather than text.
const logos = await page.evaluate(() => [...document.querySelectorAll('.ballot')].map((b) => {
  const img = b.querySelector('img.ballot-logo');
  const r = img ? img.getBoundingClientRect() : null;
  return { id: b.id, src: img && img.getAttribute('src'), alt: img && img.getAttribute('alt'),
           ok: !!(img && img.naturalWidth > 0 && img.naturalHeight > 0),
           h: r ? Math.round(r.height) : 0, w: r ? Math.round(r.width) : 0,
           // The band must contain it: these are two very different aspect
           // ratios forced to one row height.
           inside: !!(r && b.querySelector('.ballot-head') &&
             r.left >= b.querySelector('.ballot-head').getBoundingClientRect().left - 1 &&
             r.right <= b.querySelector('.ballot-head').getBoundingClientRect().right + 1) };
}));
for (const l of logos) {
  l.ok ? ok(`${l.id}: logo loaded`, `${l.src} at ${l.w}x${l.h}`) : bad(`${l.id}: logo loaded`, l.src || 'no img');
  l.inside ? ok(`${l.id}: logo fits its band`) : bad(`${l.id}: logo fits its band`, `${l.w}px wide`);
  l.alt ? ok(`${l.id}: logo has alt text`, l.alt) : bad(`${l.id}: logo has alt text`);
}
// The two bands have to line up or the columns look broken side by side.
const heads = await page.evaluate(() => [...document.querySelectorAll('.ballot-head')]
  .map((h) => Math.round(h.getBoundingClientRect().height)));
(heads.length === 2 && Math.abs(heads[0] - heads[1]) <= 2)
  ? ok('the two logo bands are the same height', `${heads.join(' / ')}px`)
  : bad('the two logo bands are the same height', heads.join(' / ') + 'px');

console.log('--- the parent applies each height to the right frame');
for (const b of BALLOTS) {
  const h = await page.locator(`#${b.frame}`).evaluate((el) => el.getBoundingClientRect().height);
  // 320px is the CSS starting height; anything at or below it means no height
  // was applied, or it was applied to the other frame.
  h > 330 ? ok(`${b.key}: frame grew to fit`, `${Math.round(h)}px`)
          : bad(`${b.key}: frame grew to fit`, `${Math.round(h)}px — still the 320px default`);
  const gone = await page.locator(`#loading-${b.key}`).count();
  gone === 0 ? ok(`${b.key}: the loading note cleared`) : bad(`${b.key}: the loading note cleared`);
}
const stalled = await page.locator('.ballot.stalled').count();
stalled === 0 ? ok('neither ballot fell back to its link') : bad('neither ballot fell back to its link', `${stalled}`);

console.log('--- the page itself');
const links = await page.evaluate(() => [...document.querySelectorAll('a[href^="/"]')].map((a) => a.getAttribute('href')));
for (const href of [...new Set(links)]) {
  const r = await page.request.get(base + href);
  r.ok() ? ok(`${href} resolves`) : bad(`${href} resolves`, `HTTP ${r.status()}`);
}
if (errs.length) bad('no page errors', errs.join(' | ')); else ok('no page errors', 'none');

for (const w of [390, 1280]) {
  await page.setViewportSize({ width: w, height: 1000 });
  await page.waitForTimeout(400);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  over <= 0 ? ok(`no sideways scroll at ${w}px`) : bad(`no sideways scroll at ${w}px`, `${over}px`);
}

await browser.close();
server.close();
console.log(`\nFAILURES: ${failures}`);
process.exit(failures ? 1 : 0);
