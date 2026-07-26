/**
 * Probe v18:
 *
 * v17 CRITICAL FINDINGS:
 *   - No INNERTUBE_API_KEY in page HTML (key approach moot)
 *   - perspectiveMetadata.chartPeriods = [] (EMPTY!)
 *     → chartAttributeValue format "weekly:YYYYMMDD:YYYYMMDD:us" was always an inference
 *       from entityId, never confirmed from actual chartPeriods
 *   - visitorData present but X-Goog-Visitor-Id still gives 400
 *   - Proto params also fail
 *
 * Plan for v18:
 *   A. Fetch Polymer bundle, find P9a function definition to understand chartAttributeValue format
 *   B. Also search for FEmusic_analytics_charts_detail context and chartPeriods construction
 *   C. Try charts_home with chartAttributeValue in query (maybe routes to KR)
 *   D. Try endDate as "2026-07-23" (with dashes), chartAttributeValue = "kr" or just empty
 *   E. Try browseId = entityId itself ("weekly:20260717:20260723:us")
 *   F. Try youtube.com InnerTube endpoint (not charts.youtube.com)
 *   G. Dump all top-level keys of the charts_home response to find hidden chartPeriods location
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BROWSE_ENDPOINT = 'https://charts.youtube.com/youtubei/v1/browse';

function snip(v, max = 300) { return String(v).length > max ? String(v).slice(0, max) + '…' : String(v); }
function deepFind(obj, pred, acc = []) {
  if (!obj || typeof obj !== 'object') return acc;
  if (pred(obj)) acc.push(obj);
  for (const v of Object.values(obj)) deepFind(v, pred, acc);
  return acc;
}
async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPageCfg() {
  const r = await fetch('https://charts.youtube.com/charts/TopVideos/KR', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const html = await r.text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+\.js[^"]*)"/gi)].map(m => m[1]);
  const setCalls = [...html.matchAll(/ytcfg\.set\s*\(\s*(\{[\s\S]*?\})\s*\)/g)];
  let cfg = {};
  for (const [, j] of setCalls) { try { Object.assign(cfg, JSON.parse(j)); } catch {} }
  return { cfg, html, scripts };
}

async function browse(endpoint, bodyObj, label) {
  const { cfg } = await fetchPageCfg().catch(() => ({ cfg: {} }));
  // Use cached client from last fetchPageCfg call
  return browseWithClient(endpoint, bodyObj, label, null);
}

async function browseWithClient(endpoint, bodyObj, label, client) {
  console.log(`\n=== [${label}] ===`);
  console.log(`  body: ${JSON.stringify(bodyObj).slice(0, 200)}`);
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'Origin': 'https://charts.youtube.com',
      'Referer': 'https://charts.youtube.com/',
      'X-YouTube-Client-Name': '31',
      'X-YouTube-Client-Version': '2.0',
    },
    body: JSON.stringify(bodyObj),
  });
  console.log(`  HTTP ${r.status}`);
  const ct = r.headers.get('content-type') ?? '';
  if (!r.ok || !ct.includes('json')) {
    const txt = await r.text();
    let parsed; try { parsed = JSON.parse(txt); } catch {}
    if (parsed?.error) console.log(`  error: ${parsed.error.status} — ${parsed.error.message}`);
    else console.log(`  ${snip(txt, 200)}`);
    return null;
  }
  const data = await r.json();
  console.log(`  size: ${JSON.stringify(data).length} bytes`);
  return data;
}

function printEntities(data) {
  const entities = deepFind(data, o => typeof o.atvExternalVideoId === 'string');
  console.log(`  entities: ${entities.length}`);
  entities.slice(0, 3).forEach(e => {
    const pos = e.chartEntryMetadata?.currentPosition ?? '?';
    const arts = (e.artists ?? []).map(a => a.name).join(', ');
    console.log(`    #${pos} "${e.name}" — ${arts}`);
  });
}

async function main() {
  // Step 1: Fetch page config and bundle URL
  console.log('=== Step 1: Fetch page cfg & bundle ===');
  const { cfg, html, scripts } = await fetchPageCfg();
  const client = cfg.INNERTUBE_CONTEXT?.client ?? {};
  const baseClient = { ...client, hl: 'en' };
  console.log(`  clientName: ${baseClient.clientName}`);
  console.log(`  visitorData: ${(client.visitorData ?? '').slice(0, 40)}`);
  console.log(`  scripts: ${scripts.slice(0, 5).join(', ')}`);

  // Find polymer bundle
  const polymerScript = scripts.find(s => s.includes('charts_polymer') || s.includes('polymer'));
  console.log(`  polymer script: ${polymerScript ?? '(none)'}`);

  // Step 2: Fetch polymer bundle and analyze P9a / chartAttributeValue / charts_detail
  if (polymerScript) {
    console.log('\n=== Step 2: Analyze polymer bundle ===');
    const bundleUrl = polymerScript.startsWith('http')
      ? polymerScript
      : `https://charts.youtube.com${polymerScript}`;
    try {
      const bundleResp = await fetch(bundleUrl, { headers: { 'User-Agent': UA } });
      const js = await bundleResp.text();
      console.log(`  bundle size: ${js.length}`);

      // Search for P9a function and its definition
      const p9aIdx = js.indexOf('P9a');
      if (p9aIdx >= 0) {
        // Find the function or call site
        const ctx = snip(js.slice(Math.max(0, p9aIdx - 50), p9aIdx + 300).replace(/\s+/g, ' '), 400);
        console.log(`  P9a context: ${ctx}`);
        // Find more occurrences
        let pos = 0, count = 0;
        while ((pos = js.indexOf('P9a', pos)) >= 0 && count < 5) {
          console.log(`  P9a[${count}]: ${snip(js.slice(Math.max(0,pos-30), pos+120).replace(/\s+/g,' '), 180)}`);
          pos++; count++;
        }
      } else {
        console.log('  P9a: not found in bundle');
      }

      // Search for chartAttributeValue definition
      const cavIdx = js.indexOf('chartAttributeValue');
      if (cavIdx >= 0) {
        let pos = 0, count = 0;
        while ((pos = js.indexOf('chartAttributeValue', pos)) >= 0 && count < 8) {
          console.log(`  chartAttributeValue[${count}]: ${snip(js.slice(Math.max(0,pos-60), pos+180).replace(/\s+/g,' '), 260)}`);
          pos++; count++;
        }
      } else {
        console.log('  chartAttributeValue: not found in bundle');
      }

      // Search around FEmusic_analytics_charts_detail
      let dpos = 0, dcount = 0;
      while ((dpos = js.indexOf('FEmusic_analytics_charts_detail', dpos)) >= 0 && dcount < 5) {
        console.log(`  charts_detail[${dcount}]: ${snip(js.slice(Math.max(0,dpos-80), dpos+200).replace(/\s+/g,' '), 300)}`);
        dpos++; dcount++;
      }
      if (dcount === 0) console.log('  charts_detail: not found in bundle');

      // Search for chartPeriods construction
      let cppos = 0, cpcount = 0;
      while ((cppos = js.indexOf('chartPeriods', cppos)) >= 0 && cpcount < 6) {
        console.log(`  chartPeriods[${cpcount}]: ${snip(js.slice(Math.max(0,cppos-40), cppos+150).replace(/\s+/g,' '), 200)}`);
        cppos++; cpcount++;
      }
      if (cpcount === 0) console.log('  chartPeriods: not found in bundle');

    } catch(e) {
      console.log(`  bundle fetch error: ${e.message}`);
    }
  }

  await delay(300);

  // Step 3: Dump all top-level keys of charts_home response to find hidden chartPeriods
  console.log('\n=== Step 3: charts_home KR — deep dump for chartPeriods ===');
  const body_home_kr = {
    browseId: 'FEmusic_analytics_charts_home',
    query: JSON.stringify({ region: 'kr' }),
    context: { client: baseClient },
  };
  const homeResp = await browseWithClient(BROWSE_ENDPOINT, body_home_kr, 'charts_home KR dump', baseClient);
  if (homeResp) {
    // Look for chartPeriods anywhere in the entire response
    const allPeriods = deepFind(homeResp, o => Array.isArray(o.chartPeriods));
    console.log(`  Objects with chartPeriods: ${allPeriods.length}`);
    allPeriods.forEach((o, i) => {
      console.log(`  [${i}] chartPeriods: ${JSON.stringify(o.chartPeriods).slice(0, 300)}`);
    });

    // Look for any "weekly:" strings in the response
    const raw = JSON.stringify(homeResp);
    const weeklyMatches = [...raw.matchAll(/"weekly:[^"]+"/g)].map(m => m[0]);
    console.log(`  "weekly:" refs: ${weeklyMatches.length}`);
    weeklyMatches.slice(0, 10).forEach(m => console.log(`    ${m}`));

    // Top-level keys
    console.log(`  top-level keys: ${Object.keys(homeResp).join(', ')}`);
  }

  await delay(200);

  // Step 4: Try charts_home with chartAttributeValue in query (might switch region)
  console.log('\n=== Step 4: charts_home KR with chartAttributeValue ===');
  for (const av of ['weekly:20260717:20260723:kr', 'kr', 'KR', '']) {
    const q = av ? { region: 'kr', chartAttributeValue: av } : { region: 'kr' };
    const d = await browseWithClient(BROWSE_ENDPOINT, {
      browseId: 'FEmusic_analytics_charts_home', query: JSON.stringify(q), context: { client: baseClient },
    }, `charts_home KR av="${av}"`, baseClient);
    if (d) {
      const pm = d?.contents?.sectionListRenderer?.contents?.[0]?.musicAnalyticsSectionRenderer?.content?.perspectiveMetadata;
      console.log(`    entityId: ${pm?.entityId}`);
    }
    await delay(150);
  }

  // Step 5: Try browseId = entityId itself
  console.log('\n=== Step 5: browseId = entityId / period-like IDs ===');
  for (const bId of [
    'weekly:20260717:20260723:us',
    'weekly:20260717:20260723:kr',
    'FEmusic_analytics_charts_detail_videos',
    'FEmusic_analytics_charts_detail_tracks',
  ]) {
    const d = await browseWithClient(BROWSE_ENDPOINT, {
      browseId: bId,
      query: JSON.stringify({ region: 'kr', chartType: 3, periodType: 2 }),
      context: { client: baseClient },
    }, `browseId="${bId.slice(0,40)}"`, baseClient);
    if (d) printEntities(d);
    await delay(150);
  }

  // Step 6: Try youtube.com InnerTube endpoint (not charts.youtube.com)
  console.log('\n=== Step 6: youtube.com endpoint with same browseId ===');
  const ytClient = { ...baseClient, clientName: 'WEB', clientVersion: '2.20260720' };
  const d_yt = await browseWithClient('https://www.youtube.com/youtubei/v1/browse', {
    browseId: 'FEmusic_analytics_charts_detail',
    query: JSON.stringify({ region: 'kr', chartType: 3, periodType: 2, chartAttributeValue: 'weekly:20260717:20260723:kr' }),
    context: { client: ytClient },
  }, 'youtube.com charts_detail KR', ytClient);
  if (d_yt) printEntities(d_yt);

  await delay(200);

  // Step 7: Try charts_detail with different endDate formats and minimal params
  console.log('\n=== Step 7: charts_detail various date formats ===');
  for (const [desc, q] of [
    ['endDate dashes', { region: 'us', chartType: 3, periodType: 2, endDate: '2026-07-23', chartAttributeValue: 'weekly:20260717:20260723:us' }],
    ['no periodType', { region: 'us', chartType: 3, endDate: '20260723', chartAttributeValue: 'weekly:20260717:20260723:us' }],
    ['chartType string', { region: 'us', chartType: 'CHART_TYPE_VIDEOS', periodType: 2, chartAttributeValue: 'weekly:20260717:20260723:us' }],
    ['chartAttr = entityId no endDate', { region: 'us', chartType: 3, periodType: 2, chartAttributeValue: 'weekly:20260717:20260723:us' }],
  ]) {
    const d = await browseWithClient(BROWSE_ENDPOINT, {
      browseId: 'FEmusic_analytics_charts_detail',
      query: JSON.stringify(q),
      context: { client: baseClient },
    }, `detail ${desc}`, baseClient);
    if (d) printEntities(d);
    await delay(150);
  }

  // Step 8: Try a completely different body format — browseId in URL, no query
  console.log('\n=== Step 8: browseId in URL path ===');
  const d_path = await browseWithClient(
    `${BROWSE_ENDPOINT}?browseId=FEmusic_analytics_charts_detail`,
    { query: JSON.stringify({ region: 'kr', chartType: 3, periodType: 2 }), context: { client: baseClient } },
    'browseId in URL',
    baseClient
  );
  if (d_path) printEntities(d_path);

  // Step 9: Scan HTML for any API patterns
  console.log('\n=== Step 9: Scan HTML for API clues ===');
  const apiPatterns = [
    { name: 'api endpoints', re: /https?:\/\/[a-z.]+\.[a-z]+\/api\/[^\s"'<>]{5,60}/g },
    { name: 'chart api calls', re: /chart[_A-Z][^"';,\s]{0,60}/g },
    { name: 'fetch calls', re: /fetch\([^)]{10,80}\)/g },
  ];
  for (const { name, re } of apiPatterns) {
    const hits = [...new Set([...html.matchAll(re)].map(m => m[0]))];
    console.log(`  ${name} (${hits.length}): ${hits.slice(0, 5).join(' | ')}`);
  }

  console.log('\n=== Probe v18 complete ===');
}

main().catch(e => { console.error(e); process.exit(1); });
