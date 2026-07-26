/**
 * Probe v12:
 * - v11 confirmed: all alternate Innertube paths (chart_data, charts/*, music/*) return 404.
 * - /youtubei/v1/guide returns 400 (path exists, wrong args).
 * - /youtubei/v1/browse returns 400 (path exists, FE* browseIds are wrong).
 * - JS bundles: only 4 scripts, and charts_polymer_v2.js was never searched.
 *
 * This version:
 * 1. Fetches charts_polymer_v2.js (main app bundle) and extracts browseId strings,
 *    API endpoint patterns, and fetch() call targets.
 * 2. Tries /youtubei/v1/guide POST with WEB_MUSIC_ANALYTICS context.
 * 3. Tries /youtubei/v1/browse with browseIds found in the bundle.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ARTISTS = ['BLACKPINK', 'JENNIE', 'JISOO', 'ROSÉ', 'ROSA', 'LISA'];

function snip(v, max = 300) { return String(v).length > max ? String(v).slice(0, max) + '…' : String(v); }

async function fetchYtcfg() {
  const r = await fetch('https://charts.youtube.com/charts/TopVideos/KR', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const html = await r.text();
  const setCalls = [...html.matchAll(/ytcfg\.set\s*\(\s*(\{[\s\S]*?\})\s*\)/g)];
  let cfg = {};
  for (const [, j] of setCalls) {
    try { Object.assign(cfg, JSON.parse(j)); } catch {}
  }
  // extract script srcs too
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+\.js[^"]*)"/gi)].map(m => m[1]);
  return { cfg, scripts };
}

async function post(path, body, clientCtx, label) {
  const url = `https://charts.youtube.com${path}`;
  console.log(`\n--- [${label}] POST ${path} ---`);
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'Origin': 'https://charts.youtube.com',
      'Referer': 'https://charts.youtube.com/',
      'X-YouTube-Client-Name': '31',
      'X-YouTube-Client-Version': '2.0',
    },
    body: JSON.stringify({ ...body, context: { client: clientCtx } }),
  });
  console.log(`    HTTP ${r.status}`);
  const txt = await r.text();
  let parsed;
  try { parsed = JSON.parse(txt); } catch {}
  if (parsed?.error) {
    console.log(`    error: ${parsed.error.status} — ${parsed.error.message}`);
    if (parsed.error.details) console.log(`    details: ${JSON.stringify(parsed.error.details).slice(0, 300)}`);
  } else if (parsed) {
    console.log(`    SUCCESS! keys: ${Object.keys(parsed).join(', ')}, size: ${txt.length}`);
    const raw = txt;
    for (const n of ARTISTS) {
      if (raw.includes(n)) console.log(`    ★ "${n}" found!`);
    }
    return parsed;
  } else {
    console.log(`    ${snip(txt, 200)}`);
  }
  return null;
}

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('=== Step 1: Fetch ytcfg + script URLs ===');
  const { cfg, scripts } = await fetchYtcfg();
  const client = cfg.INNERTUBE_CONTEXT?.client ?? {};
  const clientCtx = { ...client, gl: 'KR', hl: 'en' };

  console.log(`  Scripts: ${scripts.join(', ')}`);

  // Find charts_polymer_v2.js
  const polymerBundle = scripts.find(s => s.includes('charts_polymer'));
  if (!polymerBundle) {
    console.log('  ERROR: charts_polymer bundle not found!');
    process.exit(1);
  }
  const bundleUrl = polymerBundle.startsWith('http')
    ? polymerBundle
    : `https://charts.youtube.com${polymerBundle}`;
  console.log(`\n=== Step 2: Fetch + analyze ${polymerBundle} ===`);

  const r = await fetch(bundleUrl, { headers: { 'User-Agent': UA } });
  console.log(`  HTTP ${r.status}, content-length: ${r.headers.get('content-length') ?? 'unknown'}`);
  if (!r.ok) { console.log('  Failed to fetch bundle'); process.exit(1); }

  const js = await r.text();
  console.log(`  Bundle size: ${js.length} bytes`);

  // 1. Extract all browseId string values
  const browseIds = [...new Set([...js.matchAll(/browseId["'\s]*[:=]["'\s]*([A-Za-z][A-Za-z0-9_]{3,60})/g)].map(m => m[1]))];
  console.log(`\n  browseId values (${browseIds.length}):`);
  browseIds.forEach(b => console.log(`    ${b}`));

  // 2. Extract all FE* prefixed strings
  const feIds = [...new Set([...js.matchAll(/["'](FE[A-Za-z_]{3,60})["']/g)].map(m => m[1]))];
  console.log(`\n  FE* strings (${feIds.length}):`);
  feIds.forEach(f => console.log(`    ${f}`));

  // 3. Extract youtubei endpoint paths
  const endpoints = [...new Set([...js.matchAll(/youtubei\/v\d+\/[a-z_/]{2,40}/gi)].map(m => m[0]))];
  console.log(`\n  Innertube endpoint paths (${endpoints.length}):`);
  endpoints.forEach(e => console.log(`    ${e}`));

  // 4. Extract any /api/ paths
  const apiPaths = [...new Set([...js.matchAll(/["']\/api\/[a-zA-Z0-9_/?&=%-]{3,60}["']/g)].map(m => m[0]))];
  console.log(`\n  /api/ paths (${apiPaths.length}):`);
  apiPaths.forEach(a => console.log(`    ${a}`));

  // 5. Search for 'chart' keyword in context of API calls
  const chartIdx = [];
  let pos = 0;
  while ((pos = js.indexOf('chart', pos)) >= 0) {
    const snippet = js.slice(Math.max(0, pos - 30), pos + 80);
    if (snippet.includes('browseId') || snippet.includes('endpoint') || snippet.includes('Endpoint') || snippet.includes('/v1/')) {
      chartIdx.push(snip(snippet.replace(/\s+/g, ' '), 150));
    }
    pos++;
  }
  const uniqueChartSnippets = [...new Set(chartIdx)];
  console.log(`\n  'chart' near API keywords (${uniqueChartSnippets.length} unique):`);
  uniqueChartSnippets.slice(0, 20).forEach((s, i) => console.log(`    [${i}] ${s}`));

  // 6. Look for fetch( calls
  const fetchCalls = [...js.matchAll(/fetch\s*\(\s*["']([^"']{5,80})["']/g)].map(m => m[1]);
  const uniqueFetch = [...new Set(fetchCalls)];
  console.log(`\n  fetch() call URLs (${uniqueFetch.length}):`);
  uniqueFetch.forEach(f => console.log(`    ${f}`));

  await delay(300);

  console.log('\n=== Step 3: Try /youtubei/v1/guide ===');
  await post('/youtubei/v1/guide', {}, clientCtx, 'guide KR');
  await delay(200);
  // Also try guide without browseId
  await post('/youtubei/v1/guide', {}, { ...clientCtx, gl: 'US' }, 'guide US');

  await delay(200);

  console.log('\n=== Step 4: Try browseIds found in bundle ===');
  // Try the FE* IDs found in the bundle (not already tried)
  const alreadyTried = new Set(['FEmusic_charts', 'FEcharts_top_videos_KR', 'FEcharts', 'FEcharts_home', 'FEcharts_top_songs']);
  const toTry = feIds.filter(f => !alreadyTried.has(f));
  console.log(`  Trying ${toTry.length} new FE* browseIds from bundle`);

  for (const bid of toTry.slice(0, 15)) {
    await post('/youtubei/v1/browse', { browseId: bid }, clientCtx, `browse/${bid}`);
    await delay(150);
  }

  // Also try raw browseIds from the bundle
  const rawToTry = browseIds.filter(b => !b.startsWith('VL') && b.length > 5 && !alreadyTried.has(b));
  console.log(`\n  Trying ${rawToTry.length} raw browseIds from bundle`);
  for (const bid of rawToTry.slice(0, 10)) {
    await post('/youtubei/v1/browse', { browseId: bid }, clientCtx, `browse/${bid}`);
    await delay(150);
  }

  console.log('\n=== Probe v12 complete ===');
}

main().catch(e => { console.error(e); process.exit(1); });
