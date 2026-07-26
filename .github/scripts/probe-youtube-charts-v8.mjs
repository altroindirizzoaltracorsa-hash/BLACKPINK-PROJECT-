/**
 * Probe v8:
 * - v7 confirmed charts.youtube.com is a Polymer SPA with no ytInitialData in HTML.
 * - BUT: the 13KB ytcfg block contains INNERTUBE_API_KEY and client config.
 * - GET /youtubei/v1/browse on charts.youtube.com returned 405 (needs POST).
 *
 * This version:
 * 1. Fetches charts.youtube.com HTML and extracts ytcfg config (API key, client info).
 * 2. Tries POST to charts.youtube.com/youtubei/v1/browse with extracted credentials.
 * 3. Tests different browseIds and country params.
 * 4. Also tries the charts.youtube.com /youtubei/v1/browse POST with WEB_REMIX creds
 *    plus country-specific params derived from the booleanChoiceEntityKey for KR.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ARTISTS = ['BLACKPINK', 'JENNIE', 'JISOO', 'ROSÉ', 'ROSA', 'LISA', 'Less Than a Lover'];

function snip(v, max = 300) { return String(v).length > max ? String(v).slice(0, max) + '…' : String(v); }

function deepFind(obj, pred, acc = []) {
  if (!obj || typeof obj !== 'object') return acc;
  if (pred(obj)) acc.push(obj);
  for (const v of Object.values(obj)) deepFind(v, pred, acc);
  return acc;
}

// ── Step 1: parse ytcfg from charts.youtube.com ──────────────────────────────
async function extractYtcfg(countryCode) {
  const url = `https://charts.youtube.com/charts/TopVideos/${countryCode}`;
  console.log(`\n=== Step 1: Extract ytcfg from ${url} ===`);
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  console.log(`  HTTP ${r.status}`);
  if (!r.ok) return null;

  const html = await r.text();
  console.log(`  HTML size: ${html.length} bytes`);

  // Extract ytcfg.set({...}) call — the data payload
  const setCalls = [...html.matchAll(/ytcfg\.set\s*\(\s*(\{[\s\S]*?\})\s*\)/g)];
  console.log(`  ytcfg.set() calls found: ${setCalls.length}`);

  let cfg = {};
  for (const [, jsonStr] of setCalls) {
    try {
      const obj = JSON.parse(jsonStr);
      Object.assign(cfg, obj);
    } catch (e) {
      // Some calls pass non-JSON; skip
      console.log(`  (skipped non-JSON ytcfg.set block, ${jsonStr.length} chars)`);
    }
  }

  // Key fields
  const KEY_FIELDS = [
    'INNERTUBE_API_KEY', 'INNERTUBE_CONTEXT_CLIENT_NAME', 'INNERTUBE_CONTEXT_CLIENT_VERSION',
    'INNERTUBE_HOST_NAME', 'INNERTUBE_BROWSE_ID', 'INNERTUBE_COUNTRY',
    'DELEGATED_SESSION_ID', 'SESSION_INDEX', 'ID_TOKEN',
    'LOGGED_IN', 'VISITOR_DATA', 'DEVICE', 'INNERTUBE_CLIENT_VERSION',
  ];
  console.log('\n  Key ytcfg fields:');
  for (const k of KEY_FIELDS) {
    if (cfg[k] !== undefined) console.log(`    ${k}: ${JSON.stringify(cfg[k])}`);
  }

  // Print all top-level keys
  const allKeys = Object.keys(cfg).sort();
  console.log(`\n  All ytcfg keys (${allKeys.length}):`);
  allKeys.forEach(k => {
    const v = cfg[k];
    if (typeof v === 'object' && v !== null) {
      console.log(`    ${k}: ${snip(JSON.stringify(v), 120)}`);
    } else {
      console.log(`    ${k}: ${JSON.stringify(v)}`);
    }
  });

  // Also look for INNERTUBE context nested objects
  const ctxFields = Object.keys(cfg).filter(k => k.includes('INNERTUBE') || k.includes('CLIENT'));
  console.log(`\n  INNERTUBE/CLIENT fields: ${ctxFields.join(', ')}`);

  return cfg;
}

// ── Step 2: POST to charts.youtube.com/youtubei/v1/browse ────────────────────
async function browseChartsYT(cfg, browseId, label, extra = {}) {
  const apiKey = cfg.INNERTUBE_API_KEY ?? '';
  const clientName = cfg.INNERTUBE_CONTEXT_CLIENT_NAME ?? 'WEB_MUSIC_ANALYTICS';
  const clientVersion = cfg.INNERTUBE_CONTEXT_CLIENT_VERSION ?? cfg.INNERTUBE_CLIENT_VERSION ?? '1.0';
  const visitorData = cfg.VISITOR_DATA ?? '';

  const url = `https://charts.youtube.com/youtubei/v1/browse${apiKey ? `?key=${apiKey}` : ''}`;
  console.log(`\n=== Step 2 [${label}]: POST ${url.replace(apiKey, '<KEY>')} ===`);
  console.log(`  browseId: ${browseId}, clientName: ${clientName}, clientVersion: ${clientVersion}`);

  const body = {
    browseId,
    ...extra,
    context: {
      client: {
        clientName,
        clientVersion,
        hl: 'en',
        gl: 'KR',
        userAgent: UA,
        ...(visitorData ? { visitorData } : {}),
      },
    },
  };

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': UA,
        'Origin': 'https://charts.youtube.com',
        'Referer': 'https://charts.youtube.com/',
        'X-YouTube-Client-Name': String(cfg['INNERTUBE_CONTEXT_CLIENT_NAME_ID'] ?? clientName),
        'X-YouTube-Client-Version': clientVersion,
      },
      body: JSON.stringify(body),
    });
    console.log(`  HTTP ${r.status}`);
    const ct = r.headers.get('content-type') ?? '';
    if (ct.includes('json')) {
      const data = await r.json();
      analyzeData(data, label);
    } else {
      const txt = await r.text();
      console.log(`  text (${txt.length} bytes): ${snip(txt, 500)}`);
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }
}

// ── Step 3: Try music.youtube.com/youtubei/v1/browse with KR params ──────────
async function browseWithCountryParams() {
  console.log('\n=== Step 3: music.youtube.com browse with KR booleanChoiceEntityKey ===');

  // KR booleanChoiceEntityKey from probe v7:
  const KR_ENTITY_KEY = 'EidleHBsb3JlX2NoYXJ0c19jb3VudHJ5X21lbnVfMzE2NzY2NTY3S1IgkQEoAQ%3D%3D';

  const CLIENT_VERSION = '1.20240724.00.00';
  const ENDPOINT = 'https://music.youtube.com/youtubei/v1/browse';

  // Try passing the KR entity key as a param to FEmusic_charts
  const body = {
    browseId: 'FEmusic_charts',
    params: KR_ENTITY_KEY,
    context: {
      client: { clientName: 'WEB_REMIX', clientVersion: CLIENT_VERSION, hl: 'en', gl: 'KR', userAgent: UA },
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
  console.log(`  HTTP ${r.status}`);
  if (r.ok) {
    const data = await r.json();
    analyzeData(data, 'FEmusic_charts+KR params');
  } else {
    console.log(`  ${snip(await r.text(), 300)}`);
  }

  await new Promise(res => setTimeout(res, 400));

  // Also try formData.selectedValues with KR to see if the charts section changes
  console.log('\n=== Step 3b: formData.selectedValues with KR entity key ===');
  const body2 = {
    browseId: 'FEmusic_charts',
    formData: {
      selectedValues: [KR_ENTITY_KEY],
    },
    context: {
      client: { clientName: 'WEB_REMIX', clientVersion: CLIENT_VERSION, hl: 'en', gl: 'KR', userAgent: UA },
    },
  };

  const r2 = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'Origin': 'https://music.youtube.com',
      'Referer': 'https://music.youtube.com/',
      'X-YouTube-Client-Name': '67',
      'X-YouTube-Client-Version': CLIENT_VERSION,
    },
    body: JSON.stringify(body2),
  });
  console.log(`  HTTP ${r2.status}`);
  if (r2.ok) {
    const data2 = await r2.json();
    analyzeData(data2, 'formData KR');

    // Specifically check if the carousel sections changed vs US
    const sections = data2?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
      ?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
    console.log(`\n  sectionList sections: ${sections.length}`);
    for (const [i, section] of sections.entries()) {
      const carousel = section.musicCarouselShelfRenderer;
      if (!carousel) continue;
      const headerRuns = deepFind(carousel.header ?? {}, o => Array.isArray(o.runs) && o.runs[0]?.text);
      const headerText = headerRuns[0]?.runs?.[0]?.text ?? '';
      const items = carousel.contents ?? [];
      console.log(`  section[${i}] carousel: "${headerText}" (${items.length} items)`);
      for (const [j, item] of items.slice(0, 3).entries()) {
        const twoRow = item.musicTwoRowItemRenderer;
        if (!twoRow) continue;
        const title = twoRow.title?.runs?.[0]?.text ?? '(no title)';
        const browseId = twoRow.title?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId
          ?? twoRow.navigationEndpoint?.browseEndpoint?.browseId ?? '(no browseId)';
        console.log(`    item[${j}]: "${title}" → ${browseId}`);
      }
    }
  } else {
    console.log(`  ${snip(await r2.text(), 300)}`);
  }
}

function analyzeData(data, label) {
  const raw = JSON.stringify(data);
  console.log(`  [${label}] size=${raw.length} bytes`);
  console.log(`  top-level keys: ${Object.keys(data).join(', ')}`);

  for (const n of ARTISTS) {
    const idx = raw.indexOf(n);
    if (idx >= 0) console.log(`  ★ "${n}" found! …${raw.slice(Math.max(0, idx - 50), idx + 100)}…`);
  }

  const videoIds = [...raw.matchAll(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g)].map(m => m[1]);
  console.log(`  videoIds: ${videoIds.length}`);
  if (videoIds.length) console.log(`  First 10: ${videoIds.slice(0, 10).join(', ')}`);

  const mutations = data?.frameworkUpdates?.entityBatchUpdate?.mutations ?? [];
  console.log(`  mutations: ${mutations.length}`);

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
  console.log(`  unique text runs (${texts.length}), first 20:`);
  texts.slice(0, 20).forEach((t, i) => console.log(`    [${i}] ${snip(t, 100)}`));
}

async function main() {
  // Extract ytcfg config from charts.youtube.com/KR page
  const cfg = await extractYtcfg('KR');

  if (cfg && cfg.INNERTUBE_API_KEY) {
    await new Promise(r => setTimeout(r, 500));

    // Try browsing charts.youtube.com with FEmusic_charts
    await browseChartsYT(cfg, 'FEmusic_charts', 'charts.yt/FEmusic_charts+KR');

    await new Promise(r => setTimeout(r, 400));

    // Try with ZZ (Global)
    await browseChartsYT(cfg, 'FEmusic_charts', 'charts.yt/FEmusic_charts+ZZ', {});
  } else {
    console.log('\nNo INNERTUBE_API_KEY found — skipping charts.youtube.com POST attempts');
    if (cfg) console.log('  Available keys:', Object.keys(cfg).filter(k => k.includes('INNERTUBE')).join(', '));
  }

  await new Promise(r => setTimeout(r, 500));

  // Test music.youtube.com with country params
  await browseWithCountryParams();

  console.log('\n=== Probe v8 complete ===');
}

main().catch(e => { console.error(e); process.exit(1); });
