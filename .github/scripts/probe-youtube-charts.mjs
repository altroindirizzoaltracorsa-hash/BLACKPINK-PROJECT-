/**
 * Probe v2: round 1 got 400 on every charts.youtube.com/youtubei call,
 * and the API key wasn't in the page HTML (it's in the JS bundles).
 *
 * This version:
 * 1. Downloads the JS bundles from charts.youtube.com to extract the real
 *    API key, client name/version, and any browseId references.
 * 2. Tries the YouTube Music API (music.youtube.com/youtubei/v1/browse)
 *    with the WEB_REMIX client -- this is the better-documented path that
 *    powers the music.youtube.com/charts page.
 * 3. Tries charts.youtube.com with multiple browseId candidates and the
 *    extracted (or fallback) key.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ── helpers ───────────────────────────────────────────────────────────────

function snip(text, max = 300) { return text.length > max ? text.slice(0, max) + '…' : text; }

function printShape(obj, indent = 0) {
  const pad = '  '.repeat(indent);
  if (Array.isArray(obj)) {
    console.log(`${pad}Array[${obj.length}]`);
    if (obj.length) printShape(obj[0], indent + 1);
    return;
  }
  if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj);
    console.log(`${pad}Object { ${keys.slice(0, 10).join(', ')}${keys.length > 10 ? ` … +${keys.length - 10}` : ''} }`);
    if (indent < 3) for (const k of keys.slice(0, 5)) printShape(obj[k], indent + 1);
    return;
  }
  const s = String(obj);
  console.log(`${pad}${s.length > 80 ? s.slice(0, 80) + '…' : s}`);
}

// ── Step 1: scrape JS bundles from charts.youtube.com ─────────────────────

async function extractFromBundles() {
  console.log('\n=== Step 1: extract API config from charts.youtube.com JS bundles ===');
  const pageRes = await fetch('https://charts.youtube.com/', {
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const html = await pageRes.text();
  console.log(`Homepage status: ${pageRes.status}, length: ${html.length}`);
  console.log('First 800 chars:', snip(html, 800));

  // Find all script src URLs
  const scriptSrcs = [...html.matchAll(/src="([^"]+\.js[^"]*)"/g)].map(m => m[1]);
  console.log(`\nScript src URLs (${scriptSrcs.length}):`, scriptSrcs.slice(0, 10));

  // Resolve relative URLs
  const base = 'https://charts.youtube.com';
  const resolved = scriptSrcs.map(s => s.startsWith('http') ? s : `${base}${s}`);

  const found = { apiKey: null, clientName: null, clientVersion: null, browseIds: new Set() };

  for (const src of resolved.slice(0, 8)) { // check up to 8 bundles
    try {
      const r = await fetch(src, { headers: { 'User-Agent': UA, Referer: base + '/' } });
      if (!r.ok) { console.log(`  ${src} -> ${r.status}`); continue; }
      const js = await r.text();
      console.log(`\n  Bundle: ${src.slice(0, 80)} (${js.length} chars)`);

      // Look for API key
      const keyMatches = [...js.matchAll(/["']?(INNERTUBE_API_KEY|key)["']?\s*[=:]\s*["']?(AIzaSy[A-Za-z0-9_\-]{30,})["']?/g)];
      for (const m of keyMatches) { console.log(`    API key candidate: ${m[2]}`); found.apiKey = m[2]; }

      // Look for client name
      const nameMatches = [...js.matchAll(/["']?clientName["']?\s*[=:]\s*["']([A-Z_]+)["']/g)];
      for (const m of nameMatches.slice(0, 3)) { console.log(`    clientName: ${m[1]}`); found.clientName = m[1]; }

      // Look for client version
      const verMatches = [...js.matchAll(/["']?clientVersion["']?\s*[=:]\s*["']([0-9.]+)["']/g)];
      for (const m of verMatches.slice(0, 3)) { console.log(`    clientVersion: ${m[1]}`); found.clientVersion = m[1]; }

      // Look for browseId values
      const browseMatches = [...js.matchAll(/browseId["']?\s*[=:]\s*["'](FE[A-Za-z_]+)["']/g)];
      for (const m of browseMatches) { found.browseIds.add(m[1]); }
      if (browseMatches.length) console.log(`    browseIds found: ${browseMatches.map(m => m[1]).join(', ')}`);

      // Look for "charts" related strings
      const chartRefs = [...js.matchAll(/"(FE[a-zA-Z_]*chart[a-zA-Z_]*)"/gi)].map(m => m[1]);
      if (chartRefs.length) console.log(`    chart-related IDs: ${[...new Set(chartRefs)].join(', ')}`);

      // Look for youtubei endpoint paths
      const endpoints = [...js.matchAll(/["'](\/youtubei\/v1\/[a-zA-Z/]+)["']/g)].map(m => m[1]);
      if (endpoints.length) console.log(`    youtubei paths: ${[...new Set(endpoints)].slice(0, 5).join(', ')}`);

    } catch (e) { console.log(`  ${src}: ${e.message}`); }
  }

  console.log('\nExtracted config:', { ...found, browseIds: [...found.browseIds] });
  return found;
}

// ── Step 2: try YouTube Music (music.youtube.com) API ─────────────────────

async function tryYtMusic(country = 'US') {
  // YouTube Music's charts page lives at music.youtube.com/charts
  // The API uses the WEB_REMIX client which is well-documented.
  const endpoint = 'https://music.youtube.com/youtubei/v1/browse';
  const clientVersion = '1.20240724.00.00';

  // browseId candidates for YT Music charts
  const candidates = [
    'FEmusic_charts',
    'FEmusic_trending',
    'FEmusic_top_charts',
  ];

  console.log(`\n=== Step 2: music.youtube.com (WEB_REMIX, gl=${country}) ===`);

  for (const browseId of candidates) {
    const body = {
      browseId,
      context: {
        client: {
          clientName: 'WEB_REMIX',
          clientVersion,
          hl: 'en',
          gl: country,
          userAgent: UA,
        },
      },
    };

    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': UA,
        'Origin': 'https://music.youtube.com',
        'Referer': 'https://music.youtube.com/',
        'X-YouTube-Client-Name': '67',
        'X-YouTube-Client-Version': clientVersion,
      },
      body: JSON.stringify(body),
    });

    console.log(`  [${browseId}] status: ${r.status}`);
    if (r.ok) {
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { console.log('  non-JSON:', snip(text)); continue; }
      console.log('  Shape:'); printShape(data);
      const raw = JSON.stringify(data);
      console.log(`  Total size: ${raw.length}`);
      for (const n of ['BLACKPINK','JENNIE','JISOO','ROSÉ','ROSA','LISA']) {
        if (raw.includes(n)) console.log(`  ★ "${n}" found!`);
      }
      const videoIds = (raw.match(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g) || []);
      console.log(`  videoId count: ${videoIds.length}`);
      console.log('  First 2000 chars:', snip(raw, 2000));
      return data;
    } else {
      const err = await r.text();
      console.log('  Error:', snip(err, 200));
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return null;
}

// ── Step 3: retry charts.youtube.com with extracted key + more browseIds ──

async function tryChartsYt(apiKey, country = 'US') {
  const base = 'https://charts.youtube.com';
  const candidates = [
    'FEmusic_top_charts',
    'FEmusic_charts',
    'FEtop_charts',
    'FEmusic_trending',
    'FEmusic_top_charts_artworks',
  ];

  // Try to find the real key from page JS if not passed in
  const key = apiKey || 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-NKNELL6Cs';

  console.log(`\n=== Step 3: charts.youtube.com browse (key=${key.slice(0,20)}…, gl=${country}) ===`);

  for (const browseId of candidates) {
    const url = `${base}/youtubei/v1/browse?alt=json&key=${key}`;
    const body = {
      browseId,
      context: {
        client: {
          clientName: 'WEB_MUSIC_ANALYTICS',
          clientVersion: '0.2',
          hl: 'en',
          gl: country,
        },
      },
    };

    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': UA,
        'Origin': base,
        'Referer': base + '/',
      },
      body: JSON.stringify(body),
    });

    console.log(`  [${browseId}] status: ${r.status}`);
    if (r.ok) {
      const data = await r.json();
      console.log('  Shape:'); printShape(data);
      console.log('  First 2000 chars:', snip(JSON.stringify(data), 2000));
      return data;
    } else {
      console.log('  Error:', snip(await r.text(), 150));
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return null;
}

// ── main ──────────────────────────────────────────────────────────────────

async function main() {
  const config = await extractFromBundles();
  const ytMusicResult = await tryYtMusic('US');
  if (!ytMusicResult) await tryYtMusic('KR');
  await tryChartsYt(config.apiKey, 'US');
  console.log('\n=== Probe v2 complete ===');
}

main().catch(e => { console.error(e); process.exit(1); });
