/**
 * Probe: maps the charts.youtube.com internal API so we can build a proper
 * nightly fetch without going through kworb.
 *
 * What this does:
 * 1. Fetches the charts.youtube.com homepage and extracts:
 *    - the embedded API key
 *    - any ytInitialData / initialData JSON baked into the page
 * 2. Makes a direct POST to the browse endpoint for Global top songs
 * 3. Repeats for a few key countries (KR, US, TW, SG)
 * 4. Logs the raw JSON and a structural summary so we know how to parse entries
 *
 * Safe to remove once fetch_youtube_chart_positions.mjs ships.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BASE = 'https://charts.youtube.com';

// Known fallback key embedded in the public site (may rotate, so we also try
// to extract dynamically below).
const FALLBACK_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-NKNELL6Cs';

function excerpt(obj, depth = 0, maxDepth = 3) {
  if (depth > maxDepth) return '…';
  if (Array.isArray(obj)) {
    const items = obj.slice(0, 2).map(v => excerpt(v, depth + 1, maxDepth));
    return `[${items.join(', ')}${obj.length > 2 ? `, … (${obj.length} total)` : ''}]`;
  }
  if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj);
    const pairs = keys.slice(0, 6).map(k => `${k}: ${excerpt(obj[k], depth + 1, maxDepth)}`);
    return `{${pairs.join(', ')}${keys.length > 6 ? ', …' : ''}}`;
  }
  if (typeof obj === 'string') return obj.length > 80 ? `"${obj.slice(0, 80)}…"` : `"${obj}"`;
  return String(obj);
}

function walk(obj, path = '') {
  if (Array.isArray(obj)) {
    if (obj.length) walk(obj[0], `${path}[0]`);
    return;
  }
  if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj);
    if (keys.length <= 12) {
      console.log(`${path || '(root)'}: { ${keys.join(', ')} }`);
    } else {
      console.log(`${path || '(root)'}: { ${keys.slice(0, 12).join(', ')} … (${keys.length} keys) }`);
    }
    for (const k of keys) walk(obj[k], path ? `${path}.${k}` : k);
  }
}

async function fetchPage() {
  console.log('\n=== Fetching charts.youtube.com homepage ===');
  const r = await fetch(`${BASE}/`, {
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  console.log(`Status: ${r.status}`);
  if (!r.ok) { console.log('Homepage fetch failed'); return { key: null, initialData: null }; }

  const html = await r.text();
  console.log(`HTML length: ${html.length}`);

  // Extract API key
  const keyMatch = html.match(/"key"\s*:\s*"(AIzaSy[A-Za-z0-9_\-]{30,})"/);
  const key = keyMatch?.[1] ?? null;
  console.log(`API key from page: ${key ?? '(not found, will use fallback)'}`);

  // Look for ytInitialData or similar
  const initMatch = html.match(/(?:ytInitialData|initialData)\s*=\s*(\{[\s\S]{0,500000}\});/);
  let initialData = null;
  if (initMatch) {
    try {
      initialData = JSON.parse(initMatch[1]);
      console.log(`Found initialData, top-level keys: ${Object.keys(initialData).join(', ')}`);
    } catch { console.log('Found initialData but failed to parse'); }
  } else {
    console.log('No ytInitialData/initialData found in page');
  }

  // Look for any JSON blobs
  const jsonBlobs = html.match(/window\["ytcfg"\]\.set\((\{[\s\S]{0,2000}\})\)/);
  if (jsonBlobs) {
    try {
      const cfg = JSON.parse(jsonBlobs[1]);
      console.log(`ytcfg keys: ${Object.keys(cfg).slice(0, 20).join(', ')}`);
      if (cfg.INNERTUBE_API_KEY) console.log(`INNERTUBE_API_KEY: ${cfg.INNERTUBE_API_KEY}`);
      if (cfg.INNERTUBE_CLIENT_NAME) console.log(`INNERTUBE_CLIENT_NAME: ${cfg.INNERTUBE_CLIENT_NAME}`);
      if (cfg.INNERTUBE_CLIENT_VERSION) console.log(`INNERTUBE_CLIENT_VERSION: ${cfg.INNERTUBE_CLIENT_VERSION}`);
    } catch {}
  }

  return { key, initialData };
}

async function browse(apiKey, gl, chartType = 'songs') {
  const url = `${BASE}/youtubei/v1/browse?alt=json&key=${apiKey}`;

  // browseId options to try:
  // 'FEmusic_top_charts'  -- main charts page (then tab-navigate)
  // 'FEmusic_trending'    -- trending
  // We'll start with the main charts page.
  const browseId = 'FEmusic_top_charts';

  const body = {
    browseId,
    context: {
      client: {
        clientName: 'WEB_MUSIC_ANALYTICS',
        clientVersion: '0.2',
        hl: 'en',
        gl: gl ?? 'US',
      },
    },
  };

  console.log(`\n=== Browse (gl=${gl ?? 'US'}, browseId=${browseId}) ===`);
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'Origin': BASE,
      'Referer': `${BASE}/`,
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-YouTube-Client-Name': '85',
      'X-YouTube-Client-Version': '0.2',
    },
    body: JSON.stringify(body),
  });
  console.log(`Status: ${r.status}`);
  if (!r.ok) {
    const errText = await r.text();
    console.log(`Error body: ${errText.slice(0, 500)}`);
    return null;
  }

  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { console.log(`Non-JSON response: ${text.slice(0, 300)}`); return null; }

  console.log(`\nTop-level keys: ${Object.keys(data).join(', ')}`);
  console.log(`\nStructural walk (first branch of each array):`);
  walk(data);

  // Try to find anything that looks like a ranked list
  const raw = JSON.stringify(data);
  console.log(`\nTotal response size: ${raw.length} chars`);

  // Look for chart entry patterns
  const rankPatterns = ['currentRank', 'rank', 'position', 'chartPosition'];
  for (const p of rankPatterns) {
    const count = (raw.match(new RegExp(`"${p}"`, 'g')) || []).length;
    if (count > 0) console.log(`  "${p}" appears ${count} time(s)`);
  }

  // Look for BLACKPINK/member names
  const names = ['BLACKPINK', 'JENNIE', 'JISOO', 'ROSÉ', 'LISA'];
  for (const name of names) {
    if (raw.includes(name)) console.log(`  ★ "${name}" found in response`);
  }

  // Look for videoId patterns
  const videoIds = raw.match(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g);
  if (videoIds) console.log(`  ${videoIds.length} videoId(s) in response (first 3: ${videoIds.slice(0, 3).join(', ')})`);

  // Show first 3000 chars of raw JSON for manual inspection
  console.log(`\nFirst 3000 chars of raw response:\n${raw.slice(0, 3000)}`);

  return data;
}

async function main() {
  // Step 1: get API key from page
  const { key: pageKey } = await fetchPage();
  const apiKey = pageKey ?? FALLBACK_KEY;
  console.log(`\nUsing API key: ${apiKey}`);

  // Step 2: probe browse endpoint for a handful of regions
  const regions = [
    { gl: null,  label: 'Global (no gl)' },
    { gl: 'US',  label: 'United States' },
    { gl: 'KR',  label: 'South Korea' },
    { gl: 'TW',  label: 'Taiwan' },
    { gl: 'SG',  label: 'Singapore' },
  ];

  for (const { gl, label } of regions) {
    await browse(apiKey, gl);
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 800));
  }

  console.log('\n=== Probe complete ===');
}

main().catch(e => { console.error(e); process.exit(1); });
