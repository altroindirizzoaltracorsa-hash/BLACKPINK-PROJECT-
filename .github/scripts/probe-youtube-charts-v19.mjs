/**
 * Probe v19:
 *
 * v18 CRITICAL FINDINGS:
 *   - P9a(chartType=3,...) returns undefined → chartAttributeValue should be ABSENT for TopVideos
 *   - chartPeriods IS populated in response (deep in tree), but all US IDs (gl:"US" locks it)
 *   - All charts_detail calls still 400 regardless of chartAttributeValue value
 *
 * v18 P9a definition:
 *   function P9a(a,b,c,d){
 *     if(a===8) return d;                                  // VIDEOS_LOP → return last period ID
 *     if(a===9 && b.toUpperCase()==="IN"){...}             // TRENDING_MOVIES India → language code
 *     // chartType 1,2,3,4,5,6 → returns undefined
 *   }
 *   So for chartType=3 (TopVideos), chartAttributeValue is undefined → omitted from JSON.stringify
 *
 * v19 Hypothesis:
 *   The `gl` field in client context is "US" (from page ytcfg).
 *   Server uses gl (not query.region) to determine which region's data to return.
 *   → charts_home with gl:"KR" should return KR periods
 *   → charts_detail with gl:"KR" should work for KR data
 *   → charts_detail 400 may be caused by gl:"US" + region:"kr" mismatch, or just by wrong params
 *
 * Plan for v19:
 *   A. charts_home with gl:"KR" → get KR chartPeriods, confirm entityId ends in ":kr"
 *   B. charts_detail with gl:"KR", no chartAttributeValue, endDate from step A periods
 *   C. charts_detail with gl:"US", no chartAttributeValue (correct params per bundle analysis)
 *   D. charts_detail with gl:"KR", chartType=2 (tracks) — different type
 *   E. charts_detail with gl:"KR", chartType=1 (artists)
 *   F. charts_home US to extract current chartPeriods for endDate sanity check
 *   G. Try charts_detail with empty context client (no gl, no remoteHost, nothing extra)
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
  console.log(`  body: ${JSON.stringify(bodyObj).slice(0, 250)}`);
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

function extractPeriods(data) {
  const objs = deepFind(data, o => Array.isArray(o.chartPeriods) && o.chartPeriods.length > 0);
  if (!objs.length) { console.log('  chartPeriods: (none found)'); return []; }
  const periods = objs[0].chartPeriods;
  console.log(`  chartPeriods count: ${periods.length}`);
  periods.slice(0, 5).forEach(p => console.log(`    id="${p.id}" start=${p.startTime} end=${p.endTime}`));
  return periods;
}

function extractEntityId(data) {
  const pm = data?.contents?.sectionListRenderer?.contents?.[0]?.musicAnalyticsSectionRenderer?.content?.perspectiveMetadata;
  if (pm?.entityId) console.log(`  entityId: ${pm.entityId}`);
  return pm?.entityId;
}

function printEntities(data) {
  const entities = deepFind(data, o => typeof o.atvExternalVideoId === 'string');
  console.log(`  entities: ${entities.length}`);
  entities.slice(0, 5).forEach(e => {
    const pos = e.chartEntryMetadata?.currentPosition ?? '?';
    const arts = (e.artists ?? []).map(a => a.name).join(', ');
    console.log(`    #${pos} "${e.name}" — ${arts}`);
  });
  return entities.length;
}

async function main() {
  // Fetch base client
  console.log('=== Fetch base client ===');
  const { cfg } = await fetchPageCfg();
  const baseClient = { ...(cfg.INNERTUBE_CONTEXT?.client ?? {}), hl: 'en' };
  const krClient = { ...baseClient, gl: 'KR', hl: 'ko' };
  const minClient = { clientName: 'WEB_MUSIC_ANALYTICS', clientVersion: '2.0' };
  console.log(`  gl (base): ${baseClient.gl}`);
  console.log(`  clientName: ${baseClient.clientName}`);

  // Step A: charts_home with gl:"KR" — should return KR data
  console.log('\n=== Step A: charts_home gl:KR ===');
  const homeKR = await browse('charts_home gl=KR', {
    browseId: 'FEmusic_analytics_charts_home',
    query: JSON.stringify({ region: 'kr' }),
    context: { client: krClient },
  });
  let krEndDate = '20260723'; // fallback
  if (homeKR) {
    extractEntityId(homeKR);
    const periods = extractPeriods(homeKR);
    if (periods.length > 0) {
      // endDate = end of most recent period (strip dashes)
      krEndDate = periods[0].endTime.replace(/-/g, '');
      console.log(`  → using endDate: ${krEndDate}`);
    }
  }

  await delay(300);

  // Step B: charts_detail gl:"KR", no chartAttributeValue (correct per P9a for type=3)
  console.log('\n=== Step B: charts_detail gl:KR, no chartAttributeValue, type=3 ===');
  const detailKR_noCAV = await browse('detail gl=KR type=3 no-chartAttr', {
    browseId: 'FEmusic_analytics_charts_detail',
    query: JSON.stringify({ region: 'kr', chartType: 3, periodType: 2, endDate: krEndDate }),
    context: { client: krClient },
  });
  if (detailKR_noCAV) printEntities(detailKR_noCAV);

  await delay(200);

  // Step C: charts_detail gl:"US", no chartAttributeValue (correct params per bundle)
  console.log('\n=== Step C: charts_detail gl:US, no chartAttributeValue, type=3 ===');
  const detailUS_noCAV = await browse('detail gl=US type=3 no-chartAttr', {
    browseId: 'FEmusic_analytics_charts_detail',
    query: JSON.stringify({ region: 'us', chartType: 3, periodType: 2, endDate: krEndDate }),
    context: { client: baseClient },
  });
  if (detailUS_noCAV) printEntities(detailUS_noCAV);

  await delay(200);

  // Step D: charts_detail gl:"KR", type=2 (tracks/songs)
  console.log('\n=== Step D: charts_detail gl:KR, type=2 (tracks) ===');
  const detailKR_t2 = await browse('detail gl=KR type=2 no-chartAttr', {
    browseId: 'FEmusic_analytics_charts_detail',
    query: JSON.stringify({ region: 'kr', chartType: 2, periodType: 2, endDate: krEndDate }),
    context: { client: krClient },
  });
  if (detailKR_t2) printEntities(detailKR_t2);

  await delay(200);

  // Step E: charts_detail gl:"KR", type=1 (artists)
  console.log('\n=== Step E: charts_detail gl:KR, type=1 (artists) ===');
  const detailKR_t1 = await browse('detail gl=KR type=1 no-chartAttr', {
    browseId: 'FEmusic_analytics_charts_detail',
    query: JSON.stringify({ region: 'kr', chartType: 1, periodType: 2, endDate: krEndDate }),
    context: { client: krClient },
  });
  if (detailKR_t1) printEntities(detailKR_t1);

  await delay(200);

  // Step F: charts_home gl:"KR" hl:"en" (hl in client but gl:KR) — check if hl matters
  console.log('\n=== Step F: charts_home gl:KR hl:en ===');
  const krEnClient = { ...baseClient, gl: 'KR' };
  const homeKR_en = await browse('charts_home gl=KR hl=en', {
    browseId: 'FEmusic_analytics_charts_home',
    query: JSON.stringify({ region: 'kr' }),
    context: { client: krEnClient },
  });
  if (homeKR_en) {
    extractEntityId(homeKR_en);
    extractPeriods(homeKR_en);
  }

  await delay(200);

  // Step G: charts_detail with minimal client (no gl, no remoteHost, etc.)
  console.log('\n=== Step G: charts_detail minimal client ===');
  const detailMin = await browse('detail minimal-client type=3', {
    browseId: 'FEmusic_analytics_charts_detail',
    query: JSON.stringify({ region: 'us', chartType: 3, periodType: 2, endDate: krEndDate }),
    context: { client: minClient },
  });
  if (detailMin) printEntities(detailMin);

  await delay(200);

  // Step H: charts_detail gl:KR minimal client
  console.log('\n=== Step H: charts_detail minimal client gl:KR ===');
  const detailMinKR = await browse('detail minimal-client gl=KR type=3', {
    browseId: 'FEmusic_analytics_charts_detail',
    query: JSON.stringify({ region: 'kr', chartType: 3, periodType: 2, endDate: krEndDate }),
    context: { client: { ...minClient, gl: 'KR' } },
  });
  if (detailMinKR) printEntities(detailMinKR);

  await delay(200);

  // Step I: charts_detail gl:KR, type=3, with chartAttributeValue from actual KR periods (if available)
  // Only run if we got actual KR periods in step A
  if (homeKR) {
    const objs = deepFind(homeKR, o => Array.isArray(o.chartPeriods) && o.chartPeriods.length > 0);
    if (objs.length > 0) {
      const latestId = objs[0].chartPeriods[0]?.id;
      if (latestId && latestId.endsWith(':kr')) {
        console.log(`\n=== Step I: charts_detail with KR period id="${latestId}" ===`);
        // For type=8, P9a returns the period ID — try type=8 with KR period
        const detailKR_t8 = await browse('detail gl=KR type=8 with-period-id', {
          browseId: 'FEmusic_analytics_charts_detail',
          query: JSON.stringify({ region: 'kr', chartType: 8, periodType: 2, endDate: krEndDate, chartAttributeValue: latestId }),
          context: { client: krClient },
        });
        if (detailKR_t8) printEntities(detailKR_t8);
      } else {
        console.log(`\n  Step I skipped — KR periods not found (got: ${latestId ?? 'none'})`);
      }
    }
  }

  console.log('\n=== Probe v19 complete ===');
}

main().catch(e => { console.error(e); process.exit(1); });
