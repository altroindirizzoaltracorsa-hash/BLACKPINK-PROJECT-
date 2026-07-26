/**
 * Probe v10:
 * - v9 confirmed: FEmusic_charts is INVALID_ARGUMENT on charts.youtube.com endpoint.
 * - The site's originalUrl is "https://charts.youtube.com/charts/TopVideos/KR" —
 *   the browseId must match the charts.youtube.com URL structure, not music.youtube.com.
 *
 * This version:
 * 1. Prints the full INNERTUBE_CONTEXT from ytcfg.
 * 2. Tries chart-specific browseIds: FEcharts_top_videos_KR, FEcharts_TopVideos_KR,
 *    FEcharts, TopVideos/KR, FEcharts_top_videos, FEcharts_top_songs.
 * 3. Passes originalUrl matching the browseId being tested.
 * 4. Tries passing country as a `params` proto-encoded value.
 * 5. Tries browsing with the charts.youtube.com /youtubei/v1/browse endpoint
 *    using the same URL patterns seen in charts.youtube.com path structure.
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

async function fetchYtcfg(path = 'charts/TopVideos/KR') {
  const url = `https://charts.youtube.com/${path}`;
  const r = await fetch(url, {
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

async function tryBrowse(clientCtx, browseId, label, extra = {}) {
  const body = { browseId, ...extra, context: { client: clientCtx } };

  console.log(`\n--- [${label}] browseId="${browseId}" ---`);
  if (extra.params) console.log(`    params="${extra.params}"`);

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

  console.log(`    HTTP ${r.status}`);
  const ct = r.headers.get('content-type') ?? '';

  if (!r.ok || !ct.includes('json')) {
    const txt = await r.text();
    const parsed = tryParseJson(txt);
    if (parsed?.error) {
      console.log(`    error.code=${parsed.error.code} status=${parsed.error.status}`);
      console.log(`    message: ${parsed.error.message}`);
    } else {
      console.log(`    ${snip(txt, 300)}`);
    }
    return null;
  }

  const data = await r.json();
  console.log(`    SUCCESS! size=${JSON.stringify(data).length} bytes`);
  console.log(`    top-level keys: ${Object.keys(data).join(', ')}`);
  analyzeData(data, label);
  return data;
}

function tryParseJson(txt) {
  try { return JSON.parse(txt); } catch { return null; }
}

function analyzeData(data, label) {
  const raw = JSON.stringify(data);
  for (const n of ARTISTS) {
    const idx = raw.indexOf(n);
    if (idx >= 0) console.log(`    ★ "${n}" found! …${raw.slice(Math.max(0, idx - 50), idx + 100)}…`);
  }
  const videoIds = [...raw.matchAll(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g)].map(m => m[1]);
  console.log(`    videoIds: ${videoIds.length}`);
  if (videoIds.length) console.log(`    First 10: ${videoIds.slice(0, 10).join(', ')}`);
  const listItems = deepFind(data, o => o.musicResponsiveListItemRenderer != null);
  console.log(`    musicResponsiveListItemRenderers: ${listItems.length}`);
}

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('=== Step 1: Extract ytcfg + print full INNERTUBE_CONTEXT ===');
  const cfg = await fetchYtcfg('charts/TopVideos/KR');

  const ctx = cfg.INNERTUBE_CONTEXT ?? {};
  const client = ctx.client ?? {};

  console.log('\n  Full INNERTUBE_CONTEXT.client:');
  for (const [k, v] of Object.entries(client)) {
    console.log(`    ${k}: ${JSON.stringify(v)}`);
  }
  console.log(`\n  INNERTUBE_BROWSE_ID: ${cfg.INNERTUBE_BROWSE_ID ?? '(not set)'}`);
  console.log(`  SERIALIZED_CLIENT_CONFIG_DATA length: ${cfg.SERIALIZED_CLIENT_CONFIG_DATA?.length ?? 0}`);

  // Also check for any browseId hints in other config keys
  const browseHints = Object.entries(cfg).filter(([k, v]) =>
    k.toLowerCase().includes('browse') || (typeof v === 'string' && v.startsWith('FE'))
  );
  console.log(`\n  Keys with browseId hints: ${browseHints.map(([k]) => k).join(', ')}`);
  browseHints.forEach(([k, v]) => console.log(`    ${k}: ${JSON.stringify(v)}`));

  await delay(300);

  // Base client — use exact context from ytcfg, override nothing
  const baseClient = { ...client };
  // Variant that sets originalUrl to match each browseId
  const makeClient = (overrideOriginalUrl) => ({
    ...baseClient,
    originalUrl: overrideOriginalUrl,
    hl: 'en',
  });

  console.log('\n=== Step 2: Try chart-specific browseIds ===');

  const tests = [
    // Country-encoded browseId candidates
    { browseId: 'FEcharts_top_videos_KR',        url: 'https://charts.youtube.com/charts/TopVideos/KR',    label: 'FEcharts_top_videos_KR' },
    { browseId: 'FEcharts_TopVideos_KR',          url: 'https://charts.youtube.com/charts/TopVideos/KR',    label: 'FEcharts_TopVideos_KR' },
    { browseId: 'FEcharts_top_videos',            url: 'https://charts.youtube.com/charts/TopVideos/KR',    label: 'FEcharts_top_videos' },
    { browseId: 'FEcharts',                       url: 'https://charts.youtube.com/',                       label: 'FEcharts' },
    { browseId: 'FEcharts_home',                  url: 'https://charts.youtube.com/',                       label: 'FEcharts_home' },
    { browseId: 'FEcharts_top_songs_KR',          url: 'https://charts.youtube.com/charts/TopSongs/KR',     label: 'FEcharts_top_songs_KR' },
    { browseId: 'FEcharts_top_songs',             url: 'https://charts.youtube.com/charts/TopSongs/KR',     label: 'FEcharts_top_songs' },
    // Try the path itself as browseId
    { browseId: 'TopVideos/KR',                   url: 'https://charts.youtube.com/charts/TopVideos/KR',    label: 'TopVideos/KR' },
    { browseId: 'charts/TopVideos/KR',            url: 'https://charts.youtube.com/charts/TopVideos/KR',    label: 'charts/TopVideos/KR' },
    // Global variant
    { browseId: 'FEcharts_top_videos_ZZ',         url: 'https://charts.youtube.com/charts/TopVideos/ZZ',    label: 'FEcharts_top_videos_ZZ' },
  ];

  for (const t of tests) {
    await tryBrowse(makeClient(t.url), t.browseId, t.label);
    await delay(200);
  }

  console.log('\n=== Step 3: Try params-encoded country on generic browseId ===');

  // KR encoded as simple base64-ish variants
  // Probe v6 found booleanChoiceEntityKey like EidleHBsb3JlX2NoYXJ0c19jb3VudHJ5X21lbnVfMzE2NzY2NTY3S1IgkQEoAQ==
  // Try passing it as params to FEcharts or FEcharts_top_videos
  const KR_ENTITY_KEY = 'EidleHBsb3JlX2NoYXJ0c19jb3VudHJ5X21lbnVfMzE2NzY2NTY3S1IgkQEoAQ==';

  const paramTests = [
    { browseId: 'FEcharts_top_videos', params: KR_ENTITY_KEY,   label: 'FEcharts_top_videos+KR_params' },
    { browseId: 'FEcharts',            params: KR_ENTITY_KEY,   label: 'FEcharts+KR_params' },
    // Simple country code encoded as base64: "KR" → "S1I="
    { browseId: 'FEcharts_top_videos', params: 'S1I=',           label: 'FEcharts_top_videos+KR_b64' },
    // Protobuf-style: field 1 = "KR" → 0x0a 0x02 0x4b 0x52 → base64 "CgJLUg=="
    { browseId: 'FEcharts_top_videos', params: 'CgJLUg==',       label: 'FEcharts_top_videos+proto_KR' },
    { browseId: 'FEcharts_top_videos', params: 'CgJaWg==',       label: 'FEcharts_top_videos+proto_ZZ (Global)' },
  ];

  for (const t of paramTests) {
    await tryBrowse(
      makeClient(`https://charts.youtube.com/charts/TopVideos/KR`),
      t.browseId,
      t.label,
      { params: t.params }
    );
    await delay(200);
  }

  console.log('\n=== Step 4: Inspect INNERTUBE_BROWSE_ID from other ytcfg pages ===');

  // Also try fetching from the root charts page to see if browseId differs
  const cfgRoot = await fetchYtcfg('');
  console.log(`  Root page INNERTUBE_BROWSE_ID: ${cfgRoot.INNERTUBE_BROWSE_ID ?? '(not set)'}`);
  console.log(`  Root page INNERTUBE_CONTEXT.client.originalUrl: ${cfgRoot.INNERTUBE_CONTEXT?.client?.originalUrl ?? '(not set)'}`);

  await delay(200);

  const cfgGlobal = await fetchYtcfg('charts/TopVideos/ZZ');
  console.log(`  ZZ page INNERTUBE_BROWSE_ID: ${cfgGlobal.INNERTUBE_BROWSE_ID ?? '(not set)'}`);
  console.log(`  ZZ page INNERTUBE_CONTEXT.client.originalUrl: ${cfgGlobal.INNERTUBE_CONTEXT?.client?.originalUrl ?? '(not set)'}`);

  await delay(200);

  // Print all keys from root cfg
  console.log(`\n  Root cfg keys: ${Object.keys(cfgRoot).sort().join(', ')}`);
  for (const [k, v] of Object.entries(cfgRoot)) {
    if (k.toLowerCase().includes('browse') || k.toLowerCase().includes('chart')) {
      console.log(`    ${k}: ${JSON.stringify(v)}`);
    }
  }

  console.log('\n=== Probe v10 complete ===');
}

main().catch(e => { console.error(e); process.exit(1); });
