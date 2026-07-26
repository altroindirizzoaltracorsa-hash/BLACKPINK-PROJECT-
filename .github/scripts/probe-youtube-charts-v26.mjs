/**
 * probe-youtube-charts-v26.mjs
 *
 * Direct daily chart API call — dumps raw response structure so we can
 * find the correct path for chart entries in CHART_DETAILS perspective.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DATA_DIR = join(REPO_ROOT, 'data');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BROWSE = 'https://charts.youtube.com/youtubei/v1/browse?alt=json';

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

function walk(obj, path = '', depth = 0) {
  if (depth > 6) return;
  if (obj === null || obj === undefined) return;
  const type = Array.isArray(obj) ? `Array(${obj.length})` : typeof obj;
  if (typeof obj !== 'object') {
    const val = String(obj).slice(0, 80);
    console.log(`  ${path}: ${val}`);
    return;
  }
  if (Array.isArray(obj)) {
    console.log(`  ${path}: Array(${obj.length})`);
    if (obj.length > 0) walk(obj[0], `${path}[0]`, depth + 1);
    return;
  }
  const keys = Object.keys(obj);
  console.log(`  ${path}: {${keys.slice(0, 10).join(', ')}${keys.length > 10 ? '...' : ''}}`);
  for (const k of keys.slice(0, 6)) {
    walk(obj[k], `${path}.${k}`, depth + 1);
  }
}

async function probeDaily(label, baseClient, region) {
  console.log(`\n=== ${label} ===`);
  const clientGl = region === 'global' ? 'US' : region.toUpperCase();
  const client = { ...baseClient, gl: clientGl, hl: 'en' };
  const query = [
    'flags=MusicCharts__enable_apac_and_shorts_charts_expansion',
    'perspective=CHART_DETAILS',
    `chart_params_country_code=${region}`,
    'chart_params_chart_type=VIDEOS',
    'chart_params_period_type=DAILY',
  ].join('&');

  console.log(`  query: ${query}`);

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
      query,
      context: { client },
    }),
  });

  console.log(`  HTTP ${resp.status}`);
  if (!resp.ok) return null;

  const data = await resp.json();

  // Walk top-level structure
  console.log('\n  Top-level keys:', Object.keys(data).join(', '));

  // Try the standard path
  const std = data?.contents?.sectionListRenderer?.contents?.[0]
    ?.musicAnalyticsSectionRenderer?.content;
  if (std) {
    console.log('  Standard path found. Keys:', Object.keys(std).join(', '));
    console.log('  trackTypes:', JSON.stringify(std.trackTypes?.map(t => ({ listType: t.listType, count: t.trackViews?.length }))));
    const pm = data?.contents?.sectionListRenderer?.contents?.[0]
      ?.musicAnalyticsSectionRenderer?.content?.perspectiveMetadata;
    console.log('  entityId:', pm?.entityId);
  } else {
    console.log('  Standard path NOT found — walking response structure:');
    walk(data, 'root', 0);
  }

  // Search entire JSON for "jennie" or "Less Than"
  const rawJson = JSON.stringify(data);
  const jennieIdx = rawJson.toLowerCase().indexOf('less than');
  if (jennieIdx >= 0) {
    console.log(`\n  *** "Less Than" found at pos ${jennieIdx}:`);
    console.log('  ', rawJson.slice(Math.max(0, jennieIdx - 30), jennieIdx + 100));
  } else {
    console.log('\n  "Less Than" NOT found in response');
  }

  const jennieIdx2 = rawJson.toLowerCase().indexOf('jennie');
  if (jennieIdx2 >= 0) {
    console.log(`  "jennie" found at pos ${jennieIdx2}:`);
    console.log('  ', rawJson.slice(Math.max(0, jennieIdx2 - 30), jennieIdx2 + 100));
  }

  return data;
}

async function main() {
  console.log('=== Probe v26: Daily chart response structure ===');
  const baseClient = await fetchBaseClient();
  console.log(`Client: ${baseClient.clientName} v${baseClient.clientVersion}`);

  // Global daily
  const globalData = await probeDaily('Global daily', baseClient, 'global');
  if (globalData) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(
      join(DATA_DIR, 'probe-v26-global-daily-raw.json'),
      JSON.stringify(globalData, null, 2),
    );
    console.log('\nSaved full global daily response to data/probe-v26-global-daily-raw.json');
  }

  // US daily
  await probeDaily('US daily', baseClient, 'us');

  console.log('\n=== Done ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
