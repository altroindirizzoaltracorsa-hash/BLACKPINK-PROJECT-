/**
 * Probe v16 — target FEmusic_analytics_charts_detail for KR.
 *
 * v15 CRITICAL FINDING:
 *   - FEmusic_analytics_charts_home always returns US data (entityId ends in :us)
 *   - chartPeriods format: "weekly:YYYYMMDD:YYYYMMDD:REGIONCODE"
 *   - For KR, chartAttributeValue should be "weekly:20260717:20260723:kr"
 *   - We tried "weekly:...:us" with region=kr → 400 (mismatch)
 *
 * This version:
 * 1. Tries charts_detail with chartAttributeValue = "weekly:...:kr" (proper KR format).
 * 2. Tries charts_detail for US with "weekly:...:us" (should work as baseline).
 * 3. Tries without chartAttributeValue but with correct chartType/periodType for US.
 * 4. Fetches charts.youtube.com/charts/TopVideos/KR HTML for embedded state data.
 * 5. If any detail call works, prints all BLACKPINK/member entries.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ARTISTS = ['BLACKPINK', 'JENNIE', 'JISOO', 'ROSÉ', 'ROSA', 'LISA'];
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
  return { cfg, html };
}

async function browse(browseId, queryObj, clientCtx, label) {
  const body = { browseId, query: JSON.stringify(queryObj), context: { client: clientCtx } };
  console.log(`\n=== [${label}] ===`);
  console.log(`  query: ${JSON.stringify(queryObj)}`);
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
    else console.log(`  ${snip(txt, 400)}`);
    return null;
  }
  const data = await r.json();
  console.log(`  size: ${JSON.stringify(data).length} bytes`);
  return data;
}

function printChartEntities(data, label) {
  const entities = deepFind(data, o => typeof o.atvExternalVideoId === 'string');
  const sorted = entities
    .map(e => ({ pos: e.chartEntryMetadata?.currentPosition ?? 9999, e }))
    .sort((a, b) => a.pos - b.pos);
  console.log(`  chart entities: ${sorted.length}`);
  sorted.slice(0, 10).forEach(({ pos, e }) => {
    const arts = (e.artists ?? []).map(a => a.name).join(', ');
    console.log(`  #${String(pos).padStart(3)} "${e.name}" — ${arts} [${e.encryptedVideoId}]`);
  });
  const perspId = data?.contents?.sectionListRenderer?.contents?.[0]
    ?.musicAnalyticsSectionRenderer?.content?.perspectiveMetadata?.entityId;
  if (perspId) console.log(`  entityId: ${perspId}`);
  // BLACKPINK filter
  const found = sorted.filter(({ e }) => {
    const arts = (e.artists ?? []).map(a => a.name);
    return ARTISTS.some(t => arts.some(a => a.includes(t)) || (e.name ?? '').includes(t));
  });
  if (found.length > 0) {
    console.log(`  ★ BLACKPINK/members:`);
    found.forEach(({ pos, e }) => {
      const arts = (e.artists ?? []).map(a => a.name).join(', ');
      console.log(`    #${pos} "${e.name}" — ${arts} [${e.encryptedVideoId}]`);
    });
  } else {
    console.log(`  (no BLACKPINK/members)`);
  }
}

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Get the most recent Thursday (YouTube Charts week end = Thursday)
function getLastThursdayRange() {
  const d = new Date('2026-07-26');
  // Find most recent Thursday
  const day = d.getDay(); // 0=Sun, 4=Thu
  const daysBack = (day - 4 + 7) % 7;
  const endD = new Date(d);
  endD.setDate(d.getDate() - daysBack);
  const startD = new Date(endD);
  startD.setDate(endD.getDate() - 6);
  const fmt = dt => `${dt.getFullYear()}${String(dt.getMonth()+1).padStart(2,'0')}${String(dt.getDate()).padStart(2,'0')}`;
  return { start: fmt(startD), end: fmt(endD) };
}

async function main() {
  const { cfg, html } = await fetchYtcfg();
  const client = cfg.INNERTUBE_CONTEXT?.client ?? {};
  const baseClient = { ...client, hl: 'en' };
  console.log(`  clientName: ${baseClient.clientName}, version: ${baseClient.clientVersion}`);

  // Step 1: Check page HTML for embedded chart state
  console.log('\n=== Step 1: Scan KR page HTML for chart data ===');
  // Look for ytInitialData or similar
  const initDataMatch = html.match(/ytInitialData\s*=\s*(\{.{1,200})/);
  if (initDataMatch) console.log(`  ytInitialData found: ${initDataMatch[1].slice(0, 100)}`);

  // Look for chart period IDs in HTML
  const krPeriodIds = [...html.matchAll(/"id"\s*:\s*"(weekly:[^"]+:kr)"/g)].map(m => m[1]);
  console.log(`  KR period IDs in HTML: ${krPeriodIds.length}`);
  krPeriodIds.slice(0, 5).forEach(id => console.log(`    ${id}`));

  // Look for any JSON blobs with chartPeriods
  const chartPeriodsMatch = html.match(/chartPeriods[^[]{0,20}\[([^\]]{0,300})/);
  if (chartPeriodsMatch) console.log(`  chartPeriods in HTML: ${chartPeriodsMatch[1].slice(0, 200)}`);

  // Also check charts/TopVideos/KR page itself
  console.log('\n=== Step 1b: Fetch charts.youtube.com/charts/TopVideos/KR directly ===');
  const { start: wkStart, end: wkEnd } = getLastThursdayRange();
  console.log(`  Last full week: ${wkStart} – ${wkEnd}`);

  await delay(300);

  // Step 2: Baseline — test US detail (should work with us period ID)
  console.log('\n=== Step 2: charts_detail US (baseline) ===');
  const usChartAttr = `weekly:${wkStart}:${wkEnd}:us`;
  const d_us = await browse('FEmusic_analytics_charts_detail', {
    region: 'us',
    chartType: 3,
    periodType: 2,
    endDate: wkEnd,
    chartAttributeValue: usChartAttr,
  }, baseClient, `detail US TopVideos av=${usChartAttr}`);
  if (d_us) printChartEntities(d_us, 'US TopVideos');

  await delay(300);

  // Step 3: KR detail with kr period ID
  console.log('\n=== Step 3: charts_detail KR with kr period ID ===');
  const krChartAttr = `weekly:${wkStart}:${wkEnd}:kr`;

  // Try TopVideos (chartType=3)
  for (const periodType of [2, 1, 0]) {
    const d = await browse('FEmusic_analytics_charts_detail', {
      region: 'kr',
      chartType: 3,
      periodType,
      endDate: wkEnd,
      chartAttributeValue: krChartAttr,
    }, baseClient, `detail KR TopVideos periodType=${periodType}`);
    if (d) { printChartEntities(d, 'KR TopVideos'); break; }
    await delay(200);
  }

  // Try TopSongs (chartType=2)
  const d_kr_songs = await browse('FEmusic_analytics_charts_detail', {
    region: 'kr',
    chartType: 2,
    periodType: 2,
    endDate: wkEnd,
    chartAttributeValue: `weekly:${wkStart}:${wkEnd}:kr`,
  }, baseClient, 'detail KR TopSongs');
  if (d_kr_songs) printChartEntities(d_kr_songs, 'KR TopSongs');

  await delay(200);

  // Step 4: Try without endDate, different periodType
  console.log('\n=== Step 4: Try without endDate ===');
  const d_nodate = await browse('FEmusic_analytics_charts_detail', {
    region: 'kr',
    chartType: 3,
    periodType: 2,
    chartAttributeValue: krChartAttr,
  }, baseClient, 'detail KR no endDate');
  if (d_nodate) printChartEntities(d_nodate, 'KR no endDate');

  await delay(200);

  // Step 5: Try using the home-provided period end date (20260723) which is Thursday
  console.log('\n=== Step 5: Try endDate=20260723 (known Thursday) ===');
  for (const chartType of [3, 2]) {
    const d = await browse('FEmusic_analytics_charts_detail', {
      region: 'kr',
      chartType,
      periodType: 2,
      endDate: '20260723',
      chartAttributeValue: 'weekly:20260717:20260723:kr',
    }, baseClient, `detail KR ct=${chartType} date=20260723`);
    if (d) { printChartEntities(d, `KR ct=${chartType}`); }
    await delay(200);
  }

  // Step 6: Try US detail with no chartAttributeValue
  console.log('\n=== Step 6: US detail without chartAttributeValue (minimal params) ===');
  const d_us_min = await browse('FEmusic_analytics_charts_detail', {
    region: 'us',
    chartType: 3,
    periodType: 2,
  }, baseClient, 'detail US minimal');
  if (d_us_min) printChartEntities(d_us_min, 'US minimal');

  console.log('\n=== Probe v16 complete ===');
}

main().catch(e => { console.error(e); process.exit(1); });
