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

console.log('--- the MAMA half shows where we stand and what to post');
{
  const fr = page.frames().find((f) => f.url().includes('card=mama'));
  if (!fr) { bad('mama frame found for the standing check'); }
  else {
    const s = await fr.evaluate(() => {
      const el = document.querySelector('#vc-embed-root .vote-standing');
      const r = document.querySelector('#vc-embed-root .vote-repost');
      return {
        standing: el && { pos: (el.querySelector('.vote-standing-pos') || {}).textContent,
                          when: (el.querySelector('.vote-standing-when') || {}).textContent,
                          txt: el.textContent.replace(/\s+/g, ' ').trim() },
        repost: r && { head: (r.querySelector('.vote-repost-head') || {}).textContent.trim(),
                       who: (r.querySelector('.vote-repost-who') || {}).textContent.trim(),
                       text: (r.querySelector('.vote-repost-text') || {}).textContent.trim(),
                       repost: (r.querySelector('.vote-repost-btn') || {}).href,
                       own: (r.querySelector('.vote-repost-alt') || {}).href },
        // The gating, exercised against the page's own function rather than
        // re-implemented here. A standing read in round 1 must not be shown
        // during the pause or in round 2: round 2 counts from zero.
        gate: (() => {
          try {
            return { now: !!mamaStanding(Date.parse('2026-10-18T12:00:00Z')),
                     pause: !!mamaStanding(Date.parse('2026-10-25T12:00:00Z')),
                     r2: !!mamaStanding(Date.parse('2026-10-30T12:00:00Z')) };
          } catch (e) { return { err: String(e) }; }
        })(),
      };
    });
    if (!s.standing) bad('the Mnet Plus standing is shown');
    else {
      /^#\d+$/.test(s.standing.pos) ? ok('the Mnet Plus standing is shown', s.standing.txt)
                                    : bad('the Mnet Plus standing is shown', `position reads "${s.standing.pos}"`);
      // A position with no date is a claim to be current, and it is not.
      /checked/i.test(s.standing.when || '') && /\d/.test(s.standing.when || '')
        ? ok('and says when it was read', s.standing.when.trim())
        : bad('and says when it was read', s.standing.when || 'no date');
      /round \d/i.test(s.standing.when || '') ? ok('and which round it belongs to')
                                              : bad('and which round it belongs to', s.standing.when || '');
    }
    s.gate.err ? bad('the standing gate runs', s.gate.err)
      : (s.gate.now && !s.gate.pause && !s.gate.r2)
        ? ok('a round-1 standing hides in the pause and in round 2', JSON.stringify(s.gate))
        : bad('a round-1 standing hides in the pause and in round 2', JSON.stringify(s.gate));

    // The card's shape, top to bottom: how long, where we stand, what to do,
    // what we are up for. Asserted because it is an ordering of independent
    // template expressions — nothing makes them come out in this order except
    // their position in the string, and nothing else would notice a swap.
    const order = await fr.evaluate(() => {
      const card = document.querySelector('#vc-embed-root .vote-card');
      const want = ['.vote-deadline', '.vote-standing', '.vote-repost', '.vote-categories'];
      const found = want.map((sel) => {
        const el = card.querySelector(sel);
        return el ? { sel, y: Math.round(el.getBoundingClientRect().top) } : { sel, y: null };
      });
      return found;
    });
    const missing = order.filter((o) => o.y === null).map((o) => o.sel);
    if (missing.length) bad('the card carries every block in the order', `missing ${missing.join(', ')}`);
    else {
      const ys = order.map((o) => o.y);
      const sorted = ys.every((y, i) => i === 0 || y > ys[i - 1]);
      sorted ? ok('countdown → ranking → post → nominations', order.map((o) => `${o.sel.slice(1)}@${o.y}`).join(' '))
             : bad('countdown → ranking → post → nominations', order.map((o) => `${o.sel.slice(1)}@${o.y}`).join(' '));
    }

    if (!s.repost) bad('the daily vote post is shown');
    else {
      s.repost.text.length > 8 ? ok('the daily vote post is shown', `"${s.repost.text}"`)
                               : bad('the daily vote post is shown', `"${s.repost.text}"`);
      // The post has to carry both tags or it is not a vote — this is the
      // text people are being handed, so it is worth asserting literally.
      (/#2026MAMAVOTE/i.test(s.repost.text) && /#BLACKPINK/i.test(s.repost.text))
        ? ok('and it carries both required hashtags')
        : bad('and it carries both required hashtags', s.repost.text);
      /^@\w+/.test(s.repost.who) ? ok('and names the account it comes from', s.repost.who)
                                 : bad('and names the account it comes from', s.repost.who);
      /^https:\/\/(x|twitter)\.com\//.test(s.repost.repost || '')
        ? ok('repost button goes to X', s.repost.repost)
        : bad('repost button goes to X', s.repost.repost || 'no href');
      /^https:\/\/x\.com\/intent\/post/.test(s.repost.own || '')
        ? ok('and "post my own" opens a composer', s.repost.own)
        : bad('and "post my own" opens a composer', s.repost.own || 'no href');
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

console.log('--- the way back to the site');
// This page IS the front door — / redirects here — so it is the one page with
// no nav above it. Without a link out, the site proper is unreachable from the
// thing that replaced it. It shipped that way once.
//
// Checked on all three front doors rather than just this one, read from their
// own markup: /vmas and /breaktudo took this role before /awards, and the next
// page to take it should fail here rather than ship without the escape hatch.
for (const path of ['/awards', '/breaktudo', '/vmas']) {
  const r = await page.request.get(base + path);
  const html = r.ok() ? await r.text() : '';
  /class="back"[^>]*>|<a[^>]+class="back"/.test(html) && /href="\/index\.html"[^>]*class="back"|class="back"[^>]*href="\/index\.html"/.test(html)
    ? ok(`${path} links back to the homepage`)
    : bad(`${path} links back to the homepage`, r.ok() ? 'no .back → /index.html' : `HTTP ${r.status()}`);
}
// And on this page, that it is actually on screen and clear of the hero rather
// than merely present in the source.
for (const w of [390, 1280]) {
  await page.setViewportSize({ width: w, height: 844 });
  await page.waitForTimeout(300);
  const b = await page.evaluate(() => {
    const a = document.querySelector('a.back');
    if (!a) return null;
    const r = a.getBoundingClientRect();
    const eyebrow = document.querySelector('.hero-eyebrow').getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width),
             text: a.textContent.trim(), href: a.getAttribute('href'),
             visible: getComputedStyle(a).display !== 'none' && r.width > 0,
             clearsHero: r.bottom <= eyebrow.top,
             inView: r.left >= 0 && r.right <= window.innerWidth };
  });
  if (!b) { bad(`the back link is on the page at ${w}px`); continue; }
  (b.visible && b.inView) ? ok(`the back link is on screen at ${w}px`, `"${b.text}" at y${b.top}`)
                          : bad(`the back link is on screen at ${w}px`, JSON.stringify(b));
  b.clearsHero ? ok(`and does not collide with the hero at ${w}px`)
               : bad(`and does not collide with the hero at ${w}px`, `back ends ${b.bottom}, hero starts above it`);
}
await page.setViewportSize({ width: 1280, height: 1000 });

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

console.log('--- side by side on a phone too, by scrolling the row rather than shrinking it');
// The page stacked them here once, which hid the second award below the fold.
// The obvious alternative — a 50/50 split — was measured and is worse: at
// 390px it gives a 160px and a 130px card, and the embedded card does not
// reflow that far, so its countdown and alert get clipped. So: one row, near
// full-width columns, and the ROW scrolls. Three things have to hold together
// or that silently becomes a stack again, or a card too narrow to read.
await page.setViewportSize({ width: 390, height: 1000 });
await page.waitForTimeout(600);
const narrow = await page.evaluate(() => {
  const row = document.querySelector('.ballots');
  const b = [...document.querySelectorAll('.ballot')].map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.id, top: Math.round(r.top), left: Math.round(r.left),
             card: Math.round(el.querySelector('.ballot-frame').getBoundingClientRect().width) };
  });
  return { scrollW: Math.round(row.scrollWidth), clientW: Math.round(row.clientWidth),
           snap: getComputedStyle(row).scrollSnapType,
           hint: !!document.querySelector('.ballots-hint')
                 && getComputedStyle(document.querySelector('.ballots-hint')).display !== 'none', b };
});
(narrow.b.length === 2 && Math.abs(narrow.b[0].top - narrow.b[1].top) <= 2 && narrow.b[0].left !== narrow.b[1].left)
  ? ok('the two ballots sit on one row at 390px', `tops ${narrow.b.map((x) => x.top).join('/')}, lefts ${narrow.b.map((x) => x.left).join('/')}`)
  : bad('the two ballots sit on one row at 390px', JSON.stringify(narrow.b));
// Wide enough to read: below this the embedded card starts clipping its own
// content, which is the failure the stack was avoiding.
for (const x of narrow.b) {
  x.card >= 260 ? ok(`${x.id}: card still readable at 390px`, `${x.card}px`)
                : bad(`${x.id}: card still readable at 390px`, `${x.card}px — too narrow, it will clip`);
}
narrow.scrollW > narrow.clientW + 20
  ? ok('the row itself scrolls', `${narrow.scrollW} in ${narrow.clientW}`)
  : bad('the row itself scrolls', `${narrow.scrollW} in ${narrow.clientW} — the second ballot is unreachable`);
/x/.test(narrow.snap) ? ok('and snaps card to card', narrow.snap) : bad('and snaps card to card', narrow.snap);
narrow.hint ? ok('the swipe hint is shown') : bad('the swipe hint is shown', 'nothing tells you there is a second ballot');

await page.setViewportSize({ width: 1280, height: 1000 });
await page.waitForTimeout(500);
const wide = await page.evaluate(() => {
  const row = document.querySelector('.ballots');
  return { over: Math.round(row.scrollWidth - row.clientWidth),
           hint: getComputedStyle(document.querySelector('.ballots-hint')).display };
});
wide.over <= 2 ? ok('no scroller on a desktop') : bad('no scroller on a desktop', `${wide.over}px of overflow`);
wide.hint === 'none' ? ok('and no swipe hint there') : bad('and no swipe hint there', wide.hint);

console.log('--- and when a post IS pinned, the card shows the post itself');
// The card draws from constants, so the real post arrives afterwards: the
// embed fetches /api/mama-votes, and the oEmbed markup the server cached on
// that pin replaces our quoted copy. Three things have to be true, and none
// of them is visible until it actually runs:
//   * the post appears AND the quote goes away — showing both would read as
//     the post having been said twice,
//   * the buttons repoint from the search to today's post,
//   * nothing of X's javascript comes with it. That is the entire reason this
//     goes through oEmbed instead of widgets.js, and it is one grep.
{
  const PIN_URL = 'https://x.com/blinksunitedtwt/status/1234567890123456789';
  const OEMBED = '<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">'
    + 'I vote #BLACKPINK #2026MAMAVOTE — round 1 ends 22 Oct</p>&mdash; Blinks United '
    + `(@blinksunitedtwt) <a href="${PIN_URL}">October 18, 2026</a></blockquote>`;
  const p2 = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await p2.addInitScript(() => { try { localStorage.setItem('bu_tutorial_seen', '1'); } catch (e) {} });
  // Stand in for the live endpoint, which this local server does not serve.
  await p2.route('**/api/mama-votes*', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ day: '2026-10-18', today: 3, accounts: 9, votes: 12, days: [],
      pinned: { url: PIN_URL, id: '1234567890123456789', at: Date.now(), ageMs: 60000, html: OEMBED } }),
  }));
  await p2.goto(base + '/awards', { waitUntil: 'domcontentloaded' });
  const fr2 = () => p2.frames().find((f) => f.url().includes('card=mama'));
  let got = null;
  for (let i = 0; i < 60 && !got; i++) {
    await p2.waitForTimeout(500);
    got = await (fr2()?.evaluate(() => {
      const box = document.querySelector('#vc-embed-root .vote-repost');
      const slot = box && box.querySelector('.vote-repost-embed');
      if (!slot || slot.hidden || !slot.children.length) return null;
      const quote = box.querySelector('.vote-repost-post');
      return {
        text: slot.textContent.replace(/\s+/g, ' ').trim(),
        // Whether it is ON THE SCREEN, not whether the attribute is set. The
        // `hidden` attribute loses to any author `display` rule, so asking the
        // property passed happily while both copies were visible.
        quoteHidden: getComputedStyle(quote).display === 'none' || !quote.getClientRects().length,
        embedShown: getComputedStyle(slot).display !== 'none' && !!slot.getClientRects().length,
        head: box.querySelector('.vote-repost-head').textContent.trim(),
        btn: box.querySelector('a.vote-repost-btn').getAttribute('href'),
        scripts: document.querySelectorAll('script[src*="twitter"], script[src*="twimg"], script[src*="x.com"]').length,
        styled: getComputedStyle(slot.querySelector('blockquote')).borderLeftWidth,
      };
    }).catch(() => null) || Promise.resolve(null));
  }
  if (!got) bad('the pinned post replaces the quote', 'the embed never appeared');
  else {
    /I vote #BLACKPINK/.test(got.text) ? ok('the pinned post is rendered', got.text.slice(0, 70))
                                       : bad('the pinned post is rendered', got.text);
    got.embedShown ? ok('and the post is actually on the screen')
                   : bad('and the post is actually on the screen', 'the slot is filled but not displayed');
    got.quoteHidden ? ok('and our quoted copy is gone from the screen')
                    : bad('and our quoted copy is gone from the screen', 'both copies are visible');
    /Today/i.test(got.head) ? ok('and the heading says it is today’s', got.head)
                            : bad('and the heading says it is today’s', got.head);
    got.btn === PIN_URL ? ok('and the repost button goes to that post')
                        : bad('and the repost button goes to that post', got.btn);
    // The whole reason for the oEmbed route rather than the official widget.
    got.scripts === 0 ? ok('and nothing of X’s javascript was loaded')
                      : bad('and nothing of X’s javascript was loaded', `${got.scripts} script(s)`);
    parseFloat(got.styled) >= 1 ? ok('and the post is styled by us, not left bare', got.styled)
                                : bad('and the post is styled by us, not left bare', got.styled);
  }
  await p2.close();
}

await browser.close();
server.close();
console.log(`\nFAILURES: ${failures}`);
process.exit(failures ? 1 : 0);
