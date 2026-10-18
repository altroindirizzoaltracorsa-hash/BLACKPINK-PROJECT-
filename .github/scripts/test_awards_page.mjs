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

console.log('--- every nomination has a picture, and the ones nobody can vote in are shaded');
// Two things that look fine in the source and are wrong on screen:
//   * a thumb whose src 404s or fails to decode leaves a 56px hole beside the
//     row, and the page reports nothing — the whole point of the pictures is
//     that the row is recognised at a glance,
//   * the shading on a judged category comes from a class the renderer has to
//     add; lose it and the row claims, silently, that there is a vote to cast.
// Read off the live rows rather than a list kept here, so a category added to
// MAMA_NOMS or the KCA card is covered the day it appears.
for (const b of BALLOTS) {
  const fr = page.frames().find((f) => f.url().includes(`card=${b.key}`));
  if (!fr) { bad(`${b.key}: frame found for the row check`); continue; }
  // Wait for the images themselves, not just the markup: decode() settles
  // whether the file is really there, which naturalWidth alone would report
  // as 0 simply because the browser had not got to it yet.
  const rows = await fr.evaluate(async () => {
    const out = [];
    for (const r of document.querySelectorAll('#vc-embed-root .vote-cat-row')) {
      const img = r.querySelector('img.vote-cat-thumb');
      if (img) { try { await img.decode(); } catch (e) {} }
      out.push({
        name: (r.querySelector('.vote-category-name span')?.textContent || '').trim(),
        pro: r.classList.contains('pro'),
        lock: !!r.querySelector('.vote-cat-pro'),
        link: !!r.querySelector('.vote-cat-link'),
        src: img ? img.getAttribute('src') : null,
        loaded: !!(img && img.naturalWidth > 0 && img.naturalHeight > 0),
        box: img ? Math.round(img.getBoundingClientRect().width) : 0,
        opacity: parseFloat(getComputedStyle(r).opacity),
      });
    }
    return out;
  });
  rows.length ? ok(`${b.key}: ${rows.length} category rows`)
              : bad(`${b.key}: has category rows`, 'none rendered — nothing was checked');
  for (const r of rows) {
    const who = `${b.key}: ${r.name || '(unnamed)'}`;
    if (!r.src) { bad(`${who} has a picture`, 'no thumb at all'); }
    else if (!r.loaded) { bad(`${who} has a picture`, `${r.src} did not load`); }
    else if (r.box < 40) { bad(`${who} has a picture`, `rendered ${r.box}px wide`); }
    else ok(`${who} has a picture`, r.src);

    // `pro` and the 🔒 chip are two halves of the same fact; either one alone
    // is a row that shades without saying why, or says why without shading.
    r.pro === r.lock ? null : bad(`${who}: shading and the 🔒 chip agree`,
      `class.pro=${r.pro}, chip=${r.lock}`);
    if (r.pro) {
      r.opacity < 0.6 ? ok(`${who} is shaded`, `opacity ${r.opacity}`)
                      : bad(`${who} is shaded`, `opacity ${r.opacity}`);
      r.link ? bad(`${who} offers no Vote link`, 'a judged category is linked as votable')
             : ok(`${who} offers no Vote link`);
    } else {
      r.opacity >= 0.99 ? ok(`${who} is not shaded`) : bad(`${who} is not shaded`, `opacity ${r.opacity}`);
    }
  }
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
// With the boxes gone there is no frame holding the columns level, so the
// thing to check is that they still are: both cards must start on the same
// line, or two unequal logos quietly knock the columns out of step.
const tops = await page.evaluate(() => [...document.querySelectorAll('.ballot .frame-wrap')]
  .map((f) => Math.round(f.getBoundingClientRect().top)));
(tops.length === 2 && Math.abs(tops[0] - tops[1]) <= 2)
  ? ok('both cards start on the same line', `y ${tops.join(' / ')}`)
  : bad('both cards start on the same line', `y ${tops.join(' / ')}`);

// And the vertical rule — the only thing marking a column now — is really
// drawn, in that award's own colour rather than the inherited site pink.
const rules = await page.evaluate(() => [...document.querySelectorAll('.ballot')].map((b) => {
  const cs = getComputedStyle(b);
  return { id: b.id, width: cs.borderLeftWidth, colour: cs.borderLeftColor, style: cs.borderLeftStyle };
}));
for (const r of rules) {
  (parseFloat(r.width) >= 2 && r.style !== 'none')
    ? ok(`${r.id}: has its vertical rule`, `${r.width} ${r.colour}`)
    : bad(`${r.id}: has its vertical rule`, JSON.stringify(r));
}
(rules.length === 2 && rules[0].colour !== rules[1].colour)
  ? ok('the two rules are different colours')
  : bad('the two rules are different colours', rules.map((r) => r.colour).join(' / '));

// No box should have come back: a background or a full border on the column
// is exactly what was removed.
const boxed = await page.evaluate(() => [...document.querySelectorAll('.ballot')].map((b) => {
  const cs = getComputedStyle(b);
  const bg = cs.backgroundColor;
  const solid = bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg);
  return { id: b.id, bg, solid, right: cs.borderRightWidth, top: cs.borderTopWidth, radius: cs.borderRadius };
}).filter((b) => b.solid || parseFloat(b.right) > 0 || parseFloat(b.top) > 0));
boxed.length === 0 ? ok('neither column is boxed')
                   : bad('neither column is boxed', JSON.stringify(boxed));

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
