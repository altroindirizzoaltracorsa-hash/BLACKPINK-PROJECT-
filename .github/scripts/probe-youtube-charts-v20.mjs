/**
 * Probe v20:
 *
 * v19 CRITICAL FINDINGS:
 *   - charts_home gl:"KR" → entityId: "weekly:20260717:20260723:kr" ✅ KR data confirmed
 *   - charts_home gl:"KR" → chartPeriods count: 430 with KR IDs ✅
 *   - charts_detail ALWAYS returns 400 regardless of gl, chartType, params — requires auth
 *
 * KEY INSIGHT: charts_home with gl:"KR" is 270KB and contains content.videos, content.artists, etc.
 * We've NEVER called printEntities on it! If it contains chart entries, we don't need charts_detail.
 *
 * Plan for v20:
 *   A. charts_home gl:"KR" — extract ALL entities (videos, artists, tracks)
 *      Dump full content structure of musicAnalyticsSectionRenderer
 *   B. Also try other regions: JP, GB, global, US for comparison
 *   C. Check if charts_home response varies by chartType (it probably returns all types at once)
 *   D. Try fetching specific chart type pages: /charts/TopVideos/KR, /charts/TopSongs/KR
 *      and check if chart data is embedded in the HTML itself (SSR/initial data)
 *   E. Check what historical periods look like: fetch with an older period's endDate
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BROWSE = 'https://charts.youtube.com/youtubei/v1/browse';

function snip(v, max = 300) { return String(v).length > max ? String(v).slice(0, max) + '…' : String(v); }
function deepFind(obj, pred, acc = []) {
  if (!obj || typeof obj !== 'object') return acc;
  if (pred(obj)) acc.push(obj);
  for (const v of Object.values(obj)) deepFind(v, pred, acc);
  return acc;
}
async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPageCfg(url = 'https://charts.youtube.com/charts/TopVideos/KR') {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
  const html = await r.text();
  const setCalls = [...html.matchAll(/ytcfg\.set\s*\(\s*(\{[\s\S]*?\})\s*\)/g)];
  let cfg = {};
  for (const [, j] of setCalls) { try { Object.assign(cfg, JSON.parse(j)); } catch {} }
  return { cfg, html };
}

async function browse(label, bodyObj) {
  console.log(`\n=== [${label}] ===`);
  const r = await fetch(BROWSE, {
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

function inspectContent(data) {
  const content = data?.contents?.sectionListRenderer?.contents?.[0]
    ?.musicAnalyticsSectionRenderer?.content;
  if (!content) { console.log('  content: (not found at expected path)'); return; }

  console.log(`  content keys: ${Object.keys(content).join(', ')}`);

  const pm = content.perspectiveMetadata;
  if (pm) {
    console.log(`  entityId: ${pm.entityId}`);
    console.log(`  chartPeriods: ${pm.chartPeriods?.length ?? 'none'}`);
    if (pm.chartPeriods?.length > 0) {
      const p = pm.chartPeriods[0];
      console.log(`    latest period: id="${p.id}" end=${p.endTime}`);
    }
  }

  // Videos
  if (content.videos) {
    console.log(`  videos count: ${content.videos.length}`);
    content.videos.slice(0, 5).forEach(v => {
      const pos = v.chartEntryMetadata?.currentPosition ?? '?';
      const arts = (v.artists ?? []).map(a => a.name).join(', ');
      console.log(`    #${pos} "${v.name}" — ${arts} [videoId: ${v.encryptedVideoId ?? v.atvExternalVideoId ?? '?'}]`);
    });
  }

  // Tracks/songs
  if (content.tracks) {
    console.log(`  tracks count: ${content.tracks.length}`);
    content.tracks.slice(0, 3).forEach(t => {
      const pos = t.chartEntryMetadata?.currentPosition ?? '?';
      const arts = (t.artists ?? []).map(a => a.name).join(', ');
      console.log(`    #${pos} "${t.name}" — ${arts}`);
    });
  }

  // Artists
  if (content.artists) {
    console.log(`  artists count: ${content.artists.length}`);
    content.artists.slice(0, 3).forEach(a => {
      const pos = a.chartEntryMetadata?.currentPosition ?? '?';
      console.log(`    #${pos} "${a.name}"`);
    });
  }

  // trackTypes (chart type selection info)
  if (content.trackTypes) {
    console.log(`  trackTypes: ${JSON.stringify(content.trackTypes).slice(0, 200)}`);
  }

  // Any other chart entry arrays
  const allEntities = deepFind(data, o => typeof o.atvExternalVideoId === 'string');
  console.log(`  total atvExternalVideoId entities: ${allEntities.length}`);
}

async function main() {
  console.log('=== Fetch base client ===');
  const { cfg } = await fetchPageCfg();
  const baseClient = { ...(cfg.INNERTUBE_CONTEXT?.client ?? {}), hl: 'en' };
  const krClient = { ...baseClient, gl: 'KR', hl: 'ko' };
  console.log(`  gl: ${baseClient.gl}, clientName: ${baseClient.clientName}`);

  // Step A: charts_home gl:KR — full content inspection
  console.log('\n=== Step A: charts_home gl:KR — full content ===');
  const homeKR = await browse('charts_home gl=KR', {
    browseId: 'FEmusic_analytics_charts_home',
    query: JSON.stringify({ region: 'kr' }),
    context: { client: krClient },
  });
  if (homeKR) inspectContent(homeKR);

  await delay(300);

  // Step B: charts_home gl:JP
  console.log('\n=== Step B: charts_home gl:JP ===');
  const jpClient = { ...baseClient, gl: 'JP', hl: 'ja' };
  const homeJP = await browse('charts_home gl=JP', {
    browseId: 'FEmusic_analytics_charts_home',
    query: JSON.stringify({ region: 'jp' }),
    context: { client: jpClient },
  });
  if (homeJP) inspectContent(homeJP);

  await delay(200);

  // Step C: charts_home gl:GB (UK)
  console.log('\n=== Step C: charts_home gl:GB ===');
  const gbClient = { ...baseClient, gl: 'GB' };
  const homeGB = await browse('charts_home gl=GB', {
    browseId: 'FEmusic_analytics_charts_home',
    query: JSON.stringify({ region: 'gb' }),
    context: { client: gbClient },
  });
  if (homeGB) inspectContent(homeGB);

  await delay(200);

  // Step D: charts_home gl:US — confirm entities exist (baseline)
  console.log('\n=== Step D: charts_home gl:US — baseline entity check ===');
  const homeUS = await browse('charts_home gl=US', {
    browseId: 'FEmusic_analytics_charts_home',
    query: JSON.stringify({ region: 'us' }),
    context: { client: baseClient },
  });
  if (homeUS) inspectContent(homeUS);

  await delay(200);

  // Step E: Check if HTML page has embedded chart data (SSR)
  console.log('\n=== Step E: Scan HTML for embedded chart data ===');
  for (const pageUrl of [
    'https://charts.youtube.com/charts/TopVideos/KR',
    'https://charts.youtube.com/charts/TopSongs/KR',
  ]) {
    console.log(`\n  Fetching: ${pageUrl}`);
    const { html } = await fetchPageCfg(pageUrl);
    // Look for embedded JSON data
    const hasEntities = html.includes('atvExternalVideoId') || html.includes('chartEntryMetadata');
    const hasInitData = html.includes('ytInitialData') || html.includes('initialData');
    const hasChartEntry = html.includes('chartEntries') || html.includes('chartEntry');
    console.log(`    atvExternalVideoId in HTML: ${hasEntities}`);
    console.log(`    ytInitialData in HTML: ${hasInitData}`);
    console.log(`    chartEntr* in HTML: ${hasChartEntry}`);
    // Try to extract any JSON blobs
    const jsonMatches = [...html.matchAll(/(?:ytInitialData|__INITIAL_DATA__|initialData)\s*=\s*(\{)/g)];
    console.log(`    JSON blob patterns: ${jsonMatches.length}`);
    // Look for "TopVideos" data in script tags
    const topVideosInScript = html.includes('"TopVideos"') || html.includes("'TopVideos'");
    console.log(`    "TopVideos" string in HTML: ${topVideosInScript}`);
    // How large is the HTML?
    console.log(`    HTML size: ${html.length} chars`);
  }

  await delay(200);

  // Step F: charts_home gl:KR with older period (historical data)
  console.log('\n=== Step F: charts_home gl:KR older period (2026-07-16) ===');
  const homeKR_old = await browse('charts_home gl=KR query with endDate', {
    browseId: 'FEmusic_analytics_charts_home',
    query: JSON.stringify({ region: 'kr', endDate: '20260716' }),
    context: { client: krClient },
  });
  if (homeKR_old) {
    const pm = homeKR_old?.contents?.sectionListRenderer?.contents?.[0]
      ?.musicAnalyticsSectionRenderer?.content?.perspectiveMetadata;
    console.log(`  entityId: ${pm?.entityId}`);
    const content = homeKR_old?.contents?.sectionListRenderer?.contents?.[0]
      ?.musicAnalyticsSectionRenderer?.content;
    if (content?.videos) {
      console.log(`  videos count: ${content.videos.length}`);
      content.videos.slice(0, 3).forEach(v => {
        const pos = v.chartEntryMetadata?.currentPosition ?? '?';
        const arts = (v.artists ?? []).map(a => a.name).join(', ');
        console.log(`    #${pos} "${v.name}" — ${arts}`);
      });
    }
  }

  console.log('\n=== Probe v20 complete ===');
}

main().catch(e => { console.error(e); process.exit(1); });
