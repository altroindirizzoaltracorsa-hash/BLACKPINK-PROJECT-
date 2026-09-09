/**
 * fetch_apple_chart_positions.mjs
 *
 * Daily script: fetches Apple Music Top Songs chart positions for BLACKPINK
 * and solo members across storefronts by scraping kworb.net chart pages.
 *
 * Data source: https://kworb.net/charts/apple_s/{cc}.html
 * Not all country codes are available on kworb; 404s are skipped gracefully.
 *
 * Commits two files:
 *   data/apple-chart-positions-YYYY-MM-DD.json
 *   data/apple-chart-positions-latest.json
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DATA_DIR = join(REPO_ROOT, 'data');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BASE = 'https://kworb.net/charts/apple_s';

const STOREFRONTS = [
  { cc: 'us', name: 'United States' },
  { cc: 'gb', name: 'United Kingdom' },
  { cc: 'kr', name: 'South Korea' },
  { cc: 'jp', name: 'Japan' },
  { cc: 'au', name: 'Australia' },
  { cc: 'ca', name: 'Canada' },
  { cc: 'de', name: 'Germany' },
  { cc: 'fr', name: 'France' },
  { cc: 'it', name: 'Italy' },
  { cc: 'es', name: 'Spain' },
  { cc: 'br', name: 'Brazil' },
  { cc: 'mx', name: 'Mexico' },
  { cc: 'tw', name: 'Taiwan' },
  { cc: 'hk', name: 'Hong Kong' },
  { cc: 'sg', name: 'Singapore' },
  { cc: 'ph', name: 'Philippines' },
  { cc: 'th', name: 'Thailand' },
  { cc: 'id', name: 'Indonesia' },
  { cc: 'my', name: 'Malaysia' },
  { cc: 'vn', name: 'Vietnam' },
  { cc: 'in', name: 'India' },
  { cc: 'nz', name: 'New Zealand' },
  { cc: 'nl', name: 'Netherlands' },
  { cc: 'se', name: 'Sweden' },
  { cc: 'no', name: 'Norway' },
  { cc: 'pl', name: 'Poland' },
  { cc: 'tr', name: 'Turkey' },
  { cc: 'ar', name: 'Argentina' },
  { cc: 'cl', name: 'Chile' },
  { cc: 'co', name: 'Colombia' },
  { cc: 'pe', name: 'Peru' },
  { cc: 'sa', name: 'Saudi Arabia' },
  { cc: 'za', name: 'South Africa' },
  { cc: 'be', name: 'Belgium' },
  { cc: 'at', name: 'Austria' },
  { cc: 'ch', name: 'Switzerland' },
  { cc: 'pt', name: 'Portugal' },
  { cc: 'fi', name: 'Finland' },
  { cc: 'dk', name: 'Denmark' },
  { cc: 'ie', name: 'Ireland' },
  { cc: 'cn', name: 'China' },
];

const ARTIST_PATTERNS = [
  /\bblackpink\b/i,
  /\bLISA\b/,       // case-sensitive: K-pop LISA is all-caps; avoids "Lisa Gerrard", "LiSA" (JP singer)
  /\blalisa\b/i,
  /\bjennie\b/i,
  /\bROS[Éé]/i,     // accent required: avoids "Roses" (Guns N' Roses), "IngaRose" etc.
  /\bjisoo\b/i,
  /블랙핑크/,
  /리사/,
  /제니/,
  /로제/,
  /지수/,
];

function isBlackpinkArtist(artistName = '') {
  return ARTIST_PATTERNS.some(p => p.test(artistName));
}

// Only scan parenthesised credits like "(feat. JENNIE)" to avoid matching
// common first names in unrelated song titles.
const TITLE_CREDIT_PATTERNS = [
  /\bBLACKPINK\b/i,
  /\bLISA\b/,
  /\bLALISA\b/i,
  /\bJENNIE\b/,   // case-sensitive
  /\bROS[Éé]/i,
  /\bJISOO\b/,    // case-sensitive
  /블랙핑크/, /리사/, /제니/, /로제/, /지수/,
];

function isBlackpinkCredit(songName = '') {
  const credits = (songName.match(/\([^)]+\)/g) || []).join(' ');
  return credits && TITLE_CREDIT_PATTERNS.some(p => p.test(credits));
}

function identifyMemberFromCredit(songName = '') {
  const credits = (songName.match(/\([^)]+\)/g) || []).join(' ');
  if (/\bBLACKPINK\b/i.test(credits) || /블랙핑크/.test(credits)) return 'BLACKPINK';
  if (/\bLISA\b/.test(credits) || /\bLALISA\b/i.test(credits) || /리사/.test(credits)) return 'LISA';
  if (/\bJENNIE\b/.test(credits) || /제니/.test(credits)) return 'JENNIE';
  if (/\bROS[Éé]/i.test(credits) || /로제/.test(credits)) return 'ROSÉ';
  if (/\bJISOO\b/.test(credits) || /지수/.test(credits)) return 'JISOO';
  return 'BLACKPINK';
}

function identifyMember(artistName = '') {
  if (/\bblackpink\b/i.test(artistName) || /블랙핑크/.test(artistName)) return 'BLACKPINK';
  if (/\bLISA\b/.test(artistName) || /\blalisa\b/i.test(artistName) || /리사/.test(artistName)) return 'LISA';
  if (/\bjennie\b/i.test(artistName) || /제니/.test(artistName)) return 'JENNIE';
  if (/\bROS[Éé]/i.test(artistName) || /로제/.test(artistName)) return 'ROSÉ';
  if (/\bjisoo\b/i.test(artistName) || /지수/.test(artistName)) return 'JISOO';
  return 'BLACKPINK';
}

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url, opts, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const r = await fetch(url, opts);
      if ((r.status === 503 || r.status === 429) && attempt < retries - 1) {
        const wait = 3000 * (attempt + 1);
        console.log(`  → HTTP ${r.status}, retrying in ${wait / 1000}s…`);
        await delay(wait);
        continue;
      }
      return r;
    } catch (e) {
      if (attempt < retries - 1) {
        await delay(3000 * (attempt + 1));
      } else {
        throw e;
      }
    }
  }
}

// Parses kworb chart table rows from HTML.
// Table structure: <tr><td>POS</td>[<td>CHANGE</td>]<td class="mp text"><div>ARTIST - TITLE</div></td></tr>
// The P+ (change) column is present on some country pages but not all.
function parseKworbTable(html) {
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const results = [];
  let m;
  while ((m = rowRe.exec(html))) {
    const inner = m[1];
    if (inner.includes('<th')) continue;

    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const tds = [];
    let tdm;
    while ((tdm = tdRe.exec(inner))) {
      tds.push(decodeHtml(tdm[1].replace(/<[^>]+>/g, '').trim()));
    }
    if (tds.length < 2) continue;

    const position = parseInt(tds[0], 10);
    if (isNaN(position)) continue;

    // Last td is always "Artist - Title"
    const artistTitle = tds[tds.length - 1];
    const dashIdx = artistTitle.indexOf(' - ');
    if (dashIdx === -1) continue;
    const artistName = artistTitle.slice(0, dashIdx).trim();
    const songName   = artistTitle.slice(dashIdx + 3).trim();

    results.push({ position, artistName, songName });
  }
  return results;
}

async function fetchStorefront({ cc, name }) {
  const url = `${BASE}/${cc}.html`;
  let resp;
  try {
    resp = await fetchWithRetry(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
  } catch (e) {
    console.error(`  [${cc}] fetch error: ${e.message}`);
    return null;
  }
  if (!resp.ok) {
    if (resp.status === 404) {
      console.log(`  [${cc}] not available on kworb (404)`);
    } else {
      console.error(`  [${cc}] HTTP ${resp.status}`);
    }
    return null;
  }

  const html = await resp.text();
  const rows = parseKworbTable(html);
  if (rows.length === 0) {
    console.error(`  [${cc}] no chart rows parsed`);
    return null;
  }

  const hits = [];
  for (const { position, artistName, songName } of rows) {
    const byArtist = isBlackpinkArtist(artistName);
    const byTitle  = !byArtist && isBlackpinkCredit(songName);
    if (!byArtist && !byTitle) continue;
    hits.push({
      position,
      name: songName,
      artists: artistName,
      member: byArtist ? identifyMember(artistName) : identifyMemberFromCredit(songName),
    });
  }

  console.log(`  [${cc}] ${name}: ${rows.length} entries, ${hits.length} BP hits`);
  if (hits.length > 0) {
    hits.forEach(h => console.log(`    #${h.position} ${h.member} — "${h.name}" (${h.artists})`));
  }

  return { region: name, cc, totalEntries: rows.length, hits };
}

async function main() {
  console.log('=== Apple Music Chart Positions — BLACKPINK tracker ===');
  const today = new Date().toISOString().slice(0, 10);
  console.log(`  Run date: ${today}`);

  mkdirSync(DATA_DIR, { recursive: true });

  const regions = {};
  for (const sf of STOREFRONTS) {
    try {
      const result = await fetchStorefront(sf);
      if (result) regions[sf.cc] = result;
    } catch (e) {
      console.error(`  [${sf.cc}] unexpected error: ${e.message}`);
    }
    await delay(300);
  }

  const totalHits = Object.values(regions).reduce((n, r) => n + (r?.hits?.length ?? 0), 0);
  const regionsChecked = Object.keys(regions).length;
  const output = {
    generatedAt: new Date().toISOString(),
    date: today,
    regions,
    summary: { totalHits, regionsChecked },
  };

  const dated  = join(DATA_DIR, `apple-chart-positions-${today}.json`);
  const latest = join(DATA_DIR, 'apple-chart-positions-latest.json');
  writeFileSync(dated, JSON.stringify(output, null, 2));
  if (regionsChecked > 0) {
    writeFileSync(latest, JSON.stringify(output, null, 2));
  } else {
    console.log('\n  All storefronts failed — keeping existing latest.json unchanged.');
  }

  console.log(`\n  Saved: ${dated}`);
  if (regionsChecked > 0) console.log(`  Saved: ${latest}`);
  console.log(`  Storefronts checked: ${regionsChecked}/${STOREFRONTS.length}`);
  console.log(`  Total BP hits: ${totalHits}`);

  const allHits = Object.entries(regions).flatMap(([, r]) =>
    (r?.hits ?? []).map(h => ({ ...h, regionName: r.region }))
  );
  if (allHits.length > 0) {
    console.log('\n=== Charting entries ===');
    allHits.sort((a, b) => a.position - b.position);
    for (const h of allHits) {
      console.log(`  ${h.regionName} #${h.position} — ${h.member} "${h.name}"`);
    }
  } else {
    console.log('\n  No BLACKPINK/member entries charting in any checked storefront today.');
  }

  console.log('\n=== Done ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
