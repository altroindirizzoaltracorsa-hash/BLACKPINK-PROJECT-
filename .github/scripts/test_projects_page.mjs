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
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

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
// card name -> the ?award= it must carry, and the tab label that must come up.
const BALLOTS = [
  ['BreakTudo Awards 2026', 'breaktudo', 'BreakTudo'],
  ['2026 MAMA Awards', 'mama', 'MAMA'],
  ['2026 Kids’ Choice Awards', 'kca', 'Kids’ Choice'],
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

console.log('--- every link resolves');
for (const c of cards) {
  if (!c.href || /^https?:/.test(c.href)) continue;
  const r = await page.request.get(base + c.href);
  r.ok() ? ok(`${c.name} → ${c.href}`) : bad(`${c.name} → ${c.href}`, `HTTP ${r.status()}`);
}
await page.close();

console.log('--- each voting card opens ITS ballot, not the default one');
for (const [name, award, label] of BALLOTS) {
  const card = cards.find((c) => c.name === name);
  if (!card || !card.href) { bad(`${name} has a link`); continue; }
  if (!card.href.includes('award=' + award)) { bad(`${name} carries award=${award}`, card.href); continue; }
  const { page: vp } = await open(card.href);
  let active;
  try {
    // .vv-awardsw-btn is rendered once the board loads; aria-selected marks the
    // live one. Its absence is a failure, not "nothing to assert" — a selector
    // that matches nothing is how this check first passed while pointing at the
    // wrong element entirely.
    await vp.waitForSelector('.vv-awardsw-btn', { timeout: 20000 });
    active = await vp.evaluate(() => {
      const on = document.querySelector('.vv-awardsw-btn[aria-selected="true"]');
      return on ? on.textContent.trim() : '(none selected)';
    });
  } catch { active = '(no award switch rendered)'; }
  active.includes(label) ? ok(`${card.href} opens ${label}`) : bad(`${card.href} opens "${active}"`, `expected ${label}`);
  await vp.close();
}

await browser.close();
server.close();
console.log(`\nFAILURES: ${failures}`);
process.exit(failures ? 1 : 0);
