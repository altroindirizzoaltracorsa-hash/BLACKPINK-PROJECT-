/**
 * Probe v11:
 * - v10 confirmed: /youtubei/v1/browse returns INVALID_ARGUMENT for every browseId.
 * - charts.youtube.com SPA must use a DIFFERENT Innertube path (not /browse).
 * - ytcfg has INNERTUBE_API_VERSION, SERVER_NAME, CLIENT_PROTOCOL not yet printed.
 *
 * This version:
 * 1. Prints ALL ytcfg fields (SERVER_NAME, INNERTUBE_API_VERSION, CLIENT_PROTOCOL, etc.).
 * 2. Tries alternate Innertube paths on charts.youtube.com:
 *    /youtubei/v1/chart_data, /youtubei/v1/charts, /youtubei/v1/music/get_chart,
 *    /youtubei/v1/music/chart, /youtubei/v1/browse_feed
 * 3. Extracts script bundle URLs from HTML, fetches one, searches for API call patterns.
 * 4. Also tries a GET to /youtubei/v1/ to see response shape.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ARTISTS = ['BLACKPINK', 'JENNIE', 'JISOO', 'ROSÉ', 'ROSA', 'LISA'];

function snip(v, max = 300) { return String(v).length > max ? String(v).slice(0, max) + '…' : String(v); }

async function fetchYtcfg(path = 'charts/TopVideos/KR') {
  const url = `https://charts.youtube.com/${path}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const html = await r.text();
  const setCalls = [...html.matchAll(/ytcfg\.set\s*\(\s*(\{[\s\S]*?\})\s*\)/g)];
  let cfg = {};
  for (const [, j] of setCalls) {
    try { Object.assign(cfg, JSON.parse(j)); } catch {}
  }
  return { cfg, html };
}

async function tryPost(path, body, clientCtx, label) {
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
      'X-YouTube-Client-Version': clientCtx.clientVersion ?? '2.0',
    },
    body: JSON.stringify({ ...body, context: { client: clientCtx } }),
  });
  console.log(`    HTTP ${r.status}`);
  const ct = r.headers.get('content-type') ?? '';
  const txt = await r.text();
  let parsed;
  try { parsed = JSON.parse(txt); } catch {}
  if (parsed?.error) {
    console.log(`    error: ${parsed.error.status} — ${parsed.error.message}`);
  } else if (parsed) {
    console.log(`    SUCCESS! keys: ${Object.keys(parsed).join(', ')}`);
    console.log(`    size: ${txt.length} bytes`);
    const raw = txt;
    for (const n of ARTISTS) {
      const idx = raw.indexOf(n);
      if (idx >= 0) console.log(`    ★ "${n}" found!`);
    }
    return parsed;
  } else {
    console.log(`    ${snip(txt, 200)}`);
  }
  return null;
}

async function tryGet(path, label) {
  const url = `https://charts.youtube.com${path}`;
  console.log(`\n--- [${label}] GET ${path} ---`);
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  console.log(`    HTTP ${r.status} ${r.headers.get('content-type') ?? ''}`);
  const txt = await r.text();
  console.log(`    ${snip(txt, 400)}`);
}

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('=== Step 1: Print ALL ytcfg fields ===');
  const { cfg, html } = await fetchYtcfg('charts/TopVideos/KR');

  // Print all non-object/non-array scalar fields
  console.log('\n  Scalar fields:');
  for (const [k, v] of Object.entries(cfg).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof v !== 'object' || v === null) {
      console.log(`    ${k}: ${JSON.stringify(v)}`);
    }
  }
  // Print object/array field keys only (already know INNERTUBE_CONTEXT and LAUNCHED_CHART_COUNTRIES)
  console.log('\n  Object/array field keys:');
  for (const [k, v] of Object.entries(cfg).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof v === 'object' && v !== null && k !== 'INNERTUBE_CONTEXT' && k !== 'LAUNCHED_CHART_COUNTRIES') {
      console.log(`    ${k}: ${snip(JSON.stringify(v), 200)}`);
    }
  }

  const client = cfg.INNERTUBE_CONTEXT?.client ?? {};
  // Use exact ytcfg context, set gl=KR
  const clientKR = { ...client, gl: 'KR', hl: 'en' };
  const clientZZ = { ...client, gl: 'ZZ', hl: 'en' };

  await delay(300);

  console.log('\n=== Step 2: Try alternate Innertube paths (POST) ===');

  const paths = [
    // Charts-specific
    '/youtubei/v1/chart_data',
    '/youtubei/v1/charts/getChartData',
    '/youtubei/v1/charts/browse',
    '/youtubei/v1/charts',
    '/youtubei/v1/music/get_chart',
    '/youtubei/v1/music/chart_data',
    '/youtubei/v1/browse_feed',
    '/youtubei/v1/guide',
    // Try version 2 path (INNERTUBE_API_VERSION might not be v1)
    '/youtubei/v2/browse',
  ];

  for (const path of paths) {
    await tryPost(
      path,
      { browseId: 'FEcharts_top_videos_KR' },
      clientKR,
      path
    );
    await delay(150);
  }

  console.log('\n=== Step 3: GET probes ===');
  await tryGet('/youtubei/v1/', 'GET /youtubei/v1/');
  await delay(150);
  await tryGet('/youtubei/', 'GET /youtubei/');
  await delay(150);
  // Try the REST-style charts API (not Innertube)
  await tryGet('/api/topcharts?hl=en&gl=KR', 'GET /api/topcharts KR');
  await delay(150);
  await tryGet('/api/charts?hl=en&gl=KR', 'GET /api/charts KR');

  await delay(300);

  console.log('\n=== Step 4: Extract JS bundle URLs and search for API patterns ===');

  // Find all <script src="..."> in the HTML
  const scriptSrcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/gi)]
    .map(m => m[1])
    .filter(s => s.includes('.js'));
  console.log(`  Found ${scriptSrcs.length} script src URLs`);
  scriptSrcs.forEach((s, i) => console.log(`    [${i}] ${s}`));

  // Fetch the first app/main bundle (usually one of the larger ones with 'app' or 'main' in name)
  // Filter to likely app bundles
  const appBundles = scriptSrcs.filter(s =>
    s.includes('app') || s.includes('main') || s.includes('desktop') || s.includes('charts')
  );
  console.log(`\n  App bundle candidates: ${appBundles.length}`);

  const toFetch = appBundles.length > 0 ? appBundles.slice(0, 2) : scriptSrcs.slice(0, 2);

  for (const src of toFetch) {
    const fullUrl = src.startsWith('http') ? src : `https://charts.youtube.com${src}`;
    console.log(`\n  Fetching bundle: ${fullUrl}`);
    try {
      const r = await fetch(fullUrl, { headers: { 'User-Agent': UA } });
      console.log(`  HTTP ${r.status}, size hint: ${r.headers.get('content-length') ?? 'unknown'}`);
      if (!r.ok) { console.log('  skip'); continue; }
      const js = await r.text();
      console.log(`  JS size: ${js.length} bytes`);

      // Search for API endpoint patterns
      const patterns = [
        /youtubei\/v\d+\/[a-z_/]+/gi,
        /"\/api\/[^"]{3,60}"/gi,
        /fetch\s*\(\s*["'][^"']{10,80}["']/gi,
        /getChartData|chartData|chart_data|topVideos|top_videos/gi,
        /serviceEndpoint|apiEndpoint|chartEndpoint/gi,
      ];

      for (const pat of patterns) {
        const matches = [...new Set([...js.matchAll(pat)].map(m => m[0]))];
        if (matches.length > 0) {
          console.log(`  Pattern /${pat.source}/: ${matches.slice(0, 10).join(' | ')}`);
        }
      }
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
    await delay(400);
  }

  console.log('\n=== Probe v11 complete ===');
}

main().catch(e => { console.error(e); process.exit(1); });
