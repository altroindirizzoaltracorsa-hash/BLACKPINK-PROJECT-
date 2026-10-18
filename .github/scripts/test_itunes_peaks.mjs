// Drive the REAL /itunes-charts in a browser and prove the "peak" column works.
//
// Run: node .github/scripts/test_itunes_peaks.mjs
//
// The peak for each row is looked up in itunes-chart-peaks.json by a key the
// READER builds and compute_itunes_peaks.mjs WRITES — two expressions in two
// files that have to stay identical. They drifted: the reader fell back to ''
// where the writer falls back to `name__artists`, and since the kworb scraper
// never emits an appleId, every lookup missed and every row showed "—" in
// every country. Nothing errored, so nothing noticed.
//
// So this does not test the expression, it tests the OUTCOME: real data in,
// real peaks rendered out. Both feeds come from GitHub raw in production and
// are served here from the repo's own files.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const SPA = /^\/(itunes-charts|charts|apple-charts|spotify-charts|countdowns|streams|voting)(\/|$)/;

const server = createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  const file = p === '/' || SPA.test(p) ? '/index.html' : p;
  try {
    const buf = await readFile(ROOT + file);
    const ext = file.split('.').pop();
    res.writeHead(200, { 'content-type': { html: 'text/html', js: 'text/javascript', css: 'text/css',
      json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
      webp: 'image/webp' }[ext] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end(''); }
});
await new Promise((r) => server.listen(0, r));

// A skip and a pass both exit 0, so from the Actions tab they look identical —
// and a check that quietly stops verifying is worse than one that fails. Put
// the verdict in the run summary, where it is readable without the log.
async function summarise(line) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (!f) return;
  const { appendFile } = await import('node:fs/promises');
  await appendFile(f, `**iTunes peak column** — ${line}\n`);
}

let failures = 0;
const ok = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { failures++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };

const positions = JSON.parse(await readFile(`${ROOT}/data/itunes-chart-positions-latest.json`, 'utf8'));
const peaks = JSON.parse(await readFile(`${ROOT}/data/itunes-chart-peaks.json`, 'utf8'));

// What the page SHOULD be able to show, worked out from the data alone — if
// this is zero the fixtures are stale and the browser result proves nothing.
let expected = 0;
for (const [cc, region] of Object.entries(positions.regions ?? {})) {
  for (const h of region.hits ?? []) {
    const key = h.appleId ?? `${h.name}__${h.artists}`;
    if (peaks.byCountry?.[cc]?.[key]?.bestPosition != null) expected++;
  }
}
console.log('--- the data');
if (expected > 0) {
  ok("today's chart rows that have a recorded peak", `${expected}`);
} else {
  // Legitimately possible: a day where every charting row is new enough to
  // have no peak on record yet. Nothing is broken and nothing can be proved,
  // so this reports and stops rather than going red in CI for no reason.
  console.log('  SKIP today\'s rows have no peak on record — nothing to verify today');
  console.log('\nFAILURES: 0 (skipped)');
  await summarise('SKIPPED — no row on today\'s chart has a peak on record, so nothing could be verified');
  server.close();
  process.exit(0);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
await page.addInitScript(() => { try { localStorage.setItem('bu_tutorial_seen', '1'); } catch (e) {} });
await page.route('**/raw.githubusercontent.com/**', async (route) => {
  const u = route.request().url();
  const f = u.includes('itunes-chart-peaks') ? 'data/itunes-chart-peaks.json'
    : u.includes('itunes-chart-positions-latest') ? 'data/itunes-chart-positions-latest.json' : null;
  if (!f) return route.abort();
  route.fulfill({ status: 200, contentType: 'application/json', body: await readFile(`${ROOT}/${f}`, 'utf8') });
});
await page.goto(`http://127.0.0.1:${server.address().port}/itunes-charts`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

// The page opens with no country chosen and renders a region's table only
// once one is picked, so pick the country that has the most rows WITH a
// recorded peak — otherwise an empty column proves nothing either way.
const best = Object.entries(positions.regions ?? {})
  .map(([cc, region]) => [cc, (region.hits ?? []).filter((h) =>
    peaks.byCountry?.[cc]?.[h.appleId ?? `${h.name}__${h.artists}`]?.bestPosition != null).length])
  .sort((a, b) => b[1] - a[1])[0];
console.log(`--- the rendered table for "${best[0]}" (${best[1]} of its rows have a peak on record)`);
await page.evaluate((cc) => setItunesCountry(cc), best[0]);
await page.waitForTimeout(800);
const cells = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('table tr')].filter((r) => r.querySelector('.as-rank-col'));
  return rows.map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent.trim()));
});
if (!cells.length) { bad('the chart table rendered', 'no rows'); }
else {
  ok('the chart table rendered', `${cells.length} rows`);
  // A peak cell is "#<n>" or the em-dash placeholder.
  // The Peak column, by its position in this table's own header row.
  const peakIdx = await page.evaluate(() => {
    const table = [...document.querySelectorAll('table')].find((t) =>
      [...t.querySelectorAll('th')].some((h) => h.textContent.trim() === 'Peak'));
    return table ? [...table.querySelectorAll('th')].findIndex((h) => h.textContent.trim() === 'Peak') : -1;
  });
  if (peakIdx < 0) bad('the table has a Peak column');
  else ok('the table has a Peak column', `column ${peakIdx}`);
  const peakCells = cells.map((r) => r[peakIdx]).filter((c) => c != null);
  const withPeak = peakCells.filter((c) => /^#\d+$/.test(c));
  if (withPeak.length > 0) {
    ok('rows showing a real peak rather than "—"', `${withPeak.length}/${peakCells.length}: ${withPeak.slice(0, 6).join(' ')}`);
    await summarise(`verified — ${withPeak.length}/${peakCells.length} rows in "${best[0]}" show a peak (${withPeak.slice(0, 6).join(' ')})`);
  } else {
    bad('rows showing a real peak rather than "—"',
        `0/${peakCells.length} — the lookup key no longer matches what compute_itunes_peaks.mjs writes`);
    await summarise(`FAILED — 0/${peakCells.length} rows show a peak; the lookup key no longer matches compute_itunes_peaks.mjs`);
  }
}

await browser.close();
server.close();
console.log(`\nFAILURES: ${failures}`);
process.exit(failures ? 1 : 0);
