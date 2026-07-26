/**
 * Probe v7:
 * - v6 confirmed US chart playlists via browseId, but gl=KR has no effect.
 * - Two remaining approaches to get non-US chart data:
 *   1. Inspect the musicForm parent entity mutation (parentFormEntityKey from v6)
 *      — may contain onSelectCommand/submitEndpoint with country-specific params.
 *   2. Scrape charts.youtube.com HTML — embeds ytInitialData server-side per country.
 *
 * This version:
 * 1. Fetches FEmusic_charts, finds musicForm mutation (not musicFormBooleanChoice),
 *    prints it in full to check for any submitEndpoint / serviceEndpoint / browseEndpoint.
 * 2. Tries charts.youtube.com/charts/TopVideos/KR as HTML fetch, parses ytInitialData.
 * 3. Tries charts.youtube.com/charts/TopVideos/ZZ (Global) the same way.
 * 4. If ytInitialData found, extracts ranked tracks and checks for BLACKPINK/members.
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

// ── Approach 1: musicForm parent entity ──────────────────────────────────────
async function inspectMusicFormMutation() {
  console.log('\n=== Approach 1: musicForm parent entity mutation ===');
  const hub = await browse('FEmusic_charts', {}, 'US');
  if (!hub) { console.log('Hub call failed'); return; }

  const mutations = hub?.frameworkUpdates?.entityBatchUpdate?.mutations ?? [];
  console.log(`Total mutations: ${mutations.length}`);

  // Print all payload types
  const types = [...new Set(mutations.map(m => Object.keys(m.payload ?? {}).join('+')))];
  console.log(`Payload types: ${types.join(' | ')}`);

  // Find musicForm mutations (not musicFormBooleanChoice)
  const formMuts = mutations.filter(m => m.payload?.musicForm);
  console.log(`musicForm mutations: ${formMuts.length}`);
  if (formMuts.length > 0) {
    formMuts.forEach((m, i) => {
      console.log(`\n--- musicForm[${i}] ---`);
      console.log(JSON.stringify(m, null, 2).slice(0, 8000));
    });
  } else {
    console.log('No musicForm mutations found');
  }

  // Also print ALL non-form mutations in full
  const nonForm = mutations.filter(m => !m.payload?.musicForm && !m.payload?.musicFormBooleanChoice);
  console.log(`\nNon-form mutations: ${nonForm.length}`);
  nonForm.forEach((m, i) => {
    console.log(`\n--- nonForm[${i}] ---`);
    console.log(JSON.stringify(m, null, 2).slice(0, 4000));
  });

  // Print first musicFormBooleanChoice in full to confirm structure
  const boolMut = mutations.find(m => m.payload?.musicFormBooleanChoice);
  if (boolMut) {
    console.log('\n--- First musicFormBooleanChoice (for reference) ---');
    console.log(JSON.stringify(boolMut, null, 2));
  }

  // Check if any mutation has endpoints/commands
  const withEndpoints = mutations.filter(m => {
    const s = JSON.stringify(m);
    return s.includes('Endpoint') || s.includes('Command') || s.includes('serviceEndpoint');
  });
  console.log(`\nMutations with Endpoint/Command: ${withEndpoints.length}`);
  withEndpoints.slice(0, 3).forEach((m, i) => {
    console.log(`\n--- withEndpoint[${i}] ---`);
    console.log(JSON.stringify(m, null, 2).slice(0, 3000));
  });
}

// ── Approach 2: charts.youtube.com HTML scrape ───────────────────────────────
async function scrapeYouTubeCharts(countryCode, label) {
  console.log(`\n=== Approach 2: charts.youtube.com HTML — ${label} (${countryCode}) ===`);

  const urls = [
    `https://charts.youtube.com/charts/TopVideos/${countryCode}`,
    `https://charts.youtube.com/charts/TopVideos/${countryCode}?hl=en`,
  ];

  for (const url of urls) {
    console.log(`\n  Fetching: ${url}`);
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      });
      console.log(`  HTTP ${r.status} ${r.statusText}`);
      console.log(`  Content-Type: ${r.headers.get('content-type')}`);

      if (!r.ok) {
        const txt = await r.text();
        console.log(`  Body (first 500): ${snip(txt, 500)}`);
        continue;
      }

      const html = await r.text();
      console.log(`  HTML size: ${html.length} bytes`);

      // Look for ytInitialData
      const ytInitMatch = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*(?:var |<\/script>)/s);
      if (ytInitMatch) {
        console.log(`  ✓ ytInitialData found! JSON size: ${ytInitMatch[1].length}`);
        try {
          const data = JSON.parse(ytInitMatch[1]);
          analyzeChartsData(data, label);
        } catch (e) {
          console.log(`  JSON parse error: ${e.message}`);
          console.log(`  Raw snippet: ${ytInitMatch[1].slice(0, 500)}`);
        }
      } else {
        // Try alternate patterns
        const idx = html.indexOf('ytInitialData');
        console.log(`  ytInitialData index in HTML: ${idx}`);
        if (idx >= 0) {
          console.log(`  Snippet around ytInitialData: ${html.slice(idx, idx + 400)}`);
        }

        // Also check for window.ytInitialData
        const idx2 = html.indexOf('window["ytInitialData"]');
        if (idx2 >= 0) {
          console.log(`  window["ytInitialData"] found at ${idx2}`);
          console.log(`  Snippet: ${html.slice(idx2, idx2 + 400)}`);
        }

        // Check what scripts are inlined
        const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
        console.log(`  Inline script blocks: ${scriptMatches.length}`);
        scriptMatches.forEach((m, i) => {
          if (m[1].trim().length > 20) {
            console.log(`  script[${i}] (${m[1].length} chars): ${snip(m[1].trim(), 200)}`);
          }
        });

        for (const n of ARTISTS) {
          const aidx = html.indexOf(n);
          if (aidx >= 0) console.log(`  ★ "${n}" in HTML at ${aidx}: ${html.slice(Math.max(0, aidx - 30), aidx + 80)}`);
        }

        // Print first 2000 chars of HTML to understand structure
        console.log(`\n  HTML head (first 2000 chars):\n${html.slice(0, 2000)}`);
      }
    } catch (e) {
      console.log(`  Fetch error: ${e.message}`);
    }
  }
}

// ── Also try the charts.youtube.com API directly ─────────────────────────────
async function scrapeChartsAPI(countryCode, label) {
  console.log(`\n=== Approach 2b: charts.youtube.com API — ${label} ===`);

  const endpoints = [
    `https://charts.youtube.com/api/charts/TopVideos/${countryCode}?hl=en`,
    `https://charts.youtube.com/youtubei/v1/browse?browseId=FEmusic_charts&gl=${countryCode}`,
  ];

  for (const url of endpoints) {
    console.log(`  GET ${url}`);
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Origin': 'https://charts.youtube.com', 'Referer': 'https://charts.youtube.com/' },
      });
      console.log(`  HTTP ${r.status}`);
      if (r.ok) {
        const ct = r.headers.get('content-type') ?? '';
        if (ct.includes('json')) {
          const d = await r.json();
          console.log(`  JSON keys: ${Object.keys(d).join(', ')}`);
          console.log(`  ${snip(JSON.stringify(d), 1000)}`);
        } else {
          const txt = await r.text();
          console.log(`  text (${txt.length} bytes): ${snip(txt, 300)}`);
        }
      } else {
        console.log(`  ${snip(await r.text(), 300)}`);
      }
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
  }
}

function analyzeChartsData(data, label) {
  const raw = JSON.stringify(data);
  console.log(`  [${label}] data size: ${raw.length} bytes`);
  console.log(`  top-level keys: ${Object.keys(data).join(', ')}`);

  // Artist scan
  for (const n of ARTISTS) {
    const idx = raw.indexOf(n);
    if (idx >= 0) console.log(`  ★ "${n}" found! …${raw.slice(Math.max(0, idx - 50), idx + 100)}…`);
  }

  // videoIds
  const videoIds = [...raw.matchAll(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g)].map(m => m[1]);
  console.log(`  videoIds: ${videoIds.length}`);
  if (videoIds.length) console.log(`  First 15: ${videoIds.slice(0, 15).join(', ')}`);

  // chartEntries / entries / items
  const entries = deepFind(data, o => Array.isArray(o.entries) && o.entries.length > 0);
  console.log(`  objects with .entries[]: ${entries.length}`);
  if (entries.length) console.log(`  entries[0][0]: ${snip(JSON.stringify(entries[0].entries[0]), 300)}`);

  // musicResponsiveListItemRenderer
  const listItems = deepFind(data, o => o.musicResponsiveListItemRenderer != null);
  console.log(`  musicResponsiveListItemRenderers: ${listItems.length}`);
  if (listItems.length > 0) {
    const li = listItems[0].musicResponsiveListItemRenderer;
    const cols = li.flexColumns ?? [];
    const texts = cols.map(c => c.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map(r => r.text)?.join('') ?? '');
    console.log(`  item[0] cols: ${texts.join(' | ')}`);
  }

  // Text runs (first 30)
  const allRuns = deepFind(data, o => Array.isArray(o.runs) && o.runs[0]?.text);
  const texts = [...new Set(allRuns.map(o => o.runs.map(r => r.text).join('')))];
  console.log(`  unique text runs (${texts.length}), first 30:`);
  texts.slice(0, 30).forEach((t, i) => console.log(`    [${i}] ${snip(t, 100)}`));
}

async function main() {
  await inspectMusicFormMutation();

  await new Promise(r => setTimeout(r, 800));

  await scrapeYouTubeCharts('KR', 'South Korea');

  await new Promise(r => setTimeout(r, 600));

  await scrapeYouTubeCharts('ZZ', 'Global');

  await new Promise(r => setTimeout(r, 600));

  await scrapeChartsAPI('KR', 'South Korea');

  console.log('\n=== Probe v7 complete ===');
}

main().catch(e => { console.error(e); process.exit(1); });
