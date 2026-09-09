/**
 * Probe v21:
 *
 * v20 CRITICAL FINDINGS:
 *   - charts_home gl:"KR" → 97 atvExternalVideoId entities ✅ (JP:90, GB:91, US:94)
 *   - content keys: artists, perspectiveMetadata, trackTypes, videos
 *   - content.videos has 2 entries (chart-type containers, not individual songs)
 *   - content.trackTypes[0].trackViews has actual entries: {id:"G:...", name, viewCount}
 *   - HTML is pure SPA shell (61KB), no SSR chart data
 *   - endDate in query is ignored — always returns latest period
 *
 * Plan for v21:
 *   A. Dump the first few atvExternalVideoId entities from KR → see full field structure
 *      (position, name, artists, videoId, viewCount, etc.)
 *   B. Search ALL entities for BLACKPINK member names (BLACKPINK, Lisa, Jennie, Rosé, Jisoo)
 *   C. Confirm encryptedVideoId maps to a real YouTube video ID
 *   D. Confirm chartEntryMetadata.currentPosition is present
 *   E. Try the same for other regions to confirm the approach works globally
 *   F. Look at what content.videos[0] and content.artists[0] actually contain (full dump)
 *   G. Check if historical data is accessible via a different param
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BROWSE = 'https://charts.youtube.com/youtubei/v1/browse';

const BLACKPINK_NAMES = ['blackpink', 'lisa', 'jennie', 'rosé', 'rose', 'jisoo', 'lalisa',
  'bp', 'blink', '블랙핑크', '리사', '제니', '로제', '지수'];

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
  const setCalls = [...html.matchAll(/ytcfg\.set\s*\(\s*(\{[\s\S]*?\})\s*\)/g)];
  let cfg = {};
  for (const [, j] of setCalls) { try { Object.assign(cfg, JSON.parse(j)); } catch {} }
  return { cfg };
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
  if (!r.ok) { const t = await r.text(); console.log(`  ${snip(t,200)}`); return null; }
  const data = await r.json();
  console.log(`  size: ${JSON.stringify(data).length}`);
  return data;
}

function searchForBlackpink(entities) {
  const hits = [];
  for (const e of entities) {
    const entityName = (e.name ?? '').toLowerCase();
    const artistNames = (e.artists ?? []).map(a => (a.name ?? '').toLowerCase()).join(' ');
    const combined = entityName + ' ' + artistNames;
    if (BLACKPINK_NAMES.some(n => combined.includes(n))) {
      hits.push(e);
    }
  }
  return hits;
}

function dumpEntities(data, label, limit = 5) {
  const entities = deepFind(data, o => typeof o.atvExternalVideoId === 'string');
  console.log(`  ${label}: ${entities.length} entities total`);

  // Sort by position if available
  entities.sort((a, b) => {
    const posA = a.chartEntryMetadata?.currentPosition ?? 999;
    const posB = b.chartEntryMetadata?.currentPosition ?? 999;
    return posA - posB;
  });

  // Print top N
  console.log(`  Top ${limit} entries:`);
  entities.slice(0, limit).forEach(e => {
    const pos = e.chartEntryMetadata?.currentPosition ?? '?';
    const name = e.name ?? '(no name)';
    const arts = (e.artists ?? []).map(a => a.name).join(', ') || '(no artists)';
    const vid = e.encryptedVideoId ?? e.atvExternalVideoId ?? '?';
    const views = e.views ?? e.viewCount ?? '';
    console.log(`    #${pos} "${name}" — ${arts} [${vid}]${views ? ' (' + views + ' views)' : ''}`);
  });

  // Look for BLACKPINK
  const bp = searchForBlackpink(entities);
  console.log(`  BLACKPINK hits: ${bp.length}`);
  bp.forEach(e => {
    const pos = e.chartEntryMetadata?.currentPosition ?? '?';
    const name = e.name ?? '?';
    const arts = (e.artists ?? []).map(a => a.name).join(', ');
    const vid = e.encryptedVideoId ?? e.atvExternalVideoId ?? '?';
    console.log(`    FOUND #${pos} "${name}" — ${arts} [${vid}]`);
  });

  // Print first entity's full field list (keys only)
  if (entities.length > 0) {
    console.log(`  First entity keys: ${Object.keys(entities[0]).join(', ')}`);
    const e0 = entities[0];
    console.log(`  First entity sample: ${JSON.stringify(e0).slice(0, 400)}`);
  }

  return entities;
}

async function main() {
  console.log('=== Fetch base client ===');
  const { cfg } = await fetchPageCfg();
  const baseClient = { ...(cfg.INNERTUBE_CONTEXT?.client ?? {}), hl: 'en' };
  console.log(`  gl: ${baseClient.gl}, clientName: ${baseClient.clientName}`);

  // Step A+B: KR full entity dump + BLACKPINK search
  console.log('\n=== Step A+B: charts_home gl:KR — entities + BLACKPINK search ===');
  const krData = await browse('charts_home gl=KR', {
    browseId: 'FEmusic_analytics_charts_home',
    query: JSON.stringify({ region: 'kr' }),
    context: { client: { ...baseClient, gl: 'KR', hl: 'ko' } },
  });
  if (krData) dumpEntities(krData, 'KR chart', 10);

  await delay(300);

  // Step C: US full entity dump for comparison
  console.log('\n=== Step C: charts_home gl:US — baseline ===');
  const usData = await browse('charts_home gl=US', {
    browseId: 'FEmusic_analytics_charts_home',
    query: JSON.stringify({ region: 'us' }),
    context: { client: baseClient },
  });
  if (usData) dumpEntities(usData, 'US chart', 5);

  await delay(200);

  // Step D: JP entity dump
  console.log('\n=== Step D: charts_home gl:JP ===');
  const jpData = await browse('charts_home gl=JP', {
    browseId: 'FEmusic_analytics_charts_home',
    query: JSON.stringify({ region: 'jp' }),
    context: { client: { ...baseClient, gl: 'JP', hl: 'ja' } },
  });
  if (jpData) dumpEntities(jpData, 'JP chart', 3);

  await delay(200);

  // Step E: Dump content.videos[0] and content.trackTypes[0].trackViews[0] structure
  console.log('\n=== Step E: content sub-structure analysis ===');
  if (krData) {
    const content = krData?.contents?.sectionListRenderer?.contents?.[0]
      ?.musicAnalyticsSectionRenderer?.content;
    if (content) {
      console.log(`  content.videos[0] keys: ${Object.keys(content.videos?.[0] ?? {}).join(', ')}`);
      console.log(`  content.videos[0]: ${JSON.stringify(content.videos?.[0]).slice(0, 300)}`);
      console.log(`  content.artists[0] keys: ${Object.keys(content.artists?.[0] ?? {}).join(', ')}`);
      console.log(`  content.artists[0]: ${JSON.stringify(content.artists?.[0]).slice(0, 300)}`);
      const tv = content.trackTypes?.[0]?.trackViews;
      if (tv) {
        console.log(`  trackTypes[0].trackViews count: ${tv.length}`);
        console.log(`  trackTypes[0].trackViews[0] keys: ${Object.keys(tv[0] ?? {}).join(', ')}`);
        console.log(`  trackTypes[0].trackViews[0]: ${JSON.stringify(tv[0]).slice(0, 400)}`);
        // Is this where the atvExternalVideoId entities are?
        const hasAtv = tv.some(v => typeof v.atvExternalVideoId === 'string');
        console.log(`  trackViews has atvExternalVideoId: ${hasAtv}`);
      }
    }
  }

  await delay(200);

  // Step F: Global chart (no specific region)
  console.log('\n=== Step F: charts_home global ===');
  const globalData = await browse('charts_home global', {
    browseId: 'FEmusic_analytics_charts_home',
    query: JSON.stringify({ region: 'global' }),
    context: { client: { ...baseClient, gl: 'US' } },
  });
  if (globalData) {
    const pm = globalData?.contents?.sectionListRenderer?.contents?.[0]
      ?.musicAnalyticsSectionRenderer?.content?.perspectiveMetadata;
    console.log(`  entityId: ${pm?.entityId}`);
    dumpEntities(globalData, 'global chart', 3);
  }

  console.log('\n=== Probe v21 complete ===');
}

main().catch(e => { console.error(e); process.exit(1); });
