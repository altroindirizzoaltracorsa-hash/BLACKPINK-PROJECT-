/**
 * Probe v9:
 * - v8 confirmed: charts.youtube.com uses clientName="WEB_MUSIC_ANALYTICS" (ID:31),
 *   version "2.0", empty API key (no key needed), and INNERTUBE_CONTEXT in ytcfg.
 * - formData.selectedValues with KR entity key works — but music.youtube.com only
 *   returns Global charts for KR. Country-specific KR charts are on charts.youtube.com.
 *
 * This version:
 * 1. Extracts full INNERTUBE_CONTEXT + LAUNCHED_CHART_COUNTRIES from ytcfg.
 * 2. POSTs to charts.youtube.com/youtubei/v1/browse with WEB_MUSIC_ANALYTICS client.
 * 3. Tries different gl values (KR, ZZ, US) and browseIds.
 * 4. Parses the response for ranked tracks.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ARTISTS = ['BLACKPINK', 'JENNIE', 'JISOO', 'ROSÉ', 'ROSA', 'LISA', 'Less Than a Lover'];
const CHARTS_ENDPOINT = 'https://charts.youtube.com/youtubei/v1/browse';

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

async function browseCharts(ctx, browseId, gl, label, extra = {}) {
  // Build context: start from the extracted INNERTUBE_CONTEXT, override gl
  const clientCtx = {
    ...ctx.client,
    gl,
    hl: 'en',
    userAgent: UA,
  };

  const body = {
    browseId,
    ...extra,
    context: { client: clientCtx },
  };

  console.log(`\n=== POST charts.youtube.com/youtubei/v1/browse [${label}] ===`);
  console.log(`  browseId=${browseId}, gl=${gl}, clientName=${clientCtx.clientName}`);

  const r = await fetch(CHARTS_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'Origin': 'https://charts.youtube.com',
      'Referer': 'https://charts.youtube.com/',
      'X-YouTube-Client-Name': '31',
      'X-YouTube-Client-Version': clientCtx.clientVersion ?? '2.0',
    },
    body: JSON.stringify(body),
  });

  console.log(`  HTTP ${r.status}`);
  const ct = r.headers.get('content-type') ?? '';

  if (!r.ok || !ct.includes('json')) {
    const txt = await r.text();
    console.log(`  ${snip(txt, 600)}`);
    return null;
  }

  const data = await r.json();
  analyzeData(data, label);
  return data;
}

function analyzeData(data, label) {
  const raw = JSON.stringify(data);
  console.log(`  size=${raw.length} bytes`);
  console.log(`  top-level keys: ${Object.keys(data).join(', ')}`);

  for (const n of ARTISTS) {
    const idx = raw.indexOf(n);
    if (idx >= 0) console.log(`  ★ "${n}" found! …${raw.slice(Math.max(0, idx - 50), idx + 100)}…`);
  }

  const videoIds = [...raw.matchAll(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g)].map(m => m[1]);
  console.log(`  videoIds: ${videoIds.length}`);
  if (videoIds.length) console.log(`  First 10: ${videoIds.slice(0, 10).join(', ')}`);

  // Check sections / carousels
  const sections = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
    ?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
  console.log(`  sections: ${sections.length}`);
  for (const [i, section] of sections.entries()) {
    const carousel = section.musicCarouselShelfRenderer;
    if (!carousel) { console.log(`  section[${i}]: ${Object.keys(section).join(', ')}`); continue; }
    const headerRuns = deepFind(carousel.header ?? {}, o => Array.isArray(o.runs) && o.runs[0]?.text);
    const headerText = headerRuns[0]?.runs?.[0]?.text ?? '';
    const items = carousel.contents ?? [];
    console.log(`  section[${i}] carousel: "${headerText}" (${items.length} items)`);
    for (const [j, item] of items.slice(0, 4).entries()) {
      const twoRow = item.musicTwoRowItemRenderer;
      if (!twoRow) continue;
      const title = twoRow.title?.runs?.[0]?.text ?? '(no title)';
      const navEp = twoRow.title?.runs?.[0]?.navigationEndpoint ?? twoRow.navigationEndpoint;
      const browseId = navEp?.browseEndpoint?.browseId ?? '(no browseId)';
      console.log(`    item[${j}]: "${title}" → ${browseId}`);
    }
  }

  const listItems = deepFind(data, o => o.musicResponsiveListItemRenderer != null);
  console.log(`  musicResponsiveListItemRenderers: ${listItems.length}`);
  if (listItems.length > 0) {
    const li = listItems[0].musicResponsiveListItemRenderer;
    const cols = li.flexColumns ?? [];
    const texts = cols.map(c => c.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map(r => r.text)?.join('') ?? '');
    console.log(`  item[0] cols: ${texts.join(' | ')}`);
  }

  const allRuns = deepFind(data, o => Array.isArray(o.runs) && o.runs[0]?.text);
  const texts = [...new Set(allRuns.map(o => o.runs.map(r => r.text).join('')))];
  console.log(`  unique text runs (first 20): ${texts.slice(0, 20).map((t, i) => `[${i}]${snip(t, 60)}`).join(' | ')}`);

  const mutations = data?.frameworkUpdates?.entityBatchUpdate?.mutations ?? [];
  console.log(`  mutations: ${mutations.length}`);
}

async function main() {
  // Step 1: extract ytcfg
  console.log('=== Step 1: Extract ytcfg (INNERTUBE_CONTEXT + chart countries) ===');
  const cfg = await fetchYtcfg();

  const ctx = cfg.INNERTUBE_CONTEXT ?? {};
  console.log(`  INNERTUBE_CONTEXT.client keys: ${Object.keys(ctx.client ?? {}).join(', ')}`);
  console.log(`  clientName: ${ctx.client?.clientName}, version: ${ctx.client?.clientVersion}`);
  console.log(`  gl: ${ctx.client?.gl}, remoteHost: ${ctx.client?.remoteHost}`);

  // Print launched chart countries
  const countries = cfg.LAUNCHED_CHART_COUNTRIES ?? [];
  console.log(`\n  LAUNCHED_CHART_COUNTRIES (${countries.length}):`);
  countries.forEach(c => process.stdout.write(`${c.gl} `));
  console.log();

  // Also print EXPERIMENT_FLAGS for music chart flags
  const flags = cfg.EXPERIMENT_FLAGS ?? {};
  const chartFlags = Object.entries(flags).filter(([k]) => k.includes('Music') || k.includes('Chart'));
  console.log(`\n  Chart experiment flags:`);
  chartFlags.forEach(([k, v]) => console.log(`    ${k}: ${v}`));

  await new Promise(r => setTimeout(r, 300));

  // Step 2: POST to charts.youtube.com with WEB_MUSIC_ANALYTICS client
  // Try FEmusic_charts with various gl values

  const clientBase = {
    ...ctx.client,
    clientName: 'WEB_MUSIC_ANALYTICS',
    clientVersion: '2.0',
  };

  // Test 1: gl=KR
  const d1 = await browseCharts({ client: { ...clientBase, gl: 'KR' } }, 'FEmusic_charts', 'KR', 'charts.yt KR');
  await new Promise(r => setTimeout(r, 400));

  // Test 2: gl=ZZ (Global)
  const d2 = await browseCharts({ client: { ...clientBase, gl: 'ZZ' } }, 'FEmusic_charts', 'ZZ', 'charts.yt ZZ/Global');
  await new Promise(r => setTimeout(r, 400));

  // Test 3: gl=US (baseline)
  const d3 = await browseCharts({ client: { ...clientBase, gl: 'US' } }, 'FEmusic_charts', 'US', 'charts.yt US');
  await new Promise(r => setTimeout(r, 400));

  // Step 3: if we got chart browseIds from any of the above, browse them
  // Browse the Global Top 100 if we found it
  if (d2 || d3 || d1) {
    const data = d2 ?? d3 ?? d1;
    const sections = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
      ?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
    for (const section of sections) {
      const carousel = section.musicCarouselShelfRenderer;
      if (!carousel) continue;
      for (const item of (carousel.contents ?? []).slice(0, 2)) {
        const twoRow = item.musicTwoRowItemRenderer;
        if (!twoRow) continue;
        const navEp = twoRow.title?.runs?.[0]?.navigationEndpoint ?? twoRow.navigationEndpoint;
        const bid = navEp?.browseEndpoint?.browseId;
        const title = twoRow.title?.runs?.[0]?.text ?? '(no title)';
        if (!bid || bid === '(no browseId)') continue;

        console.log(`\n=== Step 3: Browse chart playlist "${title}" (${bid}) ===`);
        const pd = await browseCharts(
          { client: { ...clientBase, gl: 'ZZ' } },
          bid, 'ZZ', `chart-playlist:${title}`
        );
        if (pd) {
          // Print first 10 tracks
          const raw = JSON.stringify(pd);
          const listItems = deepFind(pd, o => o.musicResponsiveListItemRenderer != null);
          console.log(`  Total tracks: ${listItems.length}`);
          listItems.slice(0, 10).forEach((it, i) => {
            const li = it.musicResponsiveListItemRenderer;
            const cols = li.flexColumns ?? [];
            const texts = cols.map(c => c.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map(r => r.text)?.join('') ?? '');
            console.log(`  [${i + 1}] ${texts.join(' | ')}`);
          });
        }
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }

  console.log('\n=== Probe v9 complete ===');
}

main().catch(e => { console.error(e); process.exit(1); });
