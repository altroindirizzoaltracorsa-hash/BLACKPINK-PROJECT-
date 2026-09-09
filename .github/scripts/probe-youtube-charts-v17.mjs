/**
 * Probe v17:
 *
 * v16 CRITICAL FINDING:
 *   - charts_detail returns 400 INVALID_ARGUMENT for ALL combinations:
 *     - US + us period ID → 400
 *     - KR + kr period ID → 400
 *     - No chartAttributeValue → 400
 *   - charts_home still returns 200 (US data)
 *
 * New hypotheses:
 *  A. We're missing INNERTUBE_API_KEY in the URL query string (?key=...)
 *  B. chartAttributeValue must come from actual chartPeriods objects (not entityId)
 *  C. visitorData / X-Goog-Visitor-Id header may be required for charts_detail
 *  D. The body structure might need 'params' (base64 proto) instead of 'query' (JSON string)
 *  E. Try fetching charts.youtube.com/charts/TopVideos/KR?hl=ko page for KR-specific period IDs
 *
 * Steps:
 *  1. Fetch ytcfg, extract INNERTUBE_API_KEY, VISITOR_DATA, full client context
 *  2. Dump full chartPeriods array from charts_home (all fields)
 *  3. Try charts_detail with ?key=API_KEY in URL
 *  4. Try charts_detail with X-Goog-Visitor-Id header
 *  5. Try charts_detail with params (base64 proto) instead of query
 *  6. Try charts_detail for US using actual chartPeriods[0].id value
 *  7. Fetch KR page with hl=ko to look for KR period IDs in HTML
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ARTISTS = ['BLACKPINK', 'JENNIE', 'JISOO', 'ROSÉ', 'ROSA', 'LISA'];
const BROWSE_ENDPOINT = 'https://charts.youtube.com/youtubei/v1/browse';

function snip(v, max = 300) { return String(v).length > max ? String(v).slice(0, max) + '…' : String(v); }
function deepFind(obj, pred, acc = []) {
  if (!obj || typeof obj !== 'object') return acc;
  if (pred(obj)) acc.push(obj);
  for (const v of Object.values(obj)) deepFind(v, pred, acc);
  return acc;
}

async function fetchPageCfg(url) {
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

async function browse(endpoint, bodyObj, extraHeaders, label) {
  console.log(`\n=== [${label}] ===`);
  console.log(`  endpoint: ${endpoint}`);
  console.log(`  body keys: ${Object.keys(bodyObj).join(', ')}`);
  if (bodyObj.query) console.log(`  query: ${snip(bodyObj.query, 200)}`);
  if (bodyObj.params) console.log(`  params: ${bodyObj.params.slice(0, 60)}…`);

  const r = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'Origin': 'https://charts.youtube.com',
      'Referer': 'https://charts.youtube.com/',
      'X-YouTube-Client-Name': '31',
      'X-YouTube-Client-Version': '2.0',
      ...extraHeaders,
    },
    body: JSON.stringify(bodyObj),
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
  const size = JSON.stringify(data).length;
  console.log(`  size: ${size} bytes`);
  return data;
}

function printChartEntities(data) {
  const entities = deepFind(data, o => typeof o.atvExternalVideoId === 'string');
  const sorted = entities
    .map(e => ({ pos: e.chartEntryMetadata?.currentPosition ?? 9999, e }))
    .sort((a, b) => a.pos - b.pos);
  console.log(`  chart entities: ${sorted.length}`);
  sorted.slice(0, 5).forEach(({ pos, e }) => {
    const arts = (e.artists ?? []).map(a => a.name).join(', ');
    console.log(`  #${String(pos).padStart(3)} "${e.name}" — ${arts}`);
  });
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
  }
}

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Build a minimal proto-like base64 that encodes {chartType, region, periodType, chartAttributeValue}
// InnerTube params are protobuf; field tags: 1=chartType(varint), 2=region(string), 3=periodType(varint), 4=chartAttributeValue(string)
function encodeProtoParams(fields) {
  // Very minimal manual protobuf encoder for testing
  const buf = [];
  function writeVarint(n) {
    while (n > 127) { buf.push((n & 0x7f) | 0x80); n >>>= 7; }
    buf.push(n & 0x7f);
  }
  function writeString(fieldNum, s) {
    const bytes = Buffer.from(s, 'utf8');
    writeVarint((fieldNum << 3) | 2); // wire type 2 = length-delimited
    writeVarint(bytes.length);
    for (const b of bytes) buf.push(b);
  }
  function writeInt(fieldNum, n) {
    writeVarint((fieldNum << 3) | 0); // wire type 0 = varint
    writeVarint(n);
  }
  for (const [field, val] of Object.entries(fields)) {
    const fn = parseInt(field);
    if (typeof val === 'number') writeInt(fn, val);
    else writeString(fn, val);
  }
  return Buffer.from(buf).toString('base64url');
}

async function main() {
  // Step 1: Fetch ytcfg from KR page
  console.log('=== Step 1: Fetch ytcfg ===');
  const { cfg, html } = await fetchPageCfg('https://charts.youtube.com/charts/TopVideos/KR');
  const client = cfg.INNERTUBE_CONTEXT?.client ?? {};
  const apiKey = cfg.INNERTUBE_API_KEY ?? cfg.YOUTUBE_CLIENT_METADATA?.['innertube_api_key'] ?? '';
  const visitorData = client.visitorData ?? cfg.VISITOR_DATA ?? '';
  const baseClient = { ...client, hl: 'en' };

  console.log(`  clientName: ${baseClient.clientName}`);
  console.log(`  clientVersion: ${baseClient.clientVersion}`);
  console.log(`  apiKey: ${apiKey ? apiKey.slice(0, 20) + '…' : '(none)'}`);
  console.log(`  visitorData: ${visitorData ? visitorData.slice(0, 40) + '…' : '(none)'}`);

  // Look for INNERTUBE_API_KEY in raw HTML
  const keyMatch = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
  if (keyMatch) console.log(`  INNERTUBE_API_KEY from HTML: ${keyMatch[1].slice(0, 25)}…`);
  const rawApiKey = keyMatch?.[1] ?? apiKey;
  console.log(`  Using apiKey: ${rawApiKey ? rawApiKey.slice(0, 25) + '…' : '(none)'}`);

  // Step 2: Get charts_home to extract actual chartPeriods
  console.log('\n=== Step 2: charts_home US — inspect chartPeriods ===');
  const homeData = await browse(
    BROWSE_ENDPOINT,
    { browseId: 'FEmusic_analytics_charts_home', query: JSON.stringify({ region: 'us' }), context: { client: baseClient } },
    {},
    'charts_home US'
  );
  let chartPeriods = [];
  if (homeData) {
    const content = homeData?.contents?.sectionListRenderer?.contents?.[0]?.musicAnalyticsSectionRenderer?.content;
    const pm = content?.perspectiveMetadata ?? {};
    chartPeriods = pm.chartPeriods ?? [];
    console.log(`  entityId: ${pm.entityId}`);
    console.log(`  chartPeriods count: ${chartPeriods.length}`);
    console.log(`  chartPeriods[0]: ${JSON.stringify(chartPeriods[0])}`);
    console.log(`  chartPeriods[1]: ${JSON.stringify(chartPeriods[1])}`);
    // Print all keys of a period object
    if (chartPeriods[0]) console.log(`  period keys: ${Object.keys(chartPeriods[0]).join(', ')}`);
  }

  await delay(300);

  // Step 3: charts_detail with API key in URL
  console.log('\n=== Step 3: charts_detail with ?key= in URL ===');
  const period0Id = chartPeriods[0]?.id ?? 'weekly:20260717:20260723:us';
  const endpointWithKey = rawApiKey ? `${BROWSE_ENDPOINT}?key=${rawApiKey}` : BROWSE_ENDPOINT;

  const d_us_key = await browse(
    endpointWithKey,
    {
      browseId: 'FEmusic_analytics_charts_detail',
      query: JSON.stringify({ region: 'us', chartType: 3, periodType: 2, endDate: '20260723', chartAttributeValue: period0Id }),
      context: { client: baseClient },
    },
    {},
    `detail US + ?key period="${period0Id}"`
  );
  if (d_us_key) printChartEntities(d_us_key);

  await delay(300);

  // Step 4: charts_detail with X-Goog-Visitor-Id header
  console.log('\n=== Step 4: charts_detail with X-Goog-Visitor-Id ===');
  const extraHdrs = visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {};
  const d_visitor = await browse(
    endpointWithKey,
    {
      browseId: 'FEmusic_analytics_charts_detail',
      query: JSON.stringify({ region: 'us', chartType: 3, periodType: 2, endDate: '20260723', chartAttributeValue: period0Id }),
      context: { client: baseClient },
    },
    extraHdrs,
    `detail US + visitor header period="${period0Id}"`
  );
  if (d_visitor) printChartEntities(d_visitor);

  await delay(300);

  // Step 5: Try charts_detail with 'params' (base64 proto) instead of 'query'
  console.log('\n=== Step 5: charts_detail with params (proto) ===');

  // Field mapping attempt 1: region(1), chartType(2), periodType(3), chartAttributeValue(4)
  const protoParams1 = encodeProtoParams({ 1: 'us', 2: 3, 3: 2, 4: period0Id });
  console.log(`  proto attempt 1 (region=us ct=3 pt=2): ${protoParams1}`);
  const d_proto1 = await browse(
    endpointWithKey,
    {
      browseId: 'FEmusic_analytics_charts_detail',
      params: protoParams1,
      context: { client: baseClient },
    },
    extraHdrs,
    `detail params proto1 US`
  );
  if (d_proto1) printChartEntities(d_proto1);

  await delay(200);

  // Field mapping attempt 2: chartType(1), region(2), periodType(3), chartAttributeValue(4)
  const protoParams2 = encodeProtoParams({ 1: 3, 2: 'us', 3: 2, 4: period0Id });
  console.log(`  proto attempt 2 (ct=3 region=us pt=2): ${protoParams2}`);
  const d_proto2 = await browse(
    endpointWithKey,
    {
      browseId: 'FEmusic_analytics_charts_detail',
      params: protoParams2,
      context: { client: baseClient },
    },
    extraHdrs,
    `detail params proto2 US`
  );
  if (d_proto2) printChartEntities(d_proto2);

  await delay(200);

  // Step 6: Try charts_home with region=kr and key
  console.log('\n=== Step 6: charts_home KR with key ===');
  const d_kr_key = await browse(
    endpointWithKey,
    { browseId: 'FEmusic_analytics_charts_home', query: JSON.stringify({ region: 'kr' }), context: { client: baseClient } },
    extraHdrs,
    'charts_home KR + key'
  );
  if (d_kr_key) {
    const content = d_kr_key?.contents?.sectionListRenderer?.contents?.[0]?.musicAnalyticsSectionRenderer?.content;
    const pm = content?.perspectiveMetadata ?? {};
    console.log(`  KR entityId: ${pm.entityId}`);
    const krPeriods = pm.chartPeriods ?? [];
    console.log(`  KR chartPeriods count: ${krPeriods.length}`);
    krPeriods.slice(0, 3).forEach((p, i) => console.log(`  KR period[${i}]: ${JSON.stringify(p)}`));
  }

  await delay(300);

  // Step 7: Fetch KR page with hl=ko and check for embedded data or KR-specific keys
  console.log('\n=== Step 7: KR page with hl=ko ===');
  const { cfg: cfgKo, html: htmlKo } = await fetchPageCfg('https://charts.youtube.com/charts/TopVideos/KR?hl=ko');
  const clientKo = cfgKo.INNERTUBE_CONTEXT?.client ?? {};
  const apiKeyKo = htmlKo.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1] ?? '';
  console.log(`  ko clientName: ${clientKo.clientName}, apiKey: ${apiKeyKo ? apiKeyKo.slice(0, 20) + '…' : '(none)'}`);
  const krPeriodIdsKo = [...htmlKo.matchAll(/"id"\s*:\s*"(weekly:[^"]+:kr)"/g)].map(m => m[1]);
  console.log(`  KR period IDs (hl=ko): ${krPeriodIdsKo.length}`);
  krPeriodIdsKo.slice(0, 5).forEach(id => console.log(`    ${id}`));

  // Also scan for any "kr" references in the HTML
  const krRefs = [...htmlKo.matchAll(/"([^"]*:kr[^"]*)"/g)].map(m => m[1]).slice(0, 10);
  console.log(`  Any :kr refs in HTML: ${krRefs.join(', ')}`);

  // Step 8: Try with ko client context
  if (Object.keys(clientKo).length > 0 && krPeriodIdsKo.length > 0) {
    const baseClientKo = { ...clientKo, hl: 'ko' };
    const krPeriodId = krPeriodIdsKo[0];
    const endpointKo = apiKeyKo ? `${BROWSE_ENDPOINT}?key=${apiKeyKo}` : endpointWithKey;
    console.log(`\n  Testing charts_detail with KR period ID from ko page: ${krPeriodId}`);
    const d_kr_detail = await browse(
      endpointKo,
      {
        browseId: 'FEmusic_analytics_charts_detail',
        query: JSON.stringify({ region: 'kr', chartType: 3, periodType: 2, chartAttributeValue: krPeriodId }),
        context: { client: baseClientKo },
      },
      {},
      `detail KR from ko page av=${krPeriodId}`
    );
    if (d_kr_detail) printChartEntities(d_kr_detail);
  }

  // Step 9: Try charts_detail with just chartAttributeValue from home (no endDate, no region, no chartType)
  console.log('\n=== Step 9: charts_detail — minimal + chartAttributeValue only ===');
  for (const q of [
    { chartAttributeValue: period0Id },
    { region: 'us', chartAttributeValue: period0Id },
    { chartType: 3, chartAttributeValue: period0Id },
  ]) {
    const d = await browse(
      endpointWithKey,
      {
        browseId: 'FEmusic_analytics_charts_detail',
        query: JSON.stringify(q),
        context: { client: baseClient },
      },
      extraHdrs,
      `detail minimal q=${JSON.stringify(q).slice(0, 60)}`
    );
    if (d) { printChartEntities(d); }
    await delay(200);
  }

  console.log('\n=== Probe v17 complete ===');
}

main().catch(e => { console.error(e); process.exit(1); });
