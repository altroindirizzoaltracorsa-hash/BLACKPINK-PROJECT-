/**
 * probe-youtube-charts-v23.mjs
 *
 * Probe: find the daily chart endpoint and confirm JENNIE "Less Than A Lover" is there.
 * The weekly chart (FEmusic_analytics_charts_home with no chartType param) misses
 * brand-new releases. Daily charts use a different query structure.
 *
 * Hypothesis: the browseId is the same but there's a chartFrequency or period param.
 * Also try fetching the GLOBAL chart (no region / gl=US with empty region).
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DATA_DIR = join(REPO_ROOT, 'data');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BROWSE = 'https://charts.youtube.com/youtubei/v1/browse';

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchBaseClient() {
  // Try loading from the global charts page specifically
  const r = await fetch('https://charts.youtube.com/charts/TopSongs/global', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const html = await r.text();
  const setCalls = [...html.matchAll(/ytcfg\.set\s*\(\s*(\{[\s\S]*?\})\s*\)/g)];
  let cfg = {};
  for (const [, j] of setCalls) { try { Object.assign(cfg, JSON.parse(j)); } catch {} }
  return cfg.INNERTUBE_CONTEXT?.client ?? {};
}

async function tryBrowse(label, baseClient, bodyOverrides) {
  console.log(`\n[${label}]`);
  const body = {
    browseId: 'FEmusic_analytics_charts_home',
    context: { client: { ...baseClient, hl: 'en' } },
    ...bodyOverrides,
  };
  console.log('  body:', JSON.stringify(body).slice(0, 300));

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
    body: JSON.stringify(body),
  });

  if (!resp.ok) { console.log(`  HTTP ${resp.status}`); return null; }
  const data = await resp.json();

  const pm = data?.contents?.sectionListRenderer?.contents?.[0]
    ?.musicAnalyticsSectionRenderer?.content?.perspectiveMetadata;
  console.log(`  entityId: ${pm?.entityId ?? '(none)'}`);

  const content = data?.contents?.sectionListRenderer?.contents?.[0]
    ?.musicAnalyticsSectionRenderer?.content;

  const trackTypes = content?.trackTypes ?? [];
  console.log(`  trackTypes: ${trackTypes.length}`);
  for (const tt of trackTypes) {
    const entries = tt.trackViews ?? [];
    console.log(`    [${tt.listType}] ${entries.length} entries`);
    // Search for JENNIE
    for (const e of entries) {
      const combined = ((e.name ?? '') + ' ' + (e.artists ?? []).map(a => a.name ?? '').join(' ')).toLowerCase();
      if (combined.includes('jennie') || combined.includes('less than')) {
        console.log(`    *** HIT: #${e.chartEntryMetadata?.currentPosition} "${e.name}" — ${(e.artists ?? []).map(a => a.name).join(', ')} (${e.viewCount} views)`);
      }
    }
    // Print first 3 entries
    entries.slice(0, 3).forEach(e => {
      console.log(`    sample: #${e.chartEntryMetadata?.currentPosition} "${e.name}" — ${(e.artists ?? []).map(a => a.name).join(', ')}`);
    });
  }
  return data;
}

async function main() {
  console.log('=== Probe v23: Find daily chart + Less Than A Lover ===');
  const baseClient = await fetchBaseClient();
  console.log(`Client: ${baseClient.clientName} v${baseClient.clientVersion} gl=${baseClient.gl}`);

  const results = {};

  // 1. Weekly global (no region)
  results.weekly_global = await tryBrowse('weekly_global (no region/gl)', baseClient, {
    query: JSON.stringify({}),
    context: { client: { ...baseClient, gl: 'US', hl: 'en' } },
  });
  await delay(300);

  // 2. Daily chart — try chartFrequency param in query
  results.daily_us_chartfreq = await tryBrowse('daily US (chartFrequency:DAILY in query)', baseClient, {
    query: JSON.stringify({ region: 'us', chartFrequency: 'DAILY' }),
    context: { client: { ...baseClient, gl: 'US', hl: 'en' } },
  });
  await delay(300);

  // 3. Daily chart — try params field (base64-encoded proto for daily)
  // The YouTube Charts UI hits TopVideos daily page — try with "Daily" period param
  results.daily_us_params = await tryBrowse('daily US (params: daily)', baseClient, {
    query: JSON.stringify({ region: 'us', period: 'daily' }),
    context: { client: { ...baseClient, gl: 'US', hl: 'en' } },
  });
  await delay(300);

  // 4. Try with "Brani" tab (Songs) browseId variant
  results.songs_global = await tryBrowse('songs chart (TopSongs browseId)', baseClient, {
    browseId: 'FEmusic_analytics_charts_home',
    query: JSON.stringify({ region: 'us', chartType: 'SONGS' }),
    context: { client: { ...baseClient, gl: 'US', hl: 'en' } },
  });
  await delay(300);

  // 5. Daily KR
  results.daily_kr = await tryBrowse('daily KR (chartFrequency:DAILY)', baseClient, {
    query: JSON.stringify({ region: 'kr', chartFrequency: 'DAILY' }),
    context: { client: { ...baseClient, gl: 'KR', hl: 'en' } },
  });
  await delay(300);

  // 6. Try fetching the actual TopVideos global daily page URL structure
  // charts.youtube.com/charts/TopVideos/global — hit via fetch to see if browseId differs
  console.log('\n[Fetching charts.youtube.com/charts/TopVideos/global HTML for browseId clues]');
  const pageResp = await fetch('https://charts.youtube.com/charts/TopVideos/global', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const pageHtml = await pageResp.text();
  // Look for browseId, chartFrequency, entityId in the page
  const browseIdMatches = pageHtml.match(/"browseId"\s*:\s*"([^"]+)"/g) ?? [];
  const freqMatches = pageHtml.match(/chartFrequency[^,}]{0,50}/g) ?? [];
  const entityMatches = pageHtml.match(/entityId[^,}]{0,80}/g) ?? [];
  console.log('  browseIds found:', [...new Set(browseIdMatches)].slice(0, 5));
  console.log('  chartFrequency mentions:', [...new Set(freqMatches)].slice(0, 5));
  console.log('  entityId mentions:', [...new Set(entityMatches)].slice(0, 3));

  // 7. Try chartFrequency as top-level body param
  results.daily_body_freq = await tryBrowse('daily US (chartFrequency top-level)', baseClient, {
    query: JSON.stringify({ region: 'us' }),
    chartFrequency: 'DAILY',
    context: { client: { ...baseClient, gl: 'US', hl: 'en' } },
  });
  await delay(300);

  // Save raw output for inspection
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, 'probe-v23-daily-chart.json'), JSON.stringify(results, null, 2));
  console.log('\nSaved: data/probe-v23-daily-chart.json');
  console.log('=== Done ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
