/**
 * Probe v6:
 * - v5 confirmed the FEmusic_charts page is a navigation hub with a "Video charts"
 *   musicCarouselShelfRenderer whose items are musicTwoRowItemRenderer playlist cards.
 * - Each card has a browseEndpoint.browseId that leads to the actual ranked track list.
 * - The browseId was truncated in v5 logs — this probe extracts it in full.
 * - Also inspects a musicFormBooleanChoice mutation for a navigation endpoint (country charts).
 *
 * This version:
 * 1. Extracts browseIds from the "Video charts" carousel items.
 * 2. Browses each chart playlist ID to get ranked tracks.
 * 3. Prints first musicFormBooleanChoice mutation in full (looking for navEndpoint).
 * 4. Tries browsing with formData for KR to see if it changes section[1] carousel.
 * 5. Checks if any chart playlist contains BLACKPINK / member names.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ENDPOINT = 'https://music.youtube.com/youtubei/v1/browse';
const CLIENT_VERSION = '1.20240724.00.00';
const ARTISTS = ['BLACKPINK', 'JENNIE', 'JISOO', 'ROSÉ', 'ROSA', 'LISA', 'Less Than a Lover'];

function snip(v, max = 300) { return String(v).length > max ? String(v).slice(0, max) + '…' : String(v); }

function deepFind(obj, pred, acc = []) {
  if (!obj || typeof obj !== 'object') return acc;
  if (pred(obj)) acc.push(obj);
  for (const v of Object.values(obj)) deepFind(v, pred, acc);
  return acc;
}

function buildCountryKey(countryCode) {
  const b0 = countryCode.charCodeAt(0);
  const b1 = countryCode.charCodeAt(1);
  const b2 = 0x20;
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const n = (b0 << 16) | (b1 << 8) | b2;
  const s = B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  const PREFIX = 'EidleHBsb3JlX2NoYXJ0c19jb3VudHJ5X21lbnVfMzE2NzY2NTY3';
  const SUFFIX = 'kQEoAQ%3D%3D';
  return PREFIX + s + SUFFIX;
}

async function browse(browseId, extra = {}, gl = 'US') {
  const body = {
    browseId,
    ...extra,
    context: {
      client: { clientName: 'WEB_REMIX', clientVersion: CLIENT_VERSION, hl: 'en', gl, userAgent: UA },
    },
  };
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'Origin': 'https://music.youtube.com',
      'Referer': 'https://music.youtube.com/',
      'X-YouTube-Client-Name': '67',
      'X-YouTube-Client-Version': CLIENT_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) { console.log(`  HTTP ${r.status}: ${snip(await r.text())}`); return null; }
  return r.json();
}

// Extract FULL chart playlist info from "Video charts" section
function extractChartPlaylists(data, label) {
  console.log(`\n[${label}] Extracting chart playlists:`);
  const sections = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
    ?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];

  const chartIds = [];
  for (const section of sections) {
    const carousel = section.musicCarouselShelfRenderer;
    if (!carousel) continue;

    const headerRuns = deepFind(carousel.header ?? {}, o => Array.isArray(o.runs) && o.runs[0]?.text);
    const headerText = headerRuns[0]?.runs?.[0]?.text ?? '';
    console.log(`  Carousel: "${headerText}" (${(carousel.contents ?? []).length} items)`);

    for (const [i, item] of (carousel.contents ?? []).entries()) {
      const twoRow = item.musicTwoRowItemRenderer;
      if (!twoRow) continue;

      const title = twoRow.title?.runs?.[0]?.text ?? '(no title)';
      const navEp = twoRow.title?.runs?.[0]?.navigationEndpoint ?? twoRow.navigationEndpoint;
      const browseId = navEp?.browseEndpoint?.browseId ?? '(no browseId)';
      const browseParams = navEp?.browseEndpoint?.params ?? '';
      const subtitle = (twoRow.subtitle?.runs ?? []).map(r => r.text).join('');

      console.log(`    [${i}] "${title}" / "${subtitle}"`);
      console.log(`         browseId=${browseId}`);
      if (browseParams) console.log(`         params=${browseParams}`);

      chartIds.push({ title, subtitle, browseId, browseParams });
    }
  }
  return chartIds;
}

// Analyze a chart playlist response for ranked tracks
function analyzeChartPlaylist(label, data) {
  const raw = JSON.stringify(data);
  console.log(`\n[${label}] size=${raw.length} bytes`);
  console.log(`  top-level keys: ${Object.keys(data).join(', ')}`);

  // Artist scan
  for (const n of ARTISTS) {
    const idx = raw.indexOf(n);
    if (idx >= 0) console.log(`  ★ "${n}" found! …${raw.slice(Math.max(0, idx - 50), idx + 80)}…`);
  }

  // videoIds
  const videoIds = [...raw.matchAll(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g)].map(m => m[1]);
  console.log(`  videoIds: ${videoIds.length}`);
  if (videoIds.length) console.log('  First 15:', videoIds.slice(0, 15).join(', '));

  // musicShelfRenderer
  const shelves = deepFind(data, o => o.musicShelfRenderer != null);
  for (const s of shelves) {
    const shelf = s.musicShelfRenderer;
    const items = shelf?.contents ?? [];
    console.log(`  musicShelfRenderer: ${items.length} items`);
    if (items.length > 0) {
      console.log('  item[0] keys:', Object.keys(items[0]).join(', '));
      console.log('  item[0]:', snip(JSON.stringify(items[0]), 1000));
      if (items.length > 1) console.log('  item[1]:', snip(JSON.stringify(items[1]), 500));
      if (items.length > 2) console.log('  item[2]:', snip(JSON.stringify(items[2]), 500));
    }
  }

  // musicResponsiveListItemRenderer
  const listItems = deepFind(data, o => o.musicResponsiveListItemRenderer != null);
  console.log(`  musicResponsiveListItemRenderers: ${listItems.length}`);
  if (listItems.length > 0) {
    const li = listItems[0].musicResponsiveListItemRenderer;
    const cols = li.flexColumns ?? [];
    const texts = cols.map(c => c.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map(r => r.text)?.join('') ?? '');
    const overlayRuns = deepFind(li, o => o.musicResponsiveListItemOverlayRenderer != null);
    const vid = deepFind(li, o => typeof o.videoId === 'string' && o.videoId.length === 11);
    console.log(`  item[0] text columns: ${texts.join(' | ')}`);
    console.log(`  item[0] videoId: ${vid[0]?.videoId ?? 'none'}`);
  }

  // musicImmersiveCarouselShelfRenderer
  const carousels = deepFind(data, o => o.musicCarouselShelfRenderer || o.musicImmersiveCarouselShelfRenderer);
  console.log(`  carousels: ${carousels.length}`);

  // Ranked index objects
  const ranked = deepFind(data, o =>
    (typeof o.index === 'string' || typeof o.index === 'number' || o.rank != null || o.position != null) &&
    typeof o.index !== 'undefined');
  console.log(`  index/rank objects: ${ranked.length}`);
  ranked.slice(0, 5).forEach(o => console.log(`    ${snip(JSON.stringify(o), 150)}`));

  // Unique text runs
  const allRuns = deepFind(data, o => Array.isArray(o.runs) && o.runs[0]?.text);
  const texts = [...new Set(allRuns.map(o => o.runs.map(r => r.text).join('')))];
  console.log(`  unique text runs (${texts.length}):`);
  texts.slice(0, 60).forEach((t, i) => console.log(`    [${i}] ${snip(t, 100)}`));

  // mutations
  const mutations = data?.frameworkUpdates?.entityBatchUpdate?.mutations ?? [];
  console.log(`  mutations: ${mutations.length}`);
  if (mutations.length > 0) {
    const types = [...new Set(mutations.map(m => Object.keys(m.payload ?? {}).join('+')))];
    console.log(`  mutation types: ${types.join(' | ')}`);
    const nonForm = mutations.filter(m => !m.payload?.musicForm && !m.payload?.musicFormBooleanChoice);
    console.log(`  non-form mutations: ${nonForm.length}`);
    if (nonForm.length > 0) {
      nonForm.slice(0, 3).forEach((m, i) =>
        console.log(`  nonForm[${i}]: ${snip(JSON.stringify(m, null, 2), 2000)}`));
    }
  }
}

async function main() {
  // ── Step 1: bare FEmusic_charts, extract chart playlist browseIds ─────────
  console.log('=== Step 1: bare FEmusic_charts gl=US — extract chart browseIds ===');
  const hub = await browse('FEmusic_charts', {}, 'US');
  if (!hub) { console.log('Hub call failed'); process.exit(1); }

  const chartIds = extractChartPlaylists(hub, 'US hub');

  // ── Step 2: inspect first musicFormBooleanChoice mutation in full ─────────
  console.log('\n=== Step 2: musicFormBooleanChoice mutation (country option entity) ===');
  const mutations = hub?.frameworkUpdates?.entityBatchUpdate?.mutations ?? [];
  const boolMut = mutations.find(m => m.payload?.musicFormBooleanChoice);
  if (boolMut) {
    console.log(JSON.stringify(boolMut, null, 2).slice(0, 4000));
  } else {
    console.log('No musicFormBooleanChoice mutation found');
  }

  await new Promise(r => setTimeout(r, 600));

  // ── Step 3: browse each chart playlist ──────────────────────────────────
  for (const [i, chart] of chartIds.entries()) {
    if (!chart.browseId || chart.browseId === '(no browseId)') continue;
    console.log(`\n=== Step 3.${i + 1}: Browsing chart "${chart.title}" (${chart.browseId}) ===`);
    const d = await browse(chart.browseId, {}, 'US');
    if (d) analyzeChartPlaylist(`chart:${chart.title}`, d);
    await new Promise(r => setTimeout(r, 400));
  }

  // ── Step 4: bare FEmusic_charts gl=KR — do we get KR-specific chart IDs? ─
  console.log('\n=== Step 4: bare FEmusic_charts gl=KR — check for KR chart browseIds ===');
  const hubKR = await browse('FEmusic_charts', {}, 'KR');
  if (hubKR) {
    const krChartIds = extractChartPlaylists(hubKR, 'KR hub');
    // Compare with US chart IDs
    const usIds = new Set(chartIds.map(c => c.browseId));
    const newInKR = krChartIds.filter(c => !usIds.has(c.browseId));
    if (newInKR.length) {
      console.log('\n  NEW chart IDs in KR (not in US):');
      newInKR.forEach(c => console.log(`    "${c.title}" → ${c.browseId}`));
    } else {
      console.log('  Same chart IDs as US (gl=KR has no effect on chart selection)');
    }
  }

  console.log('\n=== Probe v6 complete ===');
}

main().catch(e => { console.error(e); process.exit(1); });
