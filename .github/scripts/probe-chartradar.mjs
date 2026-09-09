/**
 * probe-chartradar.mjs
 *
 * Probes chartradar.app to discover their API endpoints for Apple Music
 * global chart data. Steps:
 *  1. Fetch the HTML, extract JS bundle URLs
 *  2. Scan bundle JS for fetch/API calls and URL patterns
 *  3. Try discovered endpoints for Apple Music global chart
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BASE = 'https://www.chartradar.app';

async function get(url, label = url) {
  console.log(`\nFetching: ${url}`);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': BASE,
      },
    });
    console.log(`  → HTTP ${r.status} ${r.statusText}`);
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, text: await r.text(), ct };
  } catch (e) {
    console.log(`  → Error: ${e.message}`);
    return null;
  }
}

function extractScriptSrcs(html) {
  const srcs = [];
  const re = /<script[^>]+src=["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(html))) srcs.push(m[1]);
  return srcs;
}

function extractApiPatterns(js) {
  const patterns = new Set();

  // fetch("...") or fetch('...')
  const fetchRe = /fetch\s*\(\s*[`"']([^`"']+)[`"']/g;
  let m;
  while ((m = fetchRe.exec(js))) patterns.add(m[1]);

  // axios.get/post("...")
  const axiosRe = /axios\.[a-z]+\s*\(\s*[`"']([^`"']+)[`"']/g;
  while ((m = axiosRe.exec(js))) patterns.add(m[1]);

  // "https://..." or "/api/..." strings
  const urlRe = /[`"'](https?:\/\/[^`"'\s]+|\/api\/[^`"'\s]+|\/v\d+\/[^`"'\s]+)[`"']/g;
  while ((m = urlRe.exec(js))) patterns.add(m[1]);

  // Template literals with API-looking paths
  const tmplRe = /`([^`]*(?:api|chart|music|song|track)[^`]*)`/gi;
  while ((m = tmplRe.exec(js))) {
    if (m[1].length < 200) patterns.add(m[1].trim());
  }

  return [...patterns];
}

async function probeEndpoint(url) {
  console.log(`\nProbing: ${url}`);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, */*',
        'Referer': BASE,
        'Origin': BASE,
      },
    });
    console.log(`  → HTTP ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    const text = await r.text();
    if (r.ok && (ct.includes('json') || text.trim().startsWith('{'))) {
      console.log(`  → JSON response (${text.length} chars)`);
      console.log(`  → First 500 chars: ${text.slice(0, 500)}`);
    } else {
      console.log(`  → Content-Type: ${ct}, body starts: ${text.slice(0, 100)}`);
    }
  } catch (e) {
    console.log(`  → Error: ${e.message}`);
  }
}

async function main() {
  console.log('=== ChartRadar.app Probe ===\n');

  // 1. Fetch the Apple Music global charts page specifically
  const page = await get(`${BASE}/charts/global/apple-music`, 'charts page');
  if (!page) {
    console.log('Could not fetch main page');
    // Try common API patterns directly anyway
  }

  const html = page?.text ?? '';
  console.log(`\n--- HTML snippet (first 2000 chars) ---`);
  console.log(html.slice(0, 2000));

  // 2. Extract script URLs
  const rawSrcs = extractScriptSrcs(html);
  console.log(`\n--- Script tags found: ${rawSrcs.length} ---`);
  rawSrcs.forEach(s => console.log(`  ${s}`));

  const scriptUrls = rawSrcs.map(s => s.startsWith('http') ? s : `${BASE}${s}`);

  // 3. Scan JS bundles for API patterns
  const allPatterns = new Set();
  for (const url of scriptUrls.slice(0, 8)) { // limit to first 8 bundles
    const res = await get(url);
    if (!res) continue;
    const patterns = extractApiPatterns(res.text);
    console.log(`\n  Found ${patterns.length} patterns in ${url}`);
    patterns
      .filter(p => p.includes('api') || p.includes('chart') || p.includes('music') || p.includes('apple') || p.startsWith('http'))
      .slice(0, 30)
      .forEach(p => { console.log(`    ${p}`); allPatterns.add(p); });
  }

  // 4. Also check next.js data / nuxt / common SPA data endpoints
  console.log('\n--- Trying common SPA data endpoints ---');
  const commonEndpoints = [
    `${BASE}/_next/data/`,
    `${BASE}/api/charts/global/apple-music`,
    `${BASE}/api/charts/apple-music`,
    `${BASE}/api/apple-music/global`,
    `${BASE}/api/v1/charts/global`,
    `${BASE}/api/v2/charts/global`,
    `${BASE}/api/charts`,
  ];
  for (const ep of commonEndpoints) await probeEndpoint(ep);

  // 5. Check page source for __NEXT_DATA__ or similar
  if (html) {
    const nextData = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextData) {
      console.log('\n--- __NEXT_DATA__ found ---');
      try {
        const data = JSON.parse(nextData[1]);
        console.log(JSON.stringify(data, null, 2).slice(0, 3000));
      } catch { console.log(nextData[1].slice(0, 2000)); }
    } else {
      console.log('\n--- No __NEXT_DATA__ found ---');
    }

    // Check for Nuxt / other framework data
    const nuxtData = html.match(/window\.__NUXT__\s*=\s*([\s\S]*?)<\/script>/);
    if (nuxtData) {
      console.log('\n--- __NUXT__ data found ---');
      console.log(nuxtData[1].slice(0, 2000));
    }
  }

  console.log('\n=== Done ===');
}

main().catch(e => { console.error(e); process.exit(1); });
