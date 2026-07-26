/**
 * Probe v14:
 * - v13 revealed: FEmusic_analytics_charts_home returns 258KB for all regions,
 *   uses atvExternalVideoId (not videoId), artists array with name objects.
 *   Zero musicResponsiveListItemRenderer — custom chart entity format.
 * - All regions returned same 258KB → need to inspect actual contents structure.
 * - FEmusic_analytics_charts_detail → 400 for chartType 0-3,7.
 *
 * This version:
 * 1. Dumps the full structure of FEmusic_analytics_charts_home contents.
 * 2. Extracts all chart track entities (atvExternalVideoId, rank, artists).
 * 3. Searches bundle for chartType enum constants.
 * 4. Tests FEmusic_analytics_charts_detail with different endDate (last 4 weeks)
 *    and chartType as string ("TopVideos","TopSongs","1","2").
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ARTISTS = ['BLACKPINK', 'JENNIE', 'JISOO', 'ROSÉ', 'ROSA', 'LISA', 'Less Than a Lover'];
const ENDPOINT = 'https://charts.youtube.com/youtubei/v1/browse';

function snip(v, max = 300) { return String(v).length > max ? String(v).slice(0, max) + '…' : String(v); }

function deepFind(obj, pred, acc = []) {
  if (!obj || typeof obj !== 'object') return acc;
  if (pred(obj)) acc.push(obj);
  for (const v of Object.values(obj)) deepFind(v, pred, acc);
  return acc;
}

async function fetchYtcfg() {
  const r = await fetch('https://charts.youtube.com/charts/TopVideos/KR', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const html = await r.text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+\.js[^"]*)"/gi)].map(m => m[1]);
  const setCalls = [...html.matchAll(/ytcfg\.set\s*\(\s*(\{[\s\S]*?\})\s*\)/g)];
  let cfg = {};
  for (const [, j] of setCalls) {
    try { Object.assign(cfg, JSON.parse(j)); } catch {}
  }
  return { cfg, scripts };
}

async function browse(browseId, queryObj, clientCtx, label) {
  const body = {
    browseId,
    query: JSON.stringify(queryObj),
    context: { client: clientCtx },
  };
  console.log(`\n=== [${label}] ===`);
  const r = await fetch(ENDPOINT, {
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
  console.log(`  HTTP ${r.status}`);
  const ct = r.headers.get('content-type') ?? '';
  if (!r.ok || !ct.includes('json')) {
    const txt = await r.text();
    let parsed; try { parsed = JSON.parse(txt); } catch {}
    if (parsed?.error) console.log(`  error: ${parsed.error.status} — ${parsed.error.message}`);
    else console.log(`  ${snip(txt, 300)}`);
    return null;
  }
  const data = await r.json();
  console.log(`  size: ${JSON.stringify(data).length} bytes`);
  return data;
}

function dumpStructure(obj, prefix = '', depth = 0) {
  if (depth > 4 || !obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      console.log(`${prefix}${k}: Array(${v.length})`);
      if (v.length > 0 && typeof v[0] === 'object') dumpStructure(v[0], prefix + '  [0].', depth + 1);
    } else if (v && typeof v === 'object') {
      console.log(`${prefix}${k}: {${Object.keys(v).join(', ')}}`);
      dumpStructure(v, prefix + '  ', depth + 1);
    } else {
      console.log(`${prefix}${k}: ${snip(String(v), 80)}`);
    }
  }
}

function extractChartEntities(data) {
  const raw = JSON.stringify(data);

  // Find all objects with atvExternalVideoId (the chart track format)
  const entities = deepFind(data, o => typeof o.atvExternalVideoId === 'string');
  console.log(`\n  Chart entities (atvExternalVideoId): ${entities.length}`);
  entities.slice(0, 20).forEach((e, i) => {
    const artists = (e.artists ?? []).map(a => a.name).join(', ');
    const rank = e.chartPosition ?? e.rank ?? e.position ?? e.weeklyPosition ?? '?';
    const title = e.title ?? e.name ?? e.songTitle ?? '?';
    console.log(`  [${String(i+1).padStart(2)}] rank=${rank} "${title}" — ${artists} (${e.atvExternalVideoId})`);
  });

  // Also look for objects with 'rank' or 'chartPosition' fields
  const ranked = deepFind(data, o => typeof o.rank === 'number' || typeof o.chartPosition === 'number');
  console.log(`\n  Objects with rank/chartPosition: ${ranked.length}`);
  ranked.slice(0, 5).forEach((r, i) => {
    console.log(`  [${i}] ${JSON.stringify(r).slice(0, 200)}`);
  });

  // Look for BLACKPINK/members
  for (const n of ARTISTS) {
    let pos = 0, count = 0;
    while ((pos = raw.indexOf(n, pos)) >= 0 && count < 3) {
      console.log(`  ★ "${n}" ctx: …${snip(raw.slice(Math.max(0, pos-60), pos+150), 220)}…`);
      pos++; count++;
    }
  }

  // Top-level contents keys
  console.log(`\n  contents keys: ${JSON.stringify(Object.keys(data.contents ?? {}))}`);

  // Find all distinct top-level keys of chart entity objects
  if (entities.length > 0) {
    const allKeys = [...new Set(entities.flatMap(e => Object.keys(e)))];
    console.log(`  entity keys: ${allKeys.join(', ')}`);
    console.log(`  First entity full: ${JSON.stringify(entities[0]).slice(0, 600)}`);
  }
}

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Get Sunday of the week containing the given date (or past Sunday)
function recentSundays(n) {
  const dates = [];
  const d = new Date('2026-07-26');
  // go back to most recent Sunday
  const day = d.getDay(); // 0=Sun
  d.setDate(d.getDate() - day); // most recent Sunday
  for (let i = 0; i < n; i++) {
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    dates.push(`${y}${m}${dd}`);
    d.setDate(d.getDate() - 7);
  }
  return dates;
}

async function main() {
  const { cfg, scripts } = await fetchYtcfg();
  const client = cfg.INNERTUBE_CONTEXT?.client ?? {};
  const baseClient = { ...client, hl: 'en' };
  console.log(`  clientName: ${baseClient.clientName}, version: ${baseClient.clientVersion}`);

  // Step 1: Fetch charts_home KR and dump full structure
  const d_kr = await browse('FEmusic_analytics_charts_home', { region: 'kr' }, baseClient, 'charts_home KR');
  if (d_kr) {
    console.log('\n--- Full structure of response.contents ---');
    dumpStructure(d_kr.contents, '  ');
    extractChartEntities(d_kr);
  }

  await delay(400);

  // Step 2: Inspect bundle for chartType values
  console.log('\n=== Step 2: Bundle chartType constants ===');
  const polymerUrl = scripts.find(s => s.includes('charts_polymer'));
  if (polymerUrl) {
    const bundleUrl = polymerUrl.startsWith('http') ? polymerUrl : `https://charts.youtube.com${polymerUrl}`;
    const r = await fetch(bundleUrl, { headers: { 'User-Agent': UA } });
    const js = await r.text();

    // Search for chartType-related constants
    const searches = [
      { name: 'chartType values', re: /chartType[^{;,]{0,20}[:=][^{;,]{0,50}/g },
      { name: 'TopVideos/TopSongs string', re: /["'](Top(?:Videos?|Songs?|Albums?|Artists?|Trending)[^"']{0,30})["']/g },
      { name: 'chart_type enum', re: /(?:CHART_TYPE|ChartType)[^;{]{0,100}/g },
      { name: 'periodType values', re: /periodType[^{;,]{0,20}[:=][^{;,]{0,50}/g },
    ];

    for (const { name, re } of searches) {
      const hits = [...new Set([...js.matchAll(re)].map(m => m[0].trim()))];
      console.log(`\n  ${name} (${hits.length}):`);
      hits.slice(0, 15).forEach(h => console.log(`    ${snip(h, 120)}`));
    }

    // Search around "charts_detail" in bundle
    let pos = 0;
    const detailSnippets = [];
    while ((pos = js.indexOf('charts_detail', pos)) >= 0) {
      detailSnippets.push(snip(js.slice(Math.max(0, pos-50), pos+200).replace(/\s+/g, ' '), 280));
      pos++;
    }
    console.log(`\n  'charts_detail' contexts (${detailSnippets.length}):`);
    [...new Set(detailSnippets)].slice(0, 10).forEach((s, i) => console.log(`  [${i}] ${s}`));
  }

  await delay(300);

  // Step 3: Try charts_detail with different endDates (recent Sundays) and chartType strings
  console.log('\n=== Step 3: charts_detail with various endDates and chartTypes ===');
  const sundays = recentSundays(4);
  console.log(`  Testing dates: ${sundays.join(', ')}`);

  // Try chartType as string values
  const chartTypes = ['TopVideos', 'TopSongs', '0', '1', '2', 'top_videos', 'top_songs', 4, 5, 6];
  const periodTypes = [0, 1, 2];

  // First try: one recent Sunday, multiple chartType strings
  for (const ct of chartTypes.slice(0, 6)) {
    const d = await browse(
      'FEmusic_analytics_charts_detail',
      { region: 'kr', chartType: ct, periodType: 1, endDate: sundays[0] },
      baseClient,
      `detail KR chartType="${ct}" date=${sundays[0]}`
    );
    if (d) { console.log('  SUCCESS!'); extractChartEntities(d); }
    await delay(200);
  }

  // Try without endDate
  const dNoDate = await browse(
    'FEmusic_analytics_charts_detail',
    { region: 'kr', chartType: 1, periodType: 1 },
    baseClient,
    'detail KR no endDate'
  );
  if (dNoDate) { console.log('  SUCCESS no endDate!'); extractChartEntities(dNoDate); }

  await delay(200);

  // Try different periodTypes with chartType=1
  for (const pt of periodTypes) {
    const d = await browse(
      'FEmusic_analytics_charts_detail',
      { region: 'kr', chartType: 1, periodType: pt, endDate: sundays[0] },
      baseClient,
      `detail KR periodType=${pt}`
    );
    if (d) { console.log(`  SUCCESS periodType=${pt}!`); extractChartEntities(d); }
    await delay(150);
  }

  // Try older dates
  for (const date of sundays.slice(1)) {
    const d = await browse(
      'FEmusic_analytics_charts_detail',
      { region: 'kr', chartType: 1, periodType: 1, endDate: date },
      baseClient,
      `detail KR date=${date}`
    );
    if (d) { console.log(`  SUCCESS date=${date}!`); extractChartEntities(d); }
    await delay(200);
  }

  console.log('\n=== Probe v14 complete ===');
}

main().catch(e => { console.error(e); process.exit(1); });
