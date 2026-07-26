/**
 * Probe v4:
 * - v3 confirmed the initial FEmusic_charts response is ALL country-selector
 *   form entities (70 mutations), no track data.
 * - deepFind depth=12 was too shallow — formItemEntityKey is ~22 levels deep.
 * - The Global (ZZ) formItemEntityKey is now known from v2/v3 data.
 *
 * This version:
 * 1. Makes the formData.selectedValues call with the known Global key to get
 *    actual chart entries.
 * 2. Also tries the KR key (built from the known pattern).
 * 3. No depth limit on deepFind — JSON has no circular refs.
 * 4. Prints ALL text strings found to identify song/artist name fields.
 * 5. Tries to extract ranked entries (rank + title + artist + videoId).
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ENDPOINT = 'https://music.youtube.com/youtubei/v1/browse';
const CLIENT_VERSION = '1.20240724.00.00';
const ARTISTS = ['BLACKPINK', 'JENNIE', 'JISOO', 'ROSÉ', 'ROSA', 'LISA', 'Less Than a Lover'];

// From probe v2 country dropdown (musicMultiSelectMenuItemRenderer.formItemEntityKey):
const KEYS = {
  ZZ: 'EidleHBsb3JlX2NoYXJ0c19jb3VudHJ5X21lbnVfMzE2NzY2NTY3WlogkQEoAQ%3D%3D',
  US: 'EidleHBsb3JlX2NoYXJ0c19jb3VudHJ5X21lbnVfMzE2NzY2NTY3VVMgkQEoAQ%3D%3D',
};

// Build keys for other countries by substituting the 2-char country code
// The pattern: common_prefix + base64(country_code + " ") + suffix
// where common_prefix encodes "explore_charts_country_menu_316766567"
// and the country code bytes (2 chars + space = 3 bytes) fit into 4 base64 chars.
// From the pattern: US → "VVMg", ZZ → "Wlog", we can derive others.
function buildCountryKey(countryCode) {
  // The 3 bytes to encode: countryCode[0], countryCode[1], 0x20 (space)
  const b0 = countryCode.charCodeAt(0);
  const b1 = countryCode.charCodeAt(1);
  const b2 = 0x20;
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  // Pack 3 bytes into 4 base64 chars
  const n = (b0 << 16) | (b1 << 8) | b2;
  const s = B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  const PREFIX = 'EidleHBsb3JlX2NoYXJ0c19jb3VudHJ5X21lbnVfMzE2NzY2NTY3';
  const SUFFIX = 'kQEoAQ%3D%3D';
  return PREFIX + s + SUFFIX;
}

function snip(v, max = 300) { return String(v).length > max ? String(v).slice(0, max) + '…' : String(v); }

// deepFind with no depth limit — JSON has no circular refs
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
    // Show first mutation type + payload keys
    const firstPayloadKeys = Object.keys(mutations[0]?.payload ?? {});
    console.log(`  first mutation payload keys: ${firstPayloadKeys.join(', ')}`);
    // If it's NOT a musicForm, print it in full
    if (!mutations[0]?.payload?.musicForm) {
      console.log('  First mutation (full):', snip(JSON.stringify(mutations[0], null, 2), 2000));
    }
    // Print all distinct payload types
    const types = [...new Set(mutations.map(m => Object.keys(m.payload ?? {}).join('+')))];
    console.log(`  mutation payload types: ${types.join(' | ')}`);
  }

  // Classic renderer shelf entries
  const allShelves = deepFind(data, o => o.musicShelfRenderer != null);
  console.log(`  musicShelfRenderers: ${allShelves.length}`);
  for (const s of allShelves) {
    const shelf = s.musicShelfRenderer;
    const items = shelf?.contents ?? [];
    console.log(`    shelf contents length: ${items.length}`);
    if (items.length > 0) {
      console.log('    First item keys:', Object.keys(items[0]).join(', '));
      console.log('    First item:', snip(JSON.stringify(items[0]), 600));
    }
  }

  // Look for any object with a numeric "index" or "rank" or "position" field alongside title
  const ranked = deepFind(data, o =>
    (o.index != null || o.rank != null || o.position != null) &&
    (o.title || o.primaryText || o.runs)
  );
  console.log(`  ranked-like objects: ${ranked.length}`);
  ranked.slice(0, 5).forEach(o => console.log(`    ${snip(JSON.stringify(o), 200)}`));

  // Collect all "runs" text strings (song/artist names live here)
  const allRuns = deepFind(data, o => Array.isArray(o.runs) && o.runs[0]?.text);
  const texts = [...new Set(allRuns.map(o => o.runs.map(r => r.text).join('')))];
  console.log(`  unique text runs (${texts.length}):`);
  texts.slice(0, 60).forEach((t, i) => console.log(`    [${i}] ${snip(t, 100)}`));

  // Look for videoId in any form
  const videoIds = [...raw.matchAll(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g)].map(m => m[1]);
  console.log(`  videoIds: ${videoIds.length}`);
  if (videoIds.length) console.log('  First 10 videoIds:', videoIds.slice(0, 10).join(', '));

  // Count formItemEntityKey entries (for country dropdown)
  const formKeys = deepFind(data, o => typeof o.formItemEntityKey === 'string');
  console.log(`  formItemEntityKey entries: ${formKeys.length}`);
}

async function main() {
  // Build South Korea key from the pattern
  const krKey = buildCountryKey('KR');
  console.log('Built KR key:', krKey);
  // Also verify against known keys
  console.log('Verify US key matches known:', buildCountryKey('US') === KEYS.US);
  console.log('Verify ZZ key matches known:', buildCountryKey('ZZ') === KEYS.ZZ);

  // ── Call 1: formData with Global (ZZ) selected ─────────────────────────
  console.log('\n=== Call 1: formData selectedValues=[ZZ/Global] ===');
  const d1 = await browse('FEmusic_charts', {
    formData: { selectedValues: [KEYS.ZZ] },
  }, 'US');
  if (d1) analyzeResponse('Global formData', d1);

  await new Promise(r => setTimeout(r, 600));

  // ── Call 2: formData with South Korea selected ────────────────────────
  console.log('\n=== Call 2: formData selectedValues=[KR] ===');
  const d2 = await browse('FEmusic_charts', {
    formData: { selectedValues: [krKey] },
  }, 'KR');
  if (d2) analyzeResponse('KR formData', d2);

  await new Promise(r => setTimeout(r, 600));

  // ── Call 3: no formData, gl=KR (does gl alone change chart content?) ──
  console.log('\n=== Call 3: no formData, gl=KR baseline ===');
  const d3 = await browse('FEmusic_charts', {}, 'KR');
  if (d3) {
    // Just compare size and mutation count vs Call 1
    const m = d3?.frameworkUpdates?.entityBatchUpdate?.mutations ?? [];
    const raw = JSON.stringify(d3);
    console.log(`  size=${raw.length} mutations=${m.length}`);
    // Check if content is different from Global call
    if (d1 && JSON.stringify(d3) === JSON.stringify(d1)) {
      console.log('  IDENTICAL to Global call — gl= alone has no effect on content');
    } else {
      console.log('  Different from Global call — gl= affects the response');
    }
  }

  console.log('\n=== Probe v4 complete ===');
}

main().catch(e => { console.error(e); process.exit(1); });
