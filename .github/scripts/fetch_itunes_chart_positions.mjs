/**
 * fetch_itunes_chart_positions.mjs
 *
 * Daily script: fetches iTunes Store Top Songs chart positions for BLACKPINK
 * and solo members across storefronts via Apple's legacy iTunes RSS feed.
 *
 * Endpoint (no auth required):
 *   GET https://itunes.apple.com/{country}/rss/topsongs/limit=100/json
 *
 * Response uses feed.entry[] with im:* fields (different from Apple Music RSS).
 *
 * Commits two files:
 *   data/itunes-chart-positions-YYYY-MM-DD.json
 *   data/itunes-chart-positions-latest.json
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DATA_DIR = join(REPO_ROOT, 'data');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

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
  /\bLISA\b/,      // case-sensitive: LISA (K-pop) is always all-caps; avoids "Lisa Gerrard" etc.
  /\bLALISA\b/,
  /\bjennie\b/i,
  /ros[eé]/i,
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
  if (/\bLISA\b/.test(artistName) || /\bLALISA\b/.test(artistName) || /리사/.test(artistName)) return 'LISA';
  if (/\bjennie\b/i.test(artistName) || /제니/.test(artistName)) return 'JENNIE';
  if (/ros[eé]/i.test(artistName) || /로제/.test(artistName)) return 'ROSÉ';
  if (/\bjisoo\b/i.test(artistName) || /지수/.test(artistName)) return 'JISOO';
  return 'BLACKPINK';
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

async function fetchStorefront({ cc, name }) {
  const url = `https://itunes.apple.com/${cc}/rss/topsongs/limit=100/json`;
  let resp;
  try {
    resp = await fetchWithRetry(url, { headers: { 'User-Agent': UA } });
  } catch (e) {
    console.error(`  [${cc}] fetch error: ${e.message}`);
    return null;
  }
  if (!resp.ok) {
    console.error(`  [${cc}] HTTP ${resp.status}`);
    return null;
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    console.error(`  [${cc}] JSON parse error: ${e.message}`);
    return null;
  }

  // Legacy iTunes RSS uses feed.entry[] with im:* fields
  const entries = data?.feed?.entry ?? [];
  if (!Array.isArray(entries) || entries.length === 0) {
    console.error(`  [${cc}] no entries in feed (keys: ${Object.keys(data?.feed ?? {}).join(', ')})`);
    return null;
  }

  const hits = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const artistName = entry['im:artist']?.label ?? '';
    if (!isBlackpinkArtist(artistName)) continue;
    const songName    = entry['im:name']?.label ?? '';
    const releaseDate = entry['im:releaseDate']?.label?.slice(0, 10) ?? null;
    const trackUrl    = entry.link?.attributes?.href ?? entry.id?.label ?? null;
    const artworkUrl  = entry['im:image']?.[2]?.label ?? entry['im:image']?.[0]?.label ?? null;
    const appleId     = entry.id?.attributes?.['im:id'] ?? null;
    hits.push({
      position: i + 1,
      name: songName,
      artists: artistName,
      member: identifyMember(artistName),
      releaseDate,
      url: trackUrl,
      artworkUrl,
      appleId,
    });
  }

  console.log(`  [${cc}] ${name}: ${entries.length} entries, ${hits.length} BP hits`);
  if (hits.length > 0) {
    hits.forEach(h => console.log(`    #${h.position} ${h.member} — "${h.name}" (${h.artists})`));
  }

  return { region: name, cc, totalEntries: entries.length, hits };
}

async function main() {
  console.log('=== iTunes Store Chart Positions — BLACKPINK tracker ===');
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
  const regionsChecked = Object.keys(regions).length;
  const output = {
    generatedAt: new Date().toISOString(),
    date: today,
    regions,
    summary: { totalHits, regionsChecked },
  };

  const dated  = join(DATA_DIR, `itunes-chart-positions-${today}.json`);
  const latest = join(DATA_DIR, 'itunes-chart-positions-latest.json');
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
