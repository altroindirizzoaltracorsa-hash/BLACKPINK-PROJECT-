/**
 * Probe v5:
 * - v4 confirmed formData.selectedValues only returns the country-selector form
 *   (70 mutations, all musicForm/musicFormBooleanChoice, 0 videoIds, only country names).
 * - The bare gl=KR call returned 358KB vs 292KB — 66KB of extra data not analyzed by v4.
 * - Hypothesis: chart track data lives in the classic `contents` renderer tree, NOT in
 *   mutations. Possibly musicCarouselShelfRenderer / musicImmersiveCarouselShelfRenderer.
 *
 * This version:
 * 1. Runs full analyzeResponse on the bare gl=KR call (was skipped in v4).
 * 2. Adds analyzeContentsTree to walk every renderer under sectionListRenderer.
 * 3. Looks for continuation tokens and follows one if found.
 * 4. Also checks bare gl=US for comparison.
 * 5. Inspects all mutation payload types in bare calls (not just formData calls).
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

async function continuation(token, gl = 'US') {
  const body = {
    continuation: token,
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

// Walk every renderer type under sectionListRenderer
function analyzeContentsTree(data, label) {
  console.log(`\n  [${label}] === Contents Tree ===`);
  const tabs = data?.contents?.singleColumnBrowseResultsRenderer?.tabs ?? [];
  console.log(`  tabs: ${tabs.length}`);

  for (const [ti, tab] of tabs.entries()) {
    const tabR = tab?.tabRenderer;
    const tabTitle = tabR?.title ?? '(no title)';
    const content = tabR?.content;
    if (!content) { console.log(`  tab[${ti}] "${tabTitle}": no content`); continue; }

    const contentKeys = Object.keys(content);
    console.log(`  tab[${ti}] "${tabTitle}" content keys: ${contentKeys.join(', ')}`);

    const sections = content?.sectionListRenderer?.contents ?? [];
    console.log(`  tab[${ti}] sections: ${sections.length}`);

    let foundContinuation = null;
    const contTokens = deepFind(content, o => typeof o.continuation === 'string' && o.continuation.length > 20);
    if (contTokens.length) {
      foundContinuation = contTokens[0].continuation;
      console.log(`  [CONTINUATION TOKEN] ${snip(foundContinuation, 100)}`);
    }

    for (const [si, section] of sections.entries()) {
      const keys = Object.keys(section);
      console.log(`\n    section[${si}] renderer types: ${keys.join(', ')}`);

      // Check every known renderer
      const RENDERERS = [
        'musicCarouselShelfRenderer',
        'musicImmersiveCarouselShelfRenderer',
        'musicShelfRenderer',
        'musicDescriptionShelfRenderer',
        'gridRenderer',
        'musicResponsiveListItemRenderer',
        'musicTwoRowItemRenderer',
        'singleColumnMusicWatchNextResultsRenderer',
        'itemSectionRenderer',
      ];

      for (const rType of RENDERERS) {
        const r = section[rType];
        if (!r) continue;
        console.log(`    [${rType}]`);

        // Header text
        if (r.header) {
          const runs = deepFind(r.header, o => Array.isArray(o.runs) && o.runs[0]?.text);
          const texts = runs.map(x => x.runs.map(y => y.text).join(''));
          console.log(`      header texts: ${texts.slice(0, 5).join(' | ')}`);
        }

        const items = r.contents ?? r.items ?? [];
        console.log(`      items: ${items.length}`);
        if (items.length > 0) {
          console.log(`      item[0] keys: ${Object.keys(items[0]).join(', ')}`);
          console.log(`      item[0]: ${snip(JSON.stringify(items[0]), 800)}`);
          if (items.length > 1) console.log(`      item[1]: ${snip(JSON.stringify(items[1]), 400)}`);
        }
      }

      // Fallback: just print section in full if it's not a known renderer
      if (!RENDERERS.some(t => section[t])) {
        console.log(`    (unknown) section: ${snip(JSON.stringify(section), 400)}`);
      }
    }

    if (foundContinuation) return foundContinuation;
  }
  return null;
}

function analyzeResponse(label, data) {
  const raw = JSON.stringify(data);
  console.log(`\n[${label}] size=${raw.length} bytes`);

  // Artist name scan
  for (const n of ARTISTS) {
    const idx = raw.indexOf(n);
    if (idx >= 0) console.log(`  ★ "${n}" found! …${raw.slice(Math.max(0, idx - 50), idx + 80)}…`);
  }

  // Mutations
  const mutations = data?.frameworkUpdates?.entityBatchUpdate?.mutations ?? [];
  console.log(`  mutations: ${mutations.length}`);
  if (mutations.length > 0) {
    const types = [...new Set(mutations.map(m => Object.keys(m.payload ?? {}).join('+')))];
    console.log(`  mutation payload types: ${types.join(' | ')}`);

    // If NOT all form mutations, print first few in full
    const hasNonForm = mutations.some(m => !m.payload?.musicForm && !m.payload?.musicFormBooleanChoice);
    if (hasNonForm) {
      console.log('  NON-FORM mutations found! Printing first 5:');
      const nonForm = mutations.filter(m => !m.payload?.musicForm && !m.payload?.musicFormBooleanChoice);
      nonForm.slice(0, 5).forEach((m, i) =>
        console.log(`    nonForm[${i}]: ${snip(JSON.stringify(m, null, 2), 2000)}`));
    } else {
      console.log('  All mutations are form/boolean-choice (country selector only)');
    }
  }

  // Shelves
  const allShelves = deepFind(data, o => o.musicShelfRenderer != null);
  console.log(`  musicShelfRenderers: ${allShelves.length}`);
  for (const s of allShelves) {
    const items = s.musicShelfRenderer?.contents ?? [];
    console.log(`    shelf items: ${items.length}`);
    if (items.length > 0) console.log(`    item[0]: ${snip(JSON.stringify(items[0]), 600)}`);
  }

  // Carousel shelves
  const carousels = deepFind(data, o =>
    o.musicCarouselShelfRenderer != null || o.musicImmersiveCarouselShelfRenderer != null);
  console.log(`  carousel shelves: ${carousels.length}`);
  for (const c of carousels.slice(0, 3)) {
    const r = c.musicCarouselShelfRenderer ?? c.musicImmersiveCarouselShelfRenderer;
    const items = r?.contents ?? r?.items ?? [];
    console.log(`    carousel items: ${items.length}`);
    if (items.length > 0) {
      console.log(`    item[0]: ${snip(JSON.stringify(items[0]), 800)}`);
    }
  }

  // Ranked objects
  const ranked = deepFind(data, o =>
    (o.index != null || o.rank != null || o.position != null) &&
    (o.title || o.primaryText || o.runs));
  console.log(`  ranked-like objects: ${ranked.length}`);
  ranked.slice(0, 5).forEach(o => console.log(`    ${snip(JSON.stringify(o), 200)}`));

  // Text runs
  const allRuns = deepFind(data, o => Array.isArray(o.runs) && o.runs[0]?.text);
  const texts = [...new Set(allRuns.map(o => o.runs.map(r => r.text).join('')))];
  console.log(`  unique text runs (${texts.length}):`);
  texts.slice(0, 80).forEach((t, i) => console.log(`    [${i}] ${snip(t, 100)}`));

  // videoIds
  const videoIds = [...raw.matchAll(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g)].map(m => m[1]);
  console.log(`  videoIds: ${videoIds.length}`);
  if (videoIds.length) console.log('  First 15 videoIds:', videoIds.slice(0, 15).join(', '));

  // Top-level response keys
  console.log(`  top-level keys: ${Object.keys(data).join(', ')}`);
}

async function main() {
  // ── Call 1: bare FEmusic_charts, gl=KR (was 358KB in v4 — FULL analysis this time) ─
  console.log('\n=== Call 1: bare FEmusic_charts, gl=KR (full analysis) ===');
  const d1 = await browse('FEmusic_charts', {}, 'KR');
  if (d1) {
    analyzeResponse('bare KR', d1);
    const contToken = analyzeContentsTree(d1, 'bare KR');

    if (contToken) {
      await new Promise(r => setTimeout(r, 600));
      console.log('\n=== Continuation call for bare KR ===');
      const dc = await continuation(contToken, 'KR');
      if (dc) analyzeResponse('KR continuation', dc);
    }
  }

  await new Promise(r => setTimeout(r, 600));

  // ── Call 2: bare FEmusic_charts, gl=US (baseline comparison) ──────────────
  console.log('\n=== Call 2: bare FEmusic_charts, gl=US ===');
  const d2 = await browse('FEmusic_charts', {}, 'US');
  if (d2) {
    const raw2 = JSON.stringify(d2);
    const mutations2 = d2?.frameworkUpdates?.entityBatchUpdate?.mutations ?? [];
    console.log(`  size=${raw2.length} mutations=${mutations2.length}`);
    const types2 = [...new Set(mutations2.map(m => Object.keys(m.payload ?? {}).join('+')))];
    console.log(`  mutation payload types: ${types2.join(' | ')}`);
    const videoIds2 = [...raw2.matchAll(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g)].map(m => m[1]);
    console.log(`  videoIds: ${videoIds2.length}`);
    // Only do full analysis if it differs meaningfully from KR
    if (d1 && raw2.length !== JSON.stringify(d1).length) {
      analyzeContentsTree(d2, 'bare US');
    }
  }

  await new Promise(r => setTimeout(r, 600));

  // ── Call 3: try Android Music client (may return chart data differently) ──
  console.log('\n=== Call 3: ANDROID_MUSIC client, gl=KR ===');
  const bodyAndroid = {
    browseId: 'FEmusic_charts',
    context: {
      client: {
        clientName: 'ANDROID_MUSIC',
        clientVersion: '5.28.53',
        hl: 'en',
        gl: 'KR',
        userAgent: UA,
        androidSdkVersion: 31,
      },
    },
  };
  const rA = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'Origin': 'https://music.youtube.com',
      'Referer': 'https://music.youtube.com/',
      'X-YouTube-Client-Name': '21',
      'X-YouTube-Client-Version': '5.28.53',
    },
    body: JSON.stringify(bodyAndroid),
  });
  if (rA.ok) {
    const dA = await rA.json();
    analyzeResponse('Android KR', dA);
  } else {
    console.log(`  HTTP ${rA.status}: ${snip(await rA.text())}`);
  }

  console.log('\n=== Probe v5 complete ===');
}

main().catch(e => { console.error(e); process.exit(1); });
