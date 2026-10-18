// Drive the REAL projects.html in a browser and check the board is honest.
//
// Run: node .github/scripts/test_projects_page.mjs
//
// Three things go wrong with a hand-maintained project list, and all three are
// invisible on the page itself:
//   * a finished campaign still sitting under Current (or the reverse),
//   * a card pointing at a page that no longer resolves,
//   * a voting card whose link opens the WRONG ballot — /voting defaults to
//     whichever closes soonest, so a card can name MAMA and land on BreakTudo.
// The routes are served the way vercel.json rewrites them, so the links are
// followed exactly as production would.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const SPA = /^\/(countdowns|badges|leaderboard|voting|vote|feedback|account|streams|charts|apple-charts|itunes-charts|spotify-charts|youtube|kcharts|ltal-embed)(\/|$)/;
const PAGES = { '/projects': '/projects.html', '/vmas': '/vmas.html',
                '/breaktudo': '/breaktudo.html', '/achievements': '/achievements.html' };

// name -> where it must be. null means it must NOT be its own card.
const WANT = [
  ['JUMP → 1B', 'current'], ['Shut Down → 1B', 'current'], ['DDU-DU DDU-DU → 1B', 'current'],
  ['GO → 200M', 'current'], ['FALLEN ANGEL — EP Release', 'current'],
  ['CLICK — Single Release', 'current'], ['SaWaDiKa — Single Release', 'current'],
  ['new trick — Single Release', 'current'], ['PRESS PLAY — EP Release', 'current'],
  ['BreakTudo Awards 2026', 'current'], ['2026 MAMA Awards', 'current'],
  ['2026 Kids’ Choice Awards', 'current'],
  ['MTV VMAs 2026', 'past'], ['Less Than a Lover — Release', 'past'],
  // GO's 100M is carried inside the GO card now, not filed as a second entry.
  ['GO → 100M', null],
];

const server = createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  const file = PAGES[p] || (p === '/' ? '/projects.html' : SPA.test(p) ? '/index.html' : p);
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
const ok = (msg, detail) => console.log(`  ok   ${msg}${detail ? ` (${detail})` : ''}`);
const bad = (msg, detail) => { failures++; console.log(`  FAIL ${msg}${detail ? ` (${detail})` : ''}`); };

const browser = await chromium.launch();
async function open(path) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  // The first-visit tutorial covers the page; mark it seen before scripts run.
  await page.addInitScript(() => { try { localStorage.setItem('bu_tutorial_seen', '1'); } catch (e) {} });
  await page.goto(base + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  return { page, errs };
}

console.log('--- the board');
const { page, errs } = await open('/projects');
const cards = await page.evaluate(() => [...document.querySelectorAll('.card')].map((c) => ({
  name: c.querySelector('.card-name').textContent,
  status: c.querySelector('.pill.current') ? 'current' : 'past',
  grid: (c.closest('[id]') || {}).id,
  period: (c.querySelector('.card-period') || {}).textContent || '',
  href: c.querySelector('a.card-link') ? c.querySelector('a.card-link').getAttribute('href') : null,
})));
for (const [name, status] of WANT) {
  const hit = cards.filter((c) => c.name === name);
  if (status === null) {
    hit.length ? bad(`"${name}" should no longer be its own card`) : ok(`"${name}" is not a separate card`);
    continue;
  }
  if (hit.length !== 1) { bad(`exactly one "${name}"`, `found ${hit.length}`); continue; }
  const want = status === 'current' ? 'current-grid' : 'past-grid';
  if (hit[0].status === status && hit[0].grid === want) ok(`"${name}" is ${status}`, hit[0].period.trim());
  else bad(`"${name}" is ${hit[0].status} in ${hit[0].grid}`, `expected ${status} in ${want}`);
}
if (errs.length) bad('no page errors', errs.join(' | ')); else ok('no page errors', 'none');

console.log('--- any weekday a card names matches its date');
// Writing "Fri 17 Oct" when the 17th is a Saturday is invisible on the page and
// wrong in the one place a reader trusts. (It shipped once, for BreakTudo.)
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
let dated = 0;
for (const c of cards) {
  const m = c.period.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/);
  if (!m) continue;
  dated++;
  const [, dow, day, mon] = m;
  // No year on the card: take whichever of this year or next puts the date
  // nearest to today, which is what a reader assumes too.
  const now = new Date();
  const cand = [now.getFullYear(), now.getFullYear() + 1, now.getFullYear() - 1]
    .map((y) => new Date(Date.UTC(y, MONTHS.indexOf(mon), +day)))
    .sort((a, b) => Math.abs(a - now) - Math.abs(b - now))[0];
  const real = DAYS[cand.getUTCDay()];
  real === dow
    ? ok(`${c.name}: ${dow} ${day} ${mon}`, cand.toISOString().slice(0, 10))
    : bad(`${c.name} says ${dow} ${day} ${mon}`, `${cand.toISOString().slice(0, 10)} is a ${real}`);
}
if (!dated) ok('no card names a weekday', 'nothing to check');

console.log('--- every link resolves');
for (const c of cards) {
  if (!c.href || /^https?:/.test(c.href)) continue;
  const r = await page.request.get(base + c.href);
  r.ok() ? ok(`${c.name} → ${c.href}`) : bad(`${c.name} → ${c.href}`, `HTTP ${r.status()}`);
}
await page.close();

console.log('--- every card that links to a ballot opens THAT ballot');
// Derived from the cards themselves rather than a list kept here: a campaign
// that closes and stops linking to /voting (BreakTudo now points at its own
// archive) drops out by itself, instead of failing a check that was only ever
// describing last month's board.
const ballotCards = cards.filter((c) => c.href && c.href.startsWith('/voting') && c.href.includes('award='));
if (!ballotCards.length) ok('no card links to a ballot', 'nothing to check');
for (const card of ballotCards) {
  const award = new URLSearchParams(card.href.split('?')[1]).get('award');
  const { page: vp } = await open(card.href);
  let active, expected;
  try {
    // .vv-awardsw-btn is rendered once the board loads; aria-selected marks
    // the live one. Its absence is a failure, not "nothing to assert" — a
    // selector that matches nothing is how this check first passed while
    // pointing at the wrong element entirely.
    await vp.waitForSelector('.vv-awardsw-btn', { timeout: 20000 });
    [active, expected] = await vp.evaluate((a) => {
      const on = document.querySelector('.vv-awardsw-btn[aria-selected="true"]');
      // The expected label comes from the page's own _vvAwardMeta, so this
      // never has to be re-typed when a tab is renamed.
      const meta = (typeof _vvAwardMeta !== 'undefined' && _vvAwardMeta[a]) ? _vvAwardMeta[a].label : null;
      return [on ? on.textContent.trim() : '(none selected)', meta];
    }, award);
  } catch { active = '(no award switch rendered)'; expected = null; }
  if (!expected) { bad(`${card.name}: "${award}" is a known award`); await vp.close(); continue; }
  active.includes(expected) ? ok(`${card.name} \u2192 ${card.href} opens ${expected}`)
                            : bad(`${card.name} \u2192 ${card.href} opened "${active}"`, `expected ${expected}`);
  await vp.close();
}

await browser.close();
server.close();
console.log(`\nFAILURES: ${failures}`);
process.exit(failures ? 1 : 0);
