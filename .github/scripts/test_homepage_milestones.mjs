// Drive the REAL index.html in a browser and prove the YouTube milestone
// toggle works end to end.
//
// Run: node .github/scripts/test_homepage_milestones.mjs
//
// page.route() serves the real file at the real hostname, so the absolute
// /api/... path resolves without DNS, and the API is stubbed with the exact
// shape production returns today — one reading, so no rates and no ETAs.
// That no-rates state is the one the page actually has to render right now,
// which is why it is the fixture rather than a hypothetical finished board.
//
// The site shows a first-visit tutorial and an extension-update dialog that
// intercept clicks; both are dismissed the way a visitor would.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const INDEX = new URL('../../index.html', import.meta.url).pathname;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
let fails = [];
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails.push(m); };

// The real board shape, with the field values production returned today.
const BOARD = {
  asOf: '2026-10-04', sortedBy: 'gap', hasRates: false,
  counts: { total: 64, shown: 12 },
  blackpink: [
    { videoId:'a1', title:"BLACKPINK - '휘파람(WHISTLE)' DANCE PRACTICE VIDEO", artist:'BLACKPINK', kind:'performance', views:196903773, next:200000000, gap:3096227, pct:96.9, rate:null, days:null, eta:null },
    { videoId:'a2', title:"BLACKPINK - ‘GO’ M/V", artist:'BLACKPINK', kind:'mv', views:96819143, next:100000000, gap:3180857, pct:96.8, rate:null, days:null, eta:null },
  ],
  members: [
    { videoId:'b1', title:"LISA - SaWaDiKa (Official Music Video)", artist:'LISA', kind:'mv', views:196556674, next:200000000, gap:3443326, pct:96.5, rate:null, days:null, eta:null },
    { videoId:'b2', title:"JENNIE - 'SOLO' M/V", artist:'JENNIE', kind:'mv', views:1090872860, next:1100000000, gap:9127140, pct:90.8, rate:null, days:null, eta:null },
  ],
};

const page = await b.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
// Serve the real file at the real hostname so absolute /api paths resolve.
await page.route('**/*', async route => {
  const u = new URL(route.request().url());
  if (u.pathname === '/' || u.pathname === '/index.html')
    return route.fulfill({ path: INDEX, contentType: 'text/html' });
  if (u.pathname === '/api/youtube-milestones')
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(BOARD) });
  if (u.hostname.includes('ytimg')) return route.fulfill({ status: 404, body: '' });
  if (u.hostname.includes('fonts.g') || u.pathname.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  return route.fulfill({ status: 204, body: '' });
});
await page.goto('https://blinksunited.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
// The site shows a first-visit tutorial overlay; dismiss it the way a visitor
// would, otherwise it intercepts every click.
const dismiss = async p => { await p.evaluate(() => {
  try { closeTutorial(); } catch {}
  document.getElementById('tutorial-overlay')?.remove();
  document.getElementById('ext-update-overlay')?.remove();
}); };
await dismiss(page);

console.log('--- the homepage is unchanged until asked');
check(await page.locator('#ytm-toggle').isVisible(), 'the toggle is present');
check(!(await page.locator('#ytm-panel').isVisible()), 'and the panel is closed');
check(await page.locator('#home-countdowns').isVisible(), 'countdowns are visible');
check(await page.locator('.hero-cta').isVisible(), 'so are the hero CTAs');

console.log('\n--- opening it');
await page.locator('#ytm-toggle').click();
await page.waitForTimeout(900);
check(await page.locator('#ytm-panel').isVisible(), 'the panel opens');
check(!(await page.locator('#home-countdowns').isVisible()), 'countdowns are gone');
check(!(await page.locator('.hero-cta').isVisible()), 'hero CTAs are gone');
check(!(await page.locator('#songs').isVisible()), 'Our Targets is gone');

// The hero carries more than the CTAs and the countdowns: the scrobble goal
// bar and today's playlist are plain divs beside them, and an earlier rule
// that named ids missed both. These are forced visible first, because both
// ship with an inline display:none that JS clears only under conditions the
// stub does not meet — so without this they would "pass" by being hidden for
// the wrong reason.
await page.evaluate(() => {
  for (const id of ['community-goal-home', 'todays-playlist-home'])
    document.getElementById(id)?.style.setProperty('display', 'block');
});
await page.waitForTimeout(100);
check(!(await page.locator('#community-goal-home').isVisible()),
      'the scrobble goal bar is gone even when forced visible');
check(!(await page.locator('#todays-playlist-home').isVisible()),
      "and so is today's playlist");

// The real guard: the rule names what to KEEP, so a block nobody has written
// yet is hidden too. An id list could never promise this.
const strayHidden = await page.evaluate(() => {
  const el = document.createElement('div');
  el.id = 'a-block-invented-after-this-rule-was-written';
  el.textContent = 'future homepage thing';
  document.querySelector('.hero-content').appendChild(el);
  const hidden = getComputedStyle(el).display === 'none';
  el.remove();
  return hidden;
});
check(strayHidden, 'and so is a brand-new hero block the rule has never seen');
check(await page.locator('nav').first().isVisible(), 'the nav stays — it is site chrome, not homepage content');
check((await page.locator('#ytm-toggle-label').textContent()).includes('Back'), 'the button becomes the way back');

console.log('\n--- the board rendered from the API');
const secs = await page.locator('.ytm-sec-label').allTextContents();
check(secs.length === 2 && secs[0].includes('BLACKPINK') && secs[1].includes('Members'),
      `split into BLACKPINK then Members (${secs.map(t=>t.trim()).join(' | ')})`);
check(await page.locator('.ytm-card').count() === 4, 'four cards');
// vs.html always carries a line under the title. On the BLACKPINK cards it
// holds the kind rather than repeating the heading; on the members' it names
// them. Either way it is never empty and never redundant.
const bpArts = await page.locator('.ytm-sec').first().locator('.ytm-art').allTextContents();
check(bpArts.every(t => t.trim() && !t.includes('BLACKPINK')),
      `BLACKPINK cards show the kind, not the heading again (${bpArts.join(' | ')})`);
const memberArts = await page.locator('.ytm-sec').nth(1).locator('.ytm-art').allTextContents();
check(memberArts.every(t => /^(LISA|JENNIE|ROSÉ|JISOO) · /.test(t.trim())),
      `members are named, then the kind (${memberArts.join(' | ')})`);
const basis = await page.locator('#ytm-basis').textContent();
check(/Nearest first/.test(basis) && /no dates yet/.test(basis),
      `the basis line explains why there are no ETAs: "${basis.trim().slice(0,70)}…"`);
const labels = await page.locator('.ytm-lbl').allTextContents();
check(!labels.some(t => /gets there/i.test(t)), 'and no card claims when it gets there');

console.log('\n--- the embed is a facade until clicked');
check(await page.locator('iframe[src*="youtube"]').count() === 0,
      'no YouTube iframe exists before anyone presses play');
check(await page.locator('.ytm-thumb').first().isVisible(), 'the thumbnail is the play button');

await page.locator('.ytm-card').first().locator('.ytm-thumb').click();
await page.waitForTimeout(500);
const frames = page.locator('.ytm-card.playing iframe');
check(await frames.count() === 1, 'clicking it builds exactly one player');
const src = await frames.first().getAttribute('src');
check(src.includes('youtube-nocookie.com/embed/'),
      'on youtube-nocookie, so a visitor who never plays gets no cookie from us');
check(src.includes('autoplay=1'), 'and autoplays — the click is the gesture');

// A second player is the bug worth guarding: two soundtracks at once, and the
// first one left running invisibly behind the card that replaced it.
await page.locator('.ytm-card').nth(1).locator('.ytm-thumb').click();
await page.waitForTimeout(500);
check(await page.locator('iframe[src*="youtube"]').count() === 1,
      'playing a second video stops the first — only ever one player');
check(await page.locator('.ytm-card.playing').count() === 1, 'and only one card is in the playing state');

await page.locator('.ytm-card.playing .ytm-stop').click();
await page.waitForTimeout(400);
check(await page.locator('iframe[src*="youtube"]').count() === 0,
      'Stop removes the iframe rather than hiding it — a hidden iframe keeps playing');

await page.locator('.ytm-card').first().locator('.ytm-thumb').click();
await page.waitForTimeout(400);
await page.locator('#ytm-toggle').click();     // back to the homepage
await page.waitForTimeout(500);
check(await page.locator('iframe[src*="youtube"]').count() === 0,
      'and leaving the view stops it too — audio must not follow you to the homepage');
await page.locator('#ytm-toggle').click();
await page.waitForTimeout(600);

console.log('\n--- the /vs.html idiom');
const style = await page.evaluate(() => {
  const card = document.querySelector('.ytm-card');
  const thumb = document.querySelector('.ytm-thumb');
  const stat = document.querySelector('.ytm-stat');
  const watch = document.querySelector('.ytm-watch');
  const cs = getComputedStyle;
  return {
    cardRadius: cs(card).borderTopLeftRadius, cardPad: cs(card).paddingTop,
    thumbRadius: cs(thumb).borderTopLeftRadius,
    statBorder: cs(stat).borderTopStyle,
    watchRadius: parseFloat(cs(watch).borderTopLeftRadius),
    panelPink: cs(document.getElementById('ytm-panel')).getPropertyValue('--v-pink').trim(),
    bodyPink: cs(document.body).getPropertyValue('--v-pink').trim(),
  };
});
check(style.cardRadius === '16px' && style.cardPad === '14px',
      `card is vs.html's 16px radius / 14px padding (${style.cardRadius}, ${style.cardPad})`);
check(style.thumbRadius === '10px', `thumbnail is its 10px radius (${style.thumbRadius})`);
check(style.statBorder === 'dashed', 'stat rows use its dashed rule');
check(style.watchRadius >= 99, `the watch link is its pill (${style.watchRadius}px)`);
check(style.panelPink === '#ff2e77', `vs.html's pink is in scope inside the panel (${style.panelPink})`);
check(style.bodyPink === '', 'and does not leak onto the rest of the homepage');

console.log('\n--- it survives a reload, and does not leak to other pages');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
await dismiss(page);
check(await page.locator('#ytm-panel').isVisible(), 'still open after reload');
await page.evaluate(() => showPage('badges'));
await page.waitForTimeout(600);
const leaked = await page.evaluate(() => document.body.classList.contains('ytm-mode'));
check(leaked === false, 'body.ytm-mode is dropped on leaving home — it would hide other pages');
await page.evaluate(() => showPage('home'));
await page.waitForTimeout(600);
check(await page.locator('#home-countdowns').isVisible(), 'and home comes back intact');

console.log('\n--- mobile');
const m = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
m.on('pageerror', e => errs.push(String(e)));
await m.route('**/*', async route => {
  const u = new URL(route.request().url());
  if (u.pathname === '/' ) return route.fulfill({ path: INDEX, contentType: 'text/html' });
  if (u.pathname === '/api/youtube-milestones') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(BOARD) });
  return route.fulfill({ status: 204, body: '' });
});
await m.goto('https://blinksunited.com/', { waitUntil: 'domcontentloaded' });
await m.waitForTimeout(2200);
await dismiss(m);
await m.locator('#ytm-toggle').click();
await m.waitForTimeout(800);
const cols = await m.evaluate(() => {
  const g = document.querySelector('.ytm-grid');
  return new Set([...g.children].map(c => Math.round(c.getBoundingClientRect().left))).size;
});
check(cols === 1, `one card per row on a phone (${cols})`);
const sw = await m.evaluate(() => document.documentElement.scrollWidth);
check(sw <= 391, `no horizontal scroll (${sw})`);
await m.close();

check(errs.length === 0, `no page errors (${errs.slice(0,2).join(' / ') || 'none'})`);
await page.close(); await b.close();
console.log(`\nFAILURES: ${fails.length}`);
fails.forEach(f => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
