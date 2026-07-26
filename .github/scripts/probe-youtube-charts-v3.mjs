/**
 * Probe v3: the v2 FEmusic_charts call returned 200 with 354KB but 0 videoIds.
 * The actual track data lives in frameworkUpdates.entityBatchUpdate.mutations
 * (entity-based format YouTube Music uses for chart entries).
 *
 * This version:
 * 1. Calls FEmusic_charts and deeply extracts chart entries from mutations
 * 2. Extracts formItemEntityKey values from the country-selector dropdown
 * 3. Makes a second call with formData.selectedValues to get a different country's chart
 * 4. Tries gl=KR for Korean charts (most likely to contain BLACKPINK)
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ENDPOINT = 'https://music.youtube.com/youtubei/v1/browse';
const CLIENT_VERSION = '1.20240724.00.00';
const ARTISTS = ['BLACKPINK', 'JENNIE', 'JISOO', 'ROSÉ', 'ROSA', 'LISA', 'Less Than a Lover', 'LTAL'];

function snip(text, max = 400) { return String(text).length > max ? String(text).slice(0, max) + '…' : String(text); }

function deepFind(obj, predicate, results = [], depth = 0) {
  if (depth > 12 || !obj || typeof obj !== 'object') return results;
  if (predicate(obj)) results.push(obj);
  for (const v of Object.values(obj)) deepFind(v, predicate, results, depth + 1);
  return results;
}

// ── browse helper ──────────────────────────────────────────────────────────

async function browse(browseId, extra = {}, gl = 'US') {
  const body = {
    browseId,
    ...extra,
    context: {
      client: {
        clientName: 'WEB_REMIX',
        clientVersion: CLIENT_VERSION,
        hl: 'en',
        gl,
        userAgent: UA,
      },
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

// ── parse chart entries from entity mutations ──────────────────────────────

function parseMutations(data) {
  const mutations = data?.frameworkUpdates?.entityBatchUpdate?.mutations ?? [];
  console.log(`  mutations count: ${mutations.length}`);
  if (!mutations.length) return [];

  // Print first mutation in full to understand schema
  console.log('\n  First mutation (full):');
  console.log(JSON.stringify(mutations[0], null, 2).slice(0, 3000));

  // Try to extract track info from each mutation
  const tracks = [];
  for (const m of mutations) {
    const p = m.payload;
    if (!p) continue;

    // Entity-based: payload may be { musicImmersiveCarouselShelfRendererEntity, ... }
    // or payload.musicChartEntryRenderer, or payload.musicEntityByBrowseIdMutation, etc.
    // Walk the payload for recognizable track-like fields
    const titles = deepFind(p, o => typeof o.text === 'string' && o.text.length > 0);
    const runs = deepFind(p, o => Array.isArray(o.runs) && o.runs[0]?.text);

    // Also look for position / rank
    const positions = deepFind(p, o => typeof o.rank === 'number' || typeof o.position === 'number');
    const videoIds = deepFind(p, o => typeof o.videoId === 'string' && o.videoId.length === 11);

    if (videoIds.length || runs.length) {
      tracks.push({
        entityKey: m.entityKey,
        videoId: videoIds[0]?.videoId,
        rank: positions[0]?.rank ?? positions[0]?.position,
        texts: runs.slice(0, 4).map(r => r.runs[0].text),
      });
    }
  }
  return tracks;
}

// ── extract country options from first response ────────────────────────────

function extractCountryOptions(data) {
  const allMenuItems = deepFind(data, o => typeof o.formItemEntityKey === 'string' && Array.isArray(o.title?.runs));
  const options = allMenuItems.map(o => ({
    key: o.formItemEntityKey,
    title: o.title.runs[0]?.text,
  }));
  console.log(`\n  Country options found: ${options.length}`);
  options.slice(0, 20).forEach(o => console.log(`    ${o.title}: ${snip(o.key, 60)}`));
  return options;
}

// ── scan for BLACKPINK / member names anywhere in response ─────────────────

function scanForArtists(data) {
  const raw = JSON.stringify(data);
  console.log(`  Response size: ${raw.length} bytes`);
  for (const name of ARTISTS) {
    const idx = raw.indexOf(name);
    if (idx >= 0) {
      console.log(`  ★ "${name}" found! Context: …${raw.slice(Math.max(0, idx - 60), idx + 80)}…`);
    }
  }
}

// ── Step 1: initial FEmusic_charts call ───────────────────────────────────

async function step1_initialCharts(gl = 'US') {
  console.log(`\n=== Step 1: FEmusic_charts gl=${gl} (initial) ===`);
  const data = await browse('FEmusic_charts', {}, gl);
  if (!data) return null;

  scanForArtists(data);
  const options = extractCountryOptions(data);

  // Print first 200 chars to spot-check the structure root
  const raw = JSON.stringify(data);
  console.log('\n  Contents keys:', Object.keys(data.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0] ?? {}).join(', '));

  // Walk for any "musicShelfRenderer" with actual contents
  const shelves = deepFind(data, o => o.musicShelfRenderer?.contents?.length > 0);
  console.log(`\n  musicShelfRenderer with contents: ${shelves.length}`);
  if (shelves.length) {
    const firstContent = shelves[0].musicShelfRenderer.contents[0];
    console.log('  First shelf item keys:', Object.keys(firstContent).join(', '));
    console.log('  First shelf item (600 chars):', snip(JSON.stringify(firstContent), 600));
  }

  // Check mutations
  const tracks = parseMutations(data);
  if (tracks.length) {
    console.log(`\n  Parsed ${tracks.length} tracks from mutations:`);
    tracks.slice(0, 10).forEach((t, i) => console.log(`    #${i + 1} rank=${t.rank} vid=${t.videoId} texts=${t.texts.join(' | ')}`));
  }

  return { data, options };
}

// ── Step 2: second call with formData to select a specific country ─────────

async function step2_countryChart(options, targetCountry, gl = 'US') {
  const opt = options.find(o => o.title === targetCountry) || options.find(o => o.title?.includes(targetCountry));
  if (!opt) { console.log(`\n  No option found for "${targetCountry}"`); return null; }

  console.log(`\n=== Step 2: FEmusic_charts with formData for "${opt.title}" (key: ${snip(opt.key, 50)}) ===`);

  const data = await browse('FEmusic_charts', {
    formData: { selectedValues: [opt.key] },
  }, gl);
  if (!data) return null;

  scanForArtists(data);

  const tracks = parseMutations(data);
  if (tracks.length) {
    console.log(`\n  Parsed ${tracks.length} tracks from mutations:`);
    tracks.slice(0, 50).forEach((t, i) => console.log(`    #${i + 1} rank=${t.rank} vid=${t.videoId} texts=${t.texts.join(' | ')}`));
  }

  // Also scan shelves
  const shelves = deepFind(data, o => o.musicShelfRenderer?.contents?.length > 0);
  console.log(`\n  musicShelfRenderer with contents: ${shelves.length}`);
  if (shelves.length) {
    console.log('  First 3 shelf items:');
    shelves[0].musicShelfRenderer.contents.slice(0, 3).forEach((item, i) => {
      console.log(`    [${i}] keys: ${Object.keys(item).join(', ')}`);
      console.log(`         ${snip(JSON.stringify(item), 400)}`);
    });
  }

  return { data, tracks };
}

// ── Step 3: try gl=KR directly (Korean charts) ───────────────────────────

async function step3_koreanCharts() {
  console.log('\n=== Step 3: FEmusic_charts gl=KR (Korean charts) ===');
  const data = await browse('FEmusic_charts', {}, 'KR');
  if (!data) return;

  scanForArtists(data);
  const tracks = parseMutations(data);
  if (tracks.length) {
    console.log(`\n  Parsed ${tracks.length} tracks:`);
    tracks.slice(0, 20).forEach((t, i) => console.log(`    #${i + 1} rank=${t.rank} vid=${t.videoId} texts=${t.texts.join(' | ')}`));
  }
}

// ── main ──────────────────────────────────────────────────────────────────

async function main() {
  const result = await step1_initialCharts('US');
  if (!result) { console.log('Step 1 failed'); process.exit(1); }

  const { options } = result;

  // Try Global chart (most likely to have popular international acts)
  const globalOpt = options.find(o => o.title === 'Global');
  if (globalOpt) {
    await step2_countryChart(options, 'Global', 'US');
  } else {
    console.log('\nNo Global option found in US response; options:', options.map(o => o.title).slice(0, 20));
  }

  // Try South Korea
  const krOpt = options.find(o => o.title === 'South Korea' || o.title === 'Korea' || o.title === 'KR');
  if (krOpt) {
    await step2_countryChart(options, krOpt.title, 'KR');
  }

  await step3_koreanCharts();

  console.log('\n=== Probe v3 complete ===');
}

main().catch(e => { console.error(e); process.exit(1); });
