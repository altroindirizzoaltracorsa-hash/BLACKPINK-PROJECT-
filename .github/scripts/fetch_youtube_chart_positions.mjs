/**
 * fetch_youtube_chart_positions.mjs
 *
 * Daily script: fetches YouTube chart positions for BLACKPINK and solo members
 * across multiple regions via charts.youtube.com InnerTube API.
 *
 * Weekly chart API (confirmed probe v16–v21):
 *   POST https://charts.youtube.com/youtubei/v1/browse
 *   browseId: "FEmusic_analytics_charts_home"
 *   query: JSON.stringify({ region: <countryCode> })
 *   client.gl: <COUNTRY_CODE>
 *
 * Daily chart API (confirmed probe v25 via Playwright intercept):
 *   POST https://charts.youtube.com/youtubei/v1/browse?alt=json
 *   browseId: "FEmusic_analytics_charts_home"
 *   query: "flags=MusicCharts__enable_apac_and_shorts_charts_expansion
 *           &perspective=CHART_DETAILS
 *           &chart_params_country_code=<region|global>
 *           &chart_params_chart_type=VIDEOS
 *           &chart_params_period_type=DAILY"
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DATA_DIR = join(REPO_ROOT, 'data');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BROWSE = 'https://charts.youtube.com/youtubei/v1/browse';
const BROWSE_ALT = 'https://charts.youtube.com/youtubei/v1/browse?alt=json';

// Target regions to fetch (weekly + daily)
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

// Daily chart also includes global aggregate
const DAILY_REGIONS = [
  { gl: 'US', region: 'global', name: 'Global' },
  ...REGIONS,
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

async function fetchDailyChart(baseClient, gl, region) {
  const clientGl = region === 'global' ? 'US' : gl.toUpperCase();
  const client = { ...baseClient, gl: clientGl, hl: 'en' };
  const query = [
    'flags=MusicCharts__enable_apac_and_shorts_charts_expansion',
    'perspective=CHART_DETAILS',
    `chart_params_country_code=${region}`,
    'chart_params_chart_type=VIDEOS',
    'chart_params_period_type=DAILY',
  ].join('&');
  const resp = await fetch(BROWSE_ALT, {
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
      query,
      context: { client },
    }),
  });
  if (!resp.ok) {
    console.error(`  [${gl}] daily HTTP ${resp.status}`);
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

function extractBpHits(entries, artistEntries) {
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

  return [...videoBpHits, ...artistBpHits];
}

async function fetchRegionData(baseClient, { gl, region, name }) {
  console.log(`  Fetching ${name} (gl=${gl})...`);
  const data = await fetchChartsHome(baseClient, gl, region);
  if (!data) return null;

  const period = extractPeriodInfo(data);
  const entries = extractChartEntries(data);
  const artistEntries = extractArtistEntries(data);
  const hits = extractBpHits(entries, artistEntries);

  console.log(`    ${period.entityId} | ${entries.length} video entries | ${hits.length} BP hits`);
  if (hits.length > 0) {
    hits.forEach(h => console.log(`      ${h.chartType} #${h.position} "${h.name}" — ${h.artists.join(', ')} (${(h.viewCount ?? 0).toLocaleString()} views)`));
  }

  return { region: name, gl, period, totalEntries: entries.length, hits };
}

async function fetchDailyRegionData(baseClient, { gl, region, name }) {
  console.log(`  Fetching daily ${name} (${region})...`);
  const data = await fetchDailyChart(baseClient, gl, region);
  if (!data) return null;

  const period = extractPeriodInfo(data);
  const entries = extractChartEntries(data);
  const artistEntries = extractArtistEntries(data);
  const hits = extractBpHits(entries, artistEntries);

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

  mkdirSync(DATA_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);

  // ── Weekly charts ──────────────────────────────────────────────────────────
  console.log('\n--- Weekly charts ---');
  const weeklyResults = {};
  for (const regionConfig of REGIONS) {
    try {
      const regionData = await fetchRegionData(baseClient, regionConfig);
      if (regionData) weeklyResults[regionConfig.region] = regionData;
    } catch (e) {
      console.error(`  Error fetching ${regionConfig.name}: ${e.message}`);
    }
    await delay(250);
  }

  const krPeriod = weeklyResults['kr']?.period ?? weeklyResults['us']?.period;
  const weekEnd = krPeriod?.endDate ?? today.replace(/-/g, '');
  const weekLabel = weekEnd
    ? `${weekEnd.slice(0, 4)}-${weekEnd.slice(4, 6)}-${weekEnd.slice(6, 8)}`
    : today;

  const weeklyOutput = {
    generatedAt: new Date().toISOString(),
    chartType: 'weekly',
    weekEndingDate: weekLabel,
    regions: weeklyResults,
    summary: {
      totalHits: Object.values(weeklyResults).reduce((n, r) => n + (r?.hits?.length ?? 0), 0),
      regionsChecked: Object.keys(weeklyResults).length,
    },
  };

  const weeklyFile = join(DATA_DIR, `youtube-chart-positions-${weekLabel}.json`);
  writeFileSync(weeklyFile, JSON.stringify(weeklyOutput, null, 2));
  writeFileSync(join(DATA_DIR, 'youtube-chart-positions-latest.json'), JSON.stringify(weeklyOutput, null, 2));
  console.log(`\n  Weekly saved: ${weeklyFile}`);

  // ── Daily charts ───────────────────────────────────────────────────────────
  console.log('\n--- Daily charts ---');
  const dailyResults = {};
  for (const regionConfig of DAILY_REGIONS) {
    try {
      const regionData = await fetchDailyRegionData(baseClient, regionConfig);
      if (regionData) dailyResults[regionConfig.region] = regionData;
    } catch (e) {
      console.error(`  Error fetching daily ${regionConfig.name}: ${e.message}`);
    }
    await delay(250);
  }

  const dailyOutput = {
    generatedAt: new Date().toISOString(),
    chartType: 'daily',
    date: today,
    regions: dailyResults,
    summary: {
      totalHits: Object.values(dailyResults).reduce((n, r) => n + (r?.hits?.length ?? 0), 0),
      regionsChecked: Object.keys(dailyResults).length,
    },
  };

  const dailyFile = join(DATA_DIR, `youtube-chart-positions-daily-${today}.json`);
  writeFileSync(dailyFile, JSON.stringify(dailyOutput, null, 2));
  writeFileSync(join(DATA_DIR, 'youtube-chart-positions-daily-latest.json'), JSON.stringify(dailyOutput, null, 2));
  console.log(`  Daily saved: ${dailyFile}`);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n=== Weekly Summary ===');
  for (const [, r] of Object.entries(weeklyResults)) {
    if (!r) continue;
    const hitLine = r.hits.length === 0
      ? '(no BP entries)'
      : r.hits.map(h => `#${h.position} ${h.member} "${h.name}"`).join(', ');
    console.log(`  ${r.region} (${r.period.entityId}): ${hitLine}`);
  }
  console.log(`  Total weekly hits: ${weeklyOutput.summary.totalHits}`);

  console.log('\n=== Daily Summary ===');
  for (const [, r] of Object.entries(dailyResults)) {
    if (!r) continue;
    if (r.hits.length === 0) continue;
    const hitLine = r.hits.map(h => `#${h.position} ${h.member} "${h.name}"`).join(', ');
    console.log(`  ${r.region} (${r.period.entityId}): ${hitLine}`);
  }
  console.log(`  Total daily hits: ${dailyOutput.summary.totalHits}`);

  console.log('\n=== Done ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
