/**
 * fetch_youtube_chart_positions.mjs
 *
 * Nightly script: fetches YouTube chart positions for BLACKPINK and solo members
 * across multiple regions via charts.youtube.com InnerTube API.
 *
 * Working API (confirmed probe v16–v21):
 *   POST https://charts.youtube.com/youtubei/v1/browse
 *   browseId: "FEmusic_analytics_charts_home"
 *   query: JSON.stringify({ region: <countryCode> })
 *   client.gl: <COUNTRY_CODE>   ← CRITICAL: gl controls which country's chart is returned
 *
 * Data path: response.contents.sectionListRenderer.contents[0]
 *   .musicAnalyticsSectionRenderer.content.trackTypes[0].trackViews
 *   Each entry: { id, name, viewCount, encryptedVideoId, chartEntryMetadata.currentPosition,
 *                 artists[*].{name, id}, atvExternalVideoId, releaseDate, thumbnail }
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DATA_DIR = join(REPO_ROOT, 'data');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BROWSE = 'https://charts.youtube.com/youtubei/v1/browse';

// Target regions to fetch
const REGIONS = [
  // East Asia / Pacific
  { gl: 'KR', region: 'kr', name: 'South Korea' },
  { gl: 'JP', region: 'jp', name: 'Japan' },
  { gl: 'TW', region: 'tw', name: 'Taiwan' },
  { gl: 'HK', region: 'hk', name: 'Hong Kong' },
  // Southeast Asia
  { gl: 'ID', region: 'id', name: 'Indonesia' },
  { gl: 'TH', region: 'th', name: 'Thailand' },
  { gl: 'PH', region: 'ph', name: 'Philippines' },
  { gl: 'MY', region: 'my', name: 'Malaysia' },
  { gl: 'VN', region: 'vn', name: 'Vietnam' },
  { gl: 'SG', region: 'sg', name: 'Singapore' },
  // South Asia
  { gl: 'IN', region: 'in', name: 'India' },
  // Oceania
  { gl: 'AU', region: 'au', name: 'Australia' },
  { gl: 'NZ', region: 'nz', name: 'New Zealand' },
  // North America
  { gl: 'US', region: 'us', name: 'United States' },
  { gl: 'CA', region: 'ca', name: 'Canada' },
  { gl: 'MX', region: 'mx', name: 'Mexico' },
  // Latin America
  { gl: 'BR', region: 'br', name: 'Brazil' },
  { gl: 'AR', region: 'ar', name: 'Argentina' },
  { gl: 'CL', region: 'cl', name: 'Chile' },
  { gl: 'CO', region: 'co', name: 'Colombia' },
  { gl: 'PE', region: 'pe', name: 'Peru' },
  // Europe
  { gl: 'GB', region: 'gb', name: 'United Kingdom' },
  { gl: 'FR', region: 'fr', name: 'France' },
  { gl: 'DE', region: 'de', name: 'Germany' },
  { gl: 'ES', region: 'es', name: 'Spain' },
  { gl: 'IT', region: 'it', name: 'Italy' },
  { gl: 'NL', region: 'nl', name: 'Netherlands' },
  { gl: 'SE', region: 'se', name: 'Sweden' },
  { gl: 'NO', region: 'no', name: 'Norway' },
  { gl: 'PL', region: 'pl', name: 'Poland' },
  { gl: 'TR', region: 'tr', name: 'Turkey' },
  // Middle East / Africa
  { gl: 'SA', region: 'sa', name: 'Saudi Arabia' },
  { gl: 'ZA', region: 'za', name: 'South Africa' },
];

// Artist patterns to match (check artist names only, not song titles)
// Use ^ and $ anchors on Latin names to avoid false positives (e.g. "De La Rose", "Manon Lisa")
const ARTIST_PATTERNS = [
  /^blackpink$/i,
  /^lisa$/i,
  /^lalisa$/i,
  /^jennie$/i,
  /^ros[eé]$/i,
  /^jisoo$/i,
  /블랙핑크/,
  /리사/,
  /제니/,
  /로제/,
  /지수/,
];

function isBlackpinkArtist(artists = []) {
  return artists.some(a => ARTIST_PATTERNS.some(p => p.test(a.name ?? '')));
}

function identifyMember(artists = []) {
  for (const a of artists) {
    const n = a.name ?? '';
    if (/^blackpink$/i.test(n) || /블랙핑크/.test(n)) return 'BLACKPINK';
    if (/^lisa$/i.test(n) || /^lalisa$/i.test(n) || /리사/.test(n)) return 'LISA';
    if (/^jennie$/i.test(n) || /제니/.test(n)) return 'JENNIE';
    if (/^ros[eé]$/i.test(n) || /로제/.test(n)) return 'ROSÉ';
    if (/^jisoo$/i.test(n) || /지수/.test(n)) return 'JISOO';
  }
  return 'BLACKPINK';
}

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchBaseClient() {
  const r = await fetch('https://charts.youtube.com/charts/TopVideos/KR', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const html = await r.text();
  const setCalls = [...html.matchAll(/ytcfg\.set\s*\(\s*(\{[\s\S]*?\})\s*\)/g)];
  let cfg = {};
  for (const [, j] of setCalls) { try { Object.assign(cfg, JSON.parse(j)); } catch {} }
  return cfg.INNERTUBE_CONTEXT?.client ?? {};
}

async function fetchChartsHome(baseClient, gl, region) {
  const client = { ...baseClient, gl: gl.toUpperCase(), hl: 'en' };
  const resp = await fetch(BROWSE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'Origin': 'https://charts.youtube.com',
      'Referer': 'https://charts.youtube.com/',
      'X-YouTube-Client-Name': '31',
      'X-YouTube-Client-Version': '2.0',
    },
    body: JSON.stringify({
      browseId: 'FEmusic_analytics_charts_home',
      query: JSON.stringify({ region }),
      context: { client },
    }),
  });
  if (!resp.ok) {
    console.error(`  [${gl}] HTTP ${resp.status}`);
    return null;
  }
  return resp.json();
}

function extractPeriodInfo(data) {
  const pm = data?.contents?.sectionListRenderer?.contents?.[0]
    ?.musicAnalyticsSectionRenderer?.content?.perspectiveMetadata;
  const entityId = pm?.entityId ?? '';
  // entityId format: "weekly:YYYYMMDD:YYYYMMDD:cc"
  const parts = entityId.split(':');
  return {
    entityId,
    periodType: parts[0] ?? '',
    startDate: parts[1] ?? '',
    endDate: parts[2] ?? '',
    region: parts[3] ?? '',
  };
}

function extractChartEntries(data) {
  const content = data?.contents?.sectionListRenderer?.contents?.[0]
    ?.musicAnalyticsSectionRenderer?.content;
  if (!content) return [];

  // Primary source: trackTypes[*].trackViews (full chart with positions)
  const allEntries = [];
  for (const tt of (content.trackTypes ?? [])) {
    if (tt.listType === 'TOP_VIEWS_CHART' && Array.isArray(tt.trackViews)) {
      allEntries.push(...tt.trackViews);
    }
  }

  // Filter to visible entries with valid data
  return allEntries
    .filter(e => e.atvExternalVideoId && e.chartEntryMetadata?.currentPosition)
    .sort((a, b) => (a.chartEntryMetadata.currentPosition ?? 999) - (b.chartEntryMetadata.currentPosition ?? 999));
}

function extractArtistEntries(data) {
  const content = data?.contents?.sectionListRenderer?.contents?.[0]
    ?.musicAnalyticsSectionRenderer?.content;
  if (!content) return [];

  const allEntries = [];
  for (const ac of (content.artists ?? [])) {
    if (Array.isArray(ac.artistViews)) {
      ac.artistViews.forEach((av, idx) => {
        allEntries.push({ ...av, position: idx + 1, chartType: 'TOP_ARTISTS' });
      });
    }
  }
  return allEntries;
}

async function fetchRegionData(baseClient, { gl, region, name }) {
  console.log(`  Fetching ${name} (gl=${gl})...`);
  const data = await fetchChartsHome(baseClient, gl, region);
  if (!data) return null;

  const period = extractPeriodInfo(data);
  const entries = extractChartEntries(data);
  const artistEntries = extractArtistEntries(data);

  // Find BLACKPINK entries in video chart
  const videoBpHits = entries
    .filter(e => isBlackpinkArtist(e.artists))
    .map(e => ({
      chartType: 'TOP_VIDEOS',
      member: identifyMember(e.artists),
      position: e.chartEntryMetadata.currentPosition,
      name: e.name,
      artists: (e.artists ?? []).map(a => a.name),
      videoId: e.encryptedVideoId,
      viewCount: parseInt(e.viewCount ?? '0', 10) || 0,
      releaseDate: e.releaseDate ?? null,
    }));

  // Find BLACKPINK entries in artist chart (artist name matching)
  const artistBpHits = artistEntries
    .filter(e => ARTIST_PATTERNS.some(p => p.test(e.name ?? '')))
    .map(e => ({
      chartType: 'TOP_ARTISTS',
      member: identifyMember([{ name: e.name }]),
      position: e.position,
      name: e.name,
      artists: [e.name],
      channelId: e.externalChannelId ?? null,
      viewCount: parseInt(e.viewCount ?? '0', 10) || 0,
    }));

  const hits = [...videoBpHits, ...artistBpHits];

  console.log(`    ${period.entityId} | ${entries.length} video entries | ${hits.length} BP hits`);
  if (hits.length > 0) {
    hits.forEach(h => console.log(`      ${h.chartType} #${h.position} "${h.name}" — ${h.artists.join(', ')} (${(h.viewCount ?? 0).toLocaleString()} views)`));
  }

  return { region: name, gl, period, totalEntries: entries.length, hits };
}

async function main() {
  console.log('=== YouTube Chart Positions — BLACKPINK tracker ===');
  console.log(`  Run date: ${new Date().toISOString()}`);

  const baseClient = await fetchBaseClient();
  console.log(`  Client: ${baseClient.clientName ?? 'WEB_MUSIC_ANALYTICS'} (gl base: ${baseClient.gl ?? 'US'})`);

  const results = {};
  let anyHits = false;

  for (const regionConfig of REGIONS) {
    try {
      const regionData = await fetchRegionData(baseClient, regionConfig);
      if (regionData) {
        results[regionConfig.region] = regionData;
        if (regionData.hits.length > 0) anyHits = true;
      }
    } catch (e) {
      console.error(`  Error fetching ${regionConfig.name}: ${e.message}`);
    }
    await delay(250);
  }

  // Determine period info for file naming (use KR period or first available)
  const krPeriod = results['kr']?.period ?? results['us']?.period;
  const weekEnd = krPeriod?.endDate ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const weekLabel = weekEnd
    ? `${weekEnd.slice(0, 4)}-${weekEnd.slice(4, 6)}-${weekEnd.slice(6, 8)}`
    : new Date().toISOString().slice(0, 10);

  // Build output
  const output = {
    generatedAt: new Date().toISOString(),
    weekEndingDate: weekLabel,
    regions: results,
    summary: {
      totalHits: Object.values(results).reduce((n, r) => n + (r?.hits?.length ?? 0), 0),
      regionsChecked: Object.keys(results).length,
    },
  };

  // Save to data directory
  mkdirSync(DATA_DIR, { recursive: true });
  const outFile = join(DATA_DIR, `youtube-chart-positions-${weekLabel}.json`);
  writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`\n  Saved: ${outFile}`);

  // Also update the "latest" pointer
  const latestFile = join(DATA_DIR, 'youtube-chart-positions-latest.json');
  writeFileSync(latestFile, JSON.stringify(output, null, 2));
  console.log(`  Saved: ${latestFile}`);

  // Print summary
  console.log('\n=== Summary ===');
  for (const [code, r] of Object.entries(results)) {
    if (!r) continue;
    const hitLine = r.hits.length === 0
      ? '(no BP entries this week)'
      : r.hits.map(h => `#${h.position} ${h.member} "${h.name}"`).join(', ');
    console.log(`  ${r.region} (${r.period.entityId}): ${hitLine}`);
  }
  console.log(`\n  Total BLACKPINK/member chart entries found: ${output.summary.totalHits}`);
  console.log('=== Done ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
