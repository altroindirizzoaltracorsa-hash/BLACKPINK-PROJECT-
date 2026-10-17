// The country labels the charts show, checked in a real browser.
//
// Run: node .github/scripts/test_country_labels.mjs
//
// Two separate things have to agree and neither is visible from the other:
// #ch-country-select (hand-written <option>s on /spotify-charts) and
// ARTIST_CHART_COUNTRIES (what the Top Artists tables render from). A label
// changed in one and not the other shows one name in the picker and a
// different one in the table. Those two are the ONLY user-visible sources of
// country names in the repo — nothing else defines a flag/name pair.
//
// The picker is sorted by what it DISPLAYS, so renaming an entry can also
// strand it in the wrong place alphabetically — that is checked here too,
// because it reads as a bug long before anyone traces it to a rename.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

// code -> the name and flag the site must show for it.
const LABELS = {
  // Labelled Palestine by the site's choice. The code stays IL because that is
  // the market the chart providers answer to; see the notes in index.html.
  IL: { name: 'Palestine', flag: '🇵🇸' },
};
// Names that must appear nowhere a visitor can read.
const FORBIDDEN = [/\bisrael\b/i];

const server = createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  const file = p === '/' || /^\/(countdowns|charts|spotify-charts|streams|voting|leaderboard|badges|account|feedback)(\/|$)/.test(p)
    ? '/index.html' : p;
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

let failures = 0;
const ok = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { failures++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page.addInitScript(() => { try { localStorage.setItem('bu_tutorial_seen', '1'); } catch (e) {} });
await page.goto(`http://127.0.0.1:${server.address().port}/spotify-charts`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

console.log('--- the chart country picker');
const opts = await page.evaluate(() => [...document.querySelectorAll('#ch-country-select option')]
  .map((o) => ({ value: o.value, text: o.textContent.trim() })));
if (!opts.length) bad('#ch-country-select has options', 'found none');
else ok('#ch-country-select has options', `${opts.length}`);

for (const [code, want] of Object.entries(LABELS)) {
  const hit = opts.filter((o) => o.value === code);
  if (hit.length !== 1) { bad(`exactly one option for ${code}`, `found ${hit.length}`); continue; }
  hit[0].text.includes(want.name) ? ok(`${code} reads "${want.name}"`, hit[0].text)
                                  : bad(`${code} reads "${want.name}"`, `got "${hit[0].text}"`);
  hit[0].text.includes(want.flag) ? ok(`${code} shows the matching flag`)
                                  : bad(`${code} shows the matching flag`, `got "${hit[0].text}"`);
}
for (const re of FORBIDDEN) {
  const hit = opts.filter((o) => re.test(o.text));
  hit.length ? bad(`nothing in the picker matches ${re}`, hit.map((o) => o.text).join(', '))
             : ok(`nothing in the picker matches ${re}`);
}

// Sorted by displayed name (flag stripped), which is how it is written —
// skipping GLOBAL, which deliberately leads the list and is not a country.
const names = opts.filter((o) => /^[A-Z]{2}$/.test(o.value))
  .map((o) => o.text.replace(/^[^\p{L}]+/u, '').trim());
const sorted = [...names].sort((a, b) => a.localeCompare(b, 'en'));
const firstBad = names.findIndex((n, i) => n !== sorted[i]);
firstBad === -1 ? ok('the picker is in alphabetical order')
  : bad('the picker is in alphabetical order', `"${names[firstBad]}" sits where "${sorted[firstBad]}" belongs`);

console.log('--- ARTIST_CHART_COUNTRIES, which the chart tables render from');
const mapped = await page.evaluate((codes) => {
  if (typeof ARTIST_CHART_COUNTRIES === 'undefined') return null;
  return Object.fromEntries(codes.map((c) => [c, ARTIST_CHART_COUNTRIES[c] || null]));
}, Object.keys(LABELS));
if (mapped === null) bad('ARTIST_CHART_COUNTRIES is reachable', 'not defined');
else for (const [code, want] of Object.entries(LABELS)) {
  const got = mapped[code];
  if (!got) { bad(`ARTIST_CHART_COUNTRIES.${code} exists`); continue; }
  got.name === want.name ? ok(`${code}.name`, got.name)
                         : bad(`${code}.name`, `"${got.name}", expected "${want.name}"`);
  got.flag === want.flag ? ok(`${code}.flag matches the name`)
                         : bad(`${code}.flag matches the name`, got.flag);
}
if (mapped) {
  const all = await page.evaluate(() => Object.entries(ARTIST_CHART_COUNTRIES).map(([c, v]) => `${c}:${v.name}`));
  for (const re of FORBIDDEN) {
    const hit = all.filter((s) => re.test(s));
    hit.length ? bad(`no country entry matches ${re}`, hit.join(', ')) : ok(`no country entry matches ${re}`);
  }
}

await browser.close();
server.close();
console.log(`\nFAILURES: ${failures}`);
process.exit(failures ? 1 : 0);
