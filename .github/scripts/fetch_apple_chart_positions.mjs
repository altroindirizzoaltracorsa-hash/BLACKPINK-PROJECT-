/**
 * fetch_apple_chart_positions.mjs
 *
 * Daily script: fetches Apple Music "Most Played" chart positions for BLACKPINK
 * and solo members across storefronts via Apple's official RSS API v2.
 *
 * Endpoint (no auth required):
 *   GET https://rss.applemarketingtools.com/api/v2/{country}/music/most-played/100/songs.json
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
const BASE = 'https://rss.applemarketingtools.com/api/v2';

// Apple Music storefronts to check. Apple doesn't publish a single "global"
// chart, so we cover the largest markets where BLACKPINK is active.
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
];

// Patterns to detect BLACKPINK/member in artistName (single string in Apple's feed)
const ARTIST_PATTERNS = [
  /\bblackpink\b/i,
  /\blisa\b/i,
  /\blalisa\b/i,
  /\bjennie\b/i,
  /\bros[eé]\b/i,
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

function identifyMember(artistName = '') {
  if (/\bblackpink\b/i.test(artistName) || /블랙핑크/.test(artistName)) return 'BLACKPINK';
  if (/\blisa\b/i.test(artistName) || /\blalisa\b/i.test(artistName) || /리사/.test(artistName)) return 'LISA';
  if (/\bjennie\b/i.test(artistName) || /제니/.test(artistName)) return 'JENNIE';
  if (/\bros[eé]\b/i.test(artistName) || /로제/.test(artistName)) return 'ROSÉ';
  if (/\bjisoo\b/i.test(artistName) || /지수/.test(artistName)) return 'JISOO';
  return 'BLACKPINK';
}

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchStorefront({ cc, name }) {
  const url = `${BASE}/${cc}/music/most-played/100/songs.json`;
  let resp;
  try {
    resp = await fetch(url, { headers: { 'User-Agent': UA } });
  } catch (e) {
    console.error(`  [${cc}] fetch error: ${e.message}`);
    return null;
  }
  if (!resp.ok) {
    console.error(`  [${cc}] HTTP ${resp.status}`);
    return null;
  }

  const data = await resp.json();
  const results = data?.feed?.results ?? [];

  const hits = [];
  for (const entry of results) {
    if (!isBlackpinkArtist(entry.artistName ?? '')) continue;
    hits.push({
      position: entry.chartPosition ?? (results.indexOf(entry) + 1),
      name: entry.name ?? '',
      artists: entry.artistName ?? '',
      member: identifyMember(entry.artistName ?? ''),
      releaseDate: entry.releaseDate ?? null,
      url: entry.url ?? null,
      artworkUrl: entry.artworkUrl100 ?? null,
      appleId: entry.id ?? null,
    });
  }

  console.log(`  [${cc}] ${name}: ${results.length} entries, ${hits.length} BP hits`);
  if (hits.length > 0) {
    hits.forEach(h => console.log(`    #${h.position} ${h.member} — "${h.name}" (${h.artists})`));
  }

  return { region: name, cc, totalEntries: results.length, hits };
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
    await delay(150);
  }

  const totalHits = Object.values(regions).reduce((n, r) => n + (r?.hits?.length ?? 0), 0);
  const output = {
    generatedAt: new Date().toISOString(),
    date: today,
    regions,
    summary: {
      totalHits,
      regionsChecked: Object.keys(regions).length,
    },
  };

  const dated = join(DATA_DIR, `apple-chart-positions-${today}.json`);
  const latest = join(DATA_DIR, 'apple-chart-positions-latest.json');
  writeFileSync(dated, JSON.stringify(output, null, 2));
  writeFileSync(latest, JSON.stringify(output, null, 2));

  console.log(`\n  Saved: ${dated}`);
  console.log(`  Saved: ${latest}`);
  console.log(`  Total BP hits across all storefronts: ${totalHits}`);

  // Highlight any charting entries
  const allHits = Object.entries(regions).flatMap(([cc, r]) =>
    (r?.hits ?? []).map(h => ({ ...h, cc, regionName: r.region }))
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
