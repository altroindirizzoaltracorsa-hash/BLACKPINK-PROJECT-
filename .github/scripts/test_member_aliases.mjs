// /countdowns/<member> goes to whatever that member has next.
//
// Run: node .github/scripts/test_member_aliases.mjs
//
// WHY THIS EXISTS. Every slug here is the release's own address — jisoo.io is
// CLICK, lalisaofficial.com is PRESS PLAY, jenn.ie is Fallen Angel. Three of
// those read as an address. The fourth also reads as a NAME, so
// /countdowns/jenn.ie looks like "Jennie's countdown" and lands on an EP from
// August while the release she has coming sits under /countdowns/steps.
//
// The alias is resolved from the CARDS, never from a table of names to slugs,
// because a table is right the day it is written and silently wrong at the
// next release. That is the whole point, so the test has to prove the
// resolution follows the dates rather than a hardcoded answer — the second
// half of this file moves a card's date and demands the alias move with it.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };

const SPA = /^\/(countdowns|voting|vote|streams|charts|badges|leaderboard|account|feedback)(\/|$)/;
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/sw.js') { res.writeHead(404); res.end(''); return; }
  const file = p === '/' ? '/index.html' : SPA.test(p) ? '/index.html' : p;
  try {
    const b = await readFile(ROOT + file); const e = file.split('.').pop();
    res.writeHead(200, { 'content-type': { html: 'text/html', js: 'text/javascript', css: 'text/css',
      json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
      webp: 'image/webp', mp4: 'video/mp4' }[e] || 'application/octet-stream' });
    res.end(b);
  } catch { res.writeHead(404); res.end(''); }
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
await page.addInitScript(() => { try {
  localStorage.setItem('bu_tutorial_seen', '1');
  localStorage.setItem('ext_update_dismissed_1.9.8', '1');
} catch (e) {} });
const errs = [];
page.on('pageerror', e => errs.push(e.message));

// What the page shows for a path: which card is left visible, and what the
// address bar ends up reading.
async function open(path) {
  await page.goto(base + path, { waitUntil: 'domcontentloaded' });
  // ATTACHED, not visible: a deep link hides every card but one, so the first
  // in the DOM is usually the hidden one and waiting for it to be seen never
  // returns. Then wait for the filter to have actually run — one card visible
  // — which is the state the assertions below read.
  await page.locator('#home-countdowns .cd-card').first().waitFor({ state: 'attached', timeout: 20000 });
  await page.waitForFunction(() => typeof resolveCountdownSlug === 'function', { timeout: 20000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll('#home-countdowns .cd-card')]
            .some(c => c.getClientRects().length > 0), { timeout: 20000 });
  return page.evaluate(() => ({
    shown: [...document.querySelectorAll('#home-countdowns .cd-card')]
      .filter(c => c.style.display !== 'none').map(c => c.dataset.slug),
    url: location.pathname,
  }));
}

console.log('--- a member name lands on her live release');
{
  const r = await open('/countdowns/jennie');
  r.shown.length === 1 && r.shown[0] === 'steps'
    ? ok('/countdowns/jennie shows Someone to Hold', r.shown.join(', '))
    : bad('/countdowns/jennie shows Someone to Hold', `showed ${r.shown.join(', ') || 'nothing'}`);
  r.url === '/countdowns/steps'
    ? ok('and the address bar reads the card\'s own slug', r.url)
    : bad('and the address bar reads the card\'s own slug', `${r.url} — copying it would share a name, not a release`);
}
{
  // JISOO has no dated release ahead, but she does have one with no date
  // announced. "Nothing announced yet" is still ahead of "came out last week".
  const r = await open('/countdowns/jisoo');
  r.shown.length === 1 && r.shown[0] === 'sunshowers'
    ? ok('/countdowns/jisoo shows Sun Showers', 'undated but still to come, over a release already out')
    : bad('/countdowns/jisoo shows Sun Showers', `showed ${r.shown.join(', ') || 'nothing'}`);
}
{
  // LISA has only released ones, so the alias takes the most recent.
  const r = await open('/countdowns/lisa');
  r.shown.length === 1 && r.shown[0] === 'lalisaofficial.com'
    ? ok('/countdowns/lisa shows PRESS PLAY', 'her most recent, with nothing ahead')
    : bad('/countdowns/lisa shows PRESS PLAY', `showed ${r.shown.join(', ') || 'nothing'}`);
}
{
  const r = await open('/countdowns/rose');
  r.shown.length === 1 && r.shown[0] === 'newtrick'
    ? ok('/countdowns/rose shows new trick')
    : bad('/countdowns/rose shows new trick', `showed ${r.shown.join(', ') || 'nothing'}`);
}

console.log('\n--- and a real slug is never shadowed by a name');
{
  // The one that must NOT move. jenn.ie is Fallen Angel's address and it is
  // printed on every Fallen Angel share card already posted; an alias that
  // swallowed it would quietly change where those land.
  const r = await open('/countdowns/jenn.ie');
  r.shown.length === 1 && r.shown[0] === 'jenn.ie'
    ? ok('/countdowns/jenn.ie still shows Fallen Angel', 'the posted share cards still land where they did')
    : bad('/countdowns/jenn.ie still shows Fallen Angel', `showed ${r.shown.join(', ') || 'nothing'}`);
  r.url === '/countdowns/jenn.ie'
    ? ok('and is not rewritten')
    : bad('and is not rewritten', r.url);
}
{
  const r = await open('/countdowns/steps');
  r.shown.length === 1 && r.shown[0] === 'steps'
    ? ok('/countdowns/steps still shows Someone to Hold')
    : bad('/countdowns/steps still shows Someone to Hold', `showed ${r.shown.join(', ') || 'nothing'}`);
}

// THE PART THAT MATTERS IN SIX MONTHS. Everything above is also true of a
// hardcoded table, which is exactly what must not be written here. So: move a
// card's date and demand the alias follows it. This edits the live DOM rather
// than the file, so it tests the resolver's rule and nothing else.
// A RELEASE NAMED AFTER A MEMBER MUST STILL WIN. No card is slugged `jisoo`
// or `lisa` today, so the guard that enforces this cannot be falsified by the
// page as it stands — removing it leaves every check above green, which is
// how a dead guard survives review. The rule is real though: the day a single
// is slugged with a member's name, the alias must stand aside for it. So the
// case is manufactured, on the live DOM, rather than left unproven.
console.log('\n--- a release slugged with a member\'s name is not shadowed by the alias');
{
  await page.goto(base + '/countdowns', { waitUntil: 'domcontentloaded' });
  await page.locator('#home-countdowns .cd-card').first().waitFor({ state: 'attached', timeout: 20000 });
  await page.waitForFunction(() => typeof resolveCountdownSlug === 'function', { timeout: 20000 });
  const r = await page.evaluate(() => {
    const card = document.querySelector('[data-slug="newtrick"]');
    const kept = card.dataset.slug;
    card.dataset.slug = 'lisa';                 // a release that is called "lisa"
    const got = resolveCountdownSlug('lisa');
    card.dataset.slug = kept;
    return { got, restored: resolveCountdownSlug('lisa') };
  });
  r.got === 'lisa'
    ? ok('the card with that slug wins', 'the alias stands aside for a real release')
    : bad('the card with that slug wins', `resolved to ${r.got} — the name shadowed the release`);
  r.restored === 'lalisaofficial.com'
    ? ok('and the alias comes back when it is gone')
    : bad('and the alias comes back when it is gone', r.restored);
}

console.log('\n--- the alias follows the dates, not a list');
{
  await page.goto(base + '/countdowns', { waitUntil: 'domcontentloaded' });
  await page.locator("#home-countdowns .cd-card").first().waitFor({ state: "attached", timeout: 20000 });
  await page.waitForFunction(() => typeof resolveCountdownSlug === 'function', { timeout: 20000 });
  const moved = await page.evaluate(() => {
    const out = {};
    out.before = resolveCountdownSlug('jennie');
    // Someone to Hold comes out: its date moves into the past. YESTERDAY, not
    // some round date years ago — the first version of this used 2020, which
    // made Fallen Angel (August) genuinely her most recent release, and the
    // resolver was right to pick it. The check was wrong, not the rule.
    const steps = document.querySelector('[data-slug="steps"]');
    const kept  = steps.dataset.target;
    steps.dataset.target = new Date(Date.now() - 86400000).toISOString();
    out.afterRelease = resolveCountdownSlug('jennie');
    // And then she announces something new, dated ahead.
    const fa = document.querySelector('[data-slug="jenn.ie"]');
    const faKept = fa.dataset.target;
    fa.dataset.target = '2099-01-01T00:00:00Z';
    out.afterNext = resolveCountdownSlug('jennie');
    steps.dataset.target = kept; fa.dataset.target = faKept;
    out.restored = resolveCountdownSlug('jennie');
    return out;
  });
  moved.before === 'steps'
    ? ok('today it is Someone to Hold', moved.before)
    : bad('today it is Someone to Hold', moved.before);
  // Once it is out, the most recent release is still the right answer for a
  // member with nothing ahead — and Someone to Hold is then more recent than
  // Fallen Angel, so it stays.
  moved.afterRelease === 'steps'
    ? ok('after it is released it stays, as her most recent', moved.afterRelease)
    : bad('after it is released it stays, as her most recent', moved.afterRelease);
  moved.afterNext === 'jenn.ie'
    ? ok('and a newly dated release takes it over', 'the resolver read the date, not a list')
    : bad('and a newly dated release takes it over',
          `${moved.afterNext} — the alias is pinned to a slug somewhere instead of following the dates`);
  moved.restored === 'steps'
    ? ok('and the page is as it was')
    : bad('and the page is as it was', moved.restored);
}

console.log('\n--- and nothing threw');
errs.length === 0 ? ok('no page errors') : bad('no page errors', errs.slice(0, 3).join(' | '));

await page.close();
await browser.close();
server.close();
console.log(fails ? `\n${fails} FAILED` : '\nAll correct.');
process.exit(fails ? 1 : 0);
