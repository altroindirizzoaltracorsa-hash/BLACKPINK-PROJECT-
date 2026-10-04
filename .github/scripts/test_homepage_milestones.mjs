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
check(await page.locator('nav').first().isVisible(), 'the nav stays — it is site chrome, not homepage content');
check((await page.locator('#ytm-toggle-label').textContent()).includes('Back'), 'the button becomes the way back');

console.log('\n--- the board rendered from the API');
const secs = await page.locator('.ytm-sec-label').allTextContents();
check(secs.length === 2 && secs[0].includes('BLACKPINK') && secs[1].includes('Members'),
      `split into BLACKPINK then Members (${secs.map(t=>t.trim()).join(' | ')})`);
check(await page.locator('.ytm-card').count() === 4, 'four cards');
const firstArt = await page.locator('.ytm-sec').first().locator('.ytm-art').count();
check(firstArt === 0, 'no artist line under the BLACKPINK cards — the heading already says it');
const memberArts = await page.locator('.ytm-sec').nth(1).locator('.ytm-art').allTextContents();
check(memberArts.join(',') === 'LISA,JENNIE', `members are named (${memberArts.join(', ')})`);
const basis = await page.locator('#ytm-basis').textContent();
check(/Nearest first/.test(basis) && /no dates yet/.test(basis),
      `the basis line explains why there are no ETAs: "${basis.trim().slice(0,70)}…"`);
check((await page.locator('.ytm-eta').count()) === 0, 'and no card claims an ETA');

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
