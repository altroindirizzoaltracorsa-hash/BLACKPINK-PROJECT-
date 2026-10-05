// Drive the real index.html and prove the two YouTube pages are distinct.
//
// Run: node .github/scripts/test_youtube_views_page.mjs
//
// /youtube now serves the view-milestone board and /youtube-charts serves the
// chart positions that used to be at /youtube. Getting that backwards is the
// whole risk of this change, so both URLs are asserted in both directions.
// page.route() serves the real file at the real hostname so the absolute
// /api path resolves without DNS.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const INDEX = new URL('../../index.html', import.meta.url).pathname;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
let fails = [];
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails.push(m); };

const mk = (artist, title, kind, views, next, gap, pct) =>
  ({ videoId: title.slice(0,6).replace(/\W/g,'x'), title, artist, kind, views, next, gap, pct, rate:null, days:null, eta:null });
const BOARD = {
  asOf: '2026-10-05', sortedBy: 'gap', hasRates: false, counts: { total: 6, shown: 6 },
  blackpink: [
    mk('BLACKPINK', "BLACKPINK - 'GO' M/V", 'mv', 96819143, 100000000, 3180857, 96.8),
    mk('BLACKPINK', "BLACKPINK - DANCE PRACTICE VIDEO", 'performance', 95211052, 100000000, 4788948, 95.2),
  ],
  members: [
    mk('LISA',   "LISA - SaWaDiKa (Official Music Video)", 'mv', 196556674, 200000000, 3443326, 96.6),
    mk('JENNIE', "JENNIE - like JENNIE (Official Video)", 'mv', 294699326, 300000000, 5300674, 94.7),
    mk('ROSÉ',   "ROSÉ - 'On The Ground' M/V", 'mv', 394299743, 400000000, 5700257, 94.3),
    mk('JISOO',  "JISOO - 'FLOWER' M/V", 'mv', 661677117, 700000000, 38322883, 61.7),
  ],
};

const p = await b.newPage({ viewport: { width: 1280, height: 950 }, deviceScaleFactor: 2 });
const errs = []; p.on('pageerror', e => errs.push(String(e)));
await p.route('**/*', async route => {
  const u = new URL(route.request().url());
  if (u.pathname === '/youtube' || u.pathname === '/' || u.pathname === '/youtube-charts')
    return route.fulfill({ path: INDEX, contentType: 'text/html' });
  if (u.pathname === '/api/youtube-milestones')
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(BOARD) });
  if (u.hostname.includes('fonts.g')) return route.continue();
  return route.fulfill({ status: 204, body: '' });
});

console.log('--- /youtube now serves the VIEWS page, not charts');
await p.goto('https://www.blinksunited.com/youtube', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2500);
await p.evaluate(() => { try { closeTutorial(); } catch {}
  document.getElementById('tutorial-overlay')?.remove();
  document.getElementById('ext-update-overlay')?.remove(); });
check(await p.locator('#page-ytviews').isVisible(), '#page-ytviews is the active page');
check(!(await p.locator('#page-youtube').isVisible()), 'and the charts page is NOT showing');
check((await p.title()).includes('YouTube Views'), `title says views (${await p.title()})`);

console.log('\n--- /youtube-charts still serves the charts page');
await p.goto('https://www.blinksunited.com/youtube-charts', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2000);
check(await p.locator('#page-youtube').isVisible(), 'charts page is active at its new URL');
check(!(await p.locator('#page-ytviews').isVisible()), 'and views is not');
check((await p.title()).includes('YouTube Charts'), `title says charts (${await p.title()})`);

console.log('\n--- the board on /youtube');
await p.goto('https://www.blinksunited.com/youtube', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2500);
await p.evaluate(() => { document.getElementById('tutorial-overlay')?.remove(); document.getElementById('ext-update-overlay')?.remove(); });
check(await p.locator('#ytv-sections .ytm-card').count() === 6, `all 6 render, not a preview (${await p.locator('#ytv-sections .ytm-card').count()})`);
const secs = await p.locator('#ytv-sections .ytm-sec-label').allTextContents();
check(secs.length === 2 && secs[0].includes('BLACKPINK') && secs[1].includes('Members'), `split as on the homepage (${secs.map(t=>t.trim()).join(' | ')})`);
const basis = await p.locator('#ytv-basis').textContent();
check(/no dates yet/.test(basis), 'the basis line explains the missing dates');

console.log('\n--- the artist filter');
const chips = await p.locator('#ytv-filters .ytv-chip').allTextContents();
check(chips.length === 6, `a chip per artist present, plus All (${chips.map(c=>c.trim()).join(', ')})`);
await p.locator('#ytv-filters .ytv-chip', { hasText: 'JENNIE' }).click();
await p.waitForTimeout(300);
check(await p.locator('#ytv-sections .ytm-card').count() === 1, 'filtering to JENNIE leaves one card');
check((await p.locator('#ytv-sections .ytm-sec-label').count()) === 1, 'and only the Members heading');
await p.locator('#ytv-filters .ytv-chip').first().click();
await p.waitForTimeout(300);
check(await p.locator('#ytv-sections .ytm-card').count() === 6, 'All restores everything');

console.log('\n--- the players work here too');
await p.locator('#ytv-sections .ytm-thumb').first().click();
await p.waitForTimeout(500);
check(await p.locator('#ytv-sections iframe[src*="youtube-nocookie"]').count() === 1, 'a card plays');
await p.locator('#ytv-filters .ytv-chip', { hasText: 'LISA' }).click();
await p.waitForTimeout(400);
check(await p.locator('iframe[src*="youtube"]').count() === 0, 'and changing the filter stops it rather than orphaning an invisible player');

console.log('\n--- the nav');
// The real nav collapses to a hamburger well before 1280px, so the desktop
// links are not clickable at the width used above.
await p.setViewportSize({ width: 1700, height: 950 });
await p.goto('https://www.blinksunited.com/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2200);
await p.evaluate(() => { document.getElementById('tutorial-overlay')?.remove(); document.getElementById('ext-update-overlay')?.remove(); });
check((await p.locator('#nav-streams').textContent()).includes('Streams & Views'), 'Streams is now "Streams & Views"');
const items = await p.locator('#streams-dropdown-panel .nav-dropdown-item').allTextContents();
check(items.join(' | ') === 'Spotify Streams | YouTube Views', `with two entries (${items.join(' | ')})`);
check(await p.locator('#nav-ytviews').getAttribute('href') === '/youtube', 'YouTube Views points at /youtube');
check(await p.locator('#nav-youtube').getAttribute('href') === '/youtube-charts', 'YouTube Charts points at /youtube-charts');
// only one dropdown open at a time
await p.locator('#nav-charts').click(); await p.waitForTimeout(200);
await p.locator('#nav-streams').click(); await p.waitForTimeout(200);
const open = await p.locator('.nav-has-dropdown.open').count();
check(open === 1, `opening one dropdown closes the other (${open} open)`);

check(errs.length === 0, `no page errors (${errs.slice(0,2).join(' / ') || 'none'})`);
await p.goto('https://www.blinksunited.com/youtube', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2500);
await p.evaluate(() => { document.getElementById('tutorial-overlay')?.remove(); document.getElementById('ext-update-overlay')?.remove(); });
await p.close(); await b.close();
console.log(`\nFAILURES: ${fails.length}`); fails.forEach(f => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
