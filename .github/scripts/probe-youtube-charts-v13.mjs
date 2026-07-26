/**
 * Probe v13:
 * - v12 BREAKTHROUGH: FEmusic_analytics_charts_home returns HTTP 200 (658KB!)
 *   containing BLACKPINK, JENNIE, ROSÉ on charts.youtube.com.
 * - Bundle reveals: query: JSON.stringify({region: "kr"}) selects the country.
 * - FEmusic_analytics_charts_detail needs: query={region,chartType,periodType,endDate}.
 *
 * This version:
 * 1. Fetches FEmusic_analytics_charts_home with region=kr and region=global.
 * 2. Fully parses the response to extract ranked tracks + chart structure.
 * 3. Tries FEmusic_analytics_charts_detail with different chartType values (0-8).
 * 4. Prints the first 20 ranked tracks for KR.
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
  const setCalls = [...html.matchAll(/ytcfg\.set\s*\(\s*(\{[\s\S]*?\})\s*\)/g)];
  let cfg = {};
  for (const [, j] of setCalls) {
    try { Object.assign(cfg, JSON.parse(j)); } catch {}
  }
  return cfg;
}

async function browse(browseId, queryObj, clientCtx, label) {
  const body = {
    browseId,
    query: JSON.stringify(queryObj),
    context: { client: clientCtx },
  };
  console.log(`\n=== [${label}] browseId="${browseId}" query=${JSON.stringify(queryObj)} ===`);
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
  console.log(`  keys: ${Object.keys(data).join(', ')}`);
  return data;
}

function analyzeChartsHome(data, label) {
  const raw = JSON.stringify(data);
  console.log(`\n--- Analyzing [${label}] ---`);

  // Artist mentions
  for (const n of ARTISTS) {
    const idx = raw.indexOf(n);
    if (idx >= 0) console.log(`  ★ "${n}" at idx ${idx}: …${raw.slice(Math.max(0, idx-40), idx+100)}…`);
  }

  // Find all text runs
  const allRuns = deepFind(data, o => Array.isArray(o.runs) && o.runs[0]?.text);
  const texts = [...new Set(allRuns.map(o => o.runs.map(r => r.text).join('')))];
  console.log(`  unique text runs (${texts.length}), first 30:`);
  texts.slice(0, 30).forEach((t, i) => console.log(`    [${i}] ${snip(t, 100)}`));

  // Find musicResponsiveListItemRenderer (track list)
  const listItems = deepFind(data, o => o.musicResponsiveListItemRenderer != null);
  console.log(`\n  musicResponsiveListItemRenderers: ${listItems.length}`);
  if (listItems.length > 0) {
    console.log(`  First 20 tracks:`);
    listItems.slice(0, 20).forEach((it, i) => {
      const li = it.musicResponsiveListItemRenderer;
      const cols = li.flexColumns ?? [];
      const texts = cols.map(c =>
        c.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map(r => r.text)?.join('') ?? ''
      );
      const rank = li.index?.runs?.[0]?.text ?? String(i + 1);
      console.log(`    [${rank}] ${texts.join(' | ')}`);
    });
  }

  // Find sections / carousels
  const sections = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
    ?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
  console.log(`\n  sections: ${sections.length}`);
  sections.forEach((section, si) => {
    const keys = Object.keys(section);
    console.log(`  section[${si}]: ${keys.join(', ')}`);
    const shelf = section.musicShelfRenderer ?? section.musicCarouselShelfRenderer;
    if (shelf) {
      const headerRuns = deepFind(shelf.header ?? {}, o => Array.isArray(o.runs) && o.runs[0]?.text);
      const headerText = headerRuns[0]?.runs?.[0]?.text ?? '(no header)';
      const items = shelf.contents ?? [];
      console.log(`    → header="${headerText}", items=${items.length}`);
      items.slice(0, 5).forEach((item, ii) => {
        const keys2 = Object.keys(item);
        console.log(`      item[${ii}]: ${keys2.join(', ')}`);
      });
    }
  });

  // Mutations
  const mutations = data?.frameworkUpdates?.entityBatchUpdate?.mutations ?? [];
  console.log(`\n  mutations: ${mutations.length}`);
  if (mutations.length > 0) {
    const types = [...new Set(mutations.map(m => Object.keys(m.payload ?? {}).join('+')))];
    console.log(`  mutation payload types: ${types.join(' | ')}`);
    // Print first 2 mutations in detail
    mutations.slice(0, 2).forEach((m, i) => {
      console.log(`  mutation[${i}]: ${JSON.stringify(m).slice(0, 500)}`);
    });
  }

  // Video IDs
  const videoIds = [...raw.matchAll(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g)].map(m => m[1]);
  console.log(`\n  videoIds: ${videoIds.length}, first 20: ${videoIds.slice(0, 20).join(', ')}`);
}

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const cfg = await fetchYtcfg();
  const client = cfg.INNERTUBE_CONTEXT?.client ?? {};
  const baseClient = { ...client, hl: 'en' };

  console.log(`  clientName: ${baseClient.clientName}, version: ${baseClient.clientVersion}`);
  await delay(200);

  // Test 1: FEmusic_analytics_charts_home with region=kr
  const d_kr = await browse('FEmusic_analytics_charts_home', { region: 'kr' }, baseClient, 'charts_home KR');
  if (d_kr) analyzeChartsHome(d_kr, 'charts_home KR');

  await delay(400);

  // Test 2: FEmusic_analytics_charts_home with region=global
  const d_global = await browse('FEmusic_analytics_charts_home', { region: 'global' }, baseClient, 'charts_home Global');
  if (d_global) {
    const raw = JSON.stringify(d_global);
    for (const n of ARTISTS) {
      const idx = raw.indexOf(n);
      if (idx >= 0) console.log(`  ★ "${n}" in Global: …${raw.slice(Math.max(0, idx-30), idx+80)}…`);
    }
  }

  await delay(400);

  // Test 3: FEmusic_analytics_charts_home with region=us (baseline)
  const d_us = await browse('FEmusic_analytics_charts_home', { region: 'us' }, baseClient, 'charts_home US');
  if (d_us) {
    const raw = JSON.stringify(d_us);
    for (const n of ARTISTS) {
      const idx = raw.indexOf(n);
      if (idx >= 0) console.log(`  ★ "${n}" in US: …${raw.slice(Math.max(0, idx-30), idx+80)}…`);
    }
  }

  await delay(400);

  // Test 4: FEmusic_analytics_charts_detail with different chartTypes
  // From bundle: chartType values appear to be numbers. Try 0-4, and 7.
  console.log('\n=== Step 4: Try FEmusic_analytics_charts_detail ===');
  // Need endDate — try today and recent dates
  const today = new Date();
  const endDate = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
  console.log(`  Using endDate: ${endDate}`);

  for (const chartType of [0, 1, 2, 3, 7]) {
    const d = await browse(
      'FEmusic_analytics_charts_detail',
      { region: 'kr', chartType, periodType: 1, endDate },
      baseClient,
      `charts_detail KR chartType=${chartType}`
    );
    if (d) {
      const raw = JSON.stringify(d);
      const listItems = deepFind(d, o => o.musicResponsiveListItemRenderer != null);
      console.log(`  chartType=${chartType}: ${listItems.length} tracks`);
      listItems.slice(0, 5).forEach((it, i) => {
        const li = it.musicResponsiveListItemRenderer;
        const cols = li.flexColumns ?? [];
        const texts = cols.map(c =>
          c.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map(r => r.text)?.join('') ?? ''
        );
        console.log(`    [${i+1}] ${texts.join(' | ')}`);
      });
      for (const n of ARTISTS) {
        if (raw.includes(n)) console.log(`  ★ "${n}" found in chartType=${chartType}!`);
      }
    }
    await delay(300);
  }

  console.log('\n=== Probe v13 complete ===');
}

main().catch(e => { console.error(e); process.exit(1); });
