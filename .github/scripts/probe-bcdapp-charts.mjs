/**
 * One-off diagnostic: inspects b-cd.app (a reference fan-chart site with the
 * same Daily/Weekly Songs/Artists/Albums chart UI we're trying to build) to
 * find its real charts API endpoint and see what data/source it actually
 * returns, ahead of designing our own Charts feature.
 * Safe to remove once the Charts feature is built.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function tryFetch(url, opts = {}) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, ...opts });
    const text = await r.text();
    return { url, ok: r.ok, status: r.status, headers: Object.fromEntries(r.headers.entries()), length: text.length, text };
  } catch (e) {
    return { url, ok: false, error: e.message };
  }
}

function log(label, result) {
  console.log(`\n=== ${label} ===`);
  if (result.error) {
    console.log(`ERROR: ${result.error}`);
    return;
  }
  console.log(`status=${result.status} length=${result.length}`);
  console.log(`content-type=${result.headers['content-type']}`);
  console.log(result.text.slice(0, 3000));
}

async function main() {
  // 1. Fetch the page itself to see its HTML/embedded config (API base URL, etc.)
  const page = await tryFetch('https://b-cd.app/spotify/daily-top-songs');
  log('page HTML (first 3000 chars)', page);

  // Look for API base hints in the HTML (e.g. env vars baked into client bundle refs, or absolute API URLs).
  if (page.text) {
    const apiHints = [...new Set((page.text.match(/https?:\/\/[a-z0-9.-]+\/(api|charts)[^"'\s]*/gi) || []))];
    console.log('\n=== API URL hints found in HTML ===');
    console.log(apiHints.slice(0, 20));
  }

  // 2. Confirmed: root-level /charts and /api/charts 404 -- the chart data is NOT
  // a separate client-side fetch at all. Skip straight to inspecting the full RSC
  // payload (previous run showed status=200, content-type=text/x-component, and
  // the data is embedded directly in server-rendered props).
  const rsc = await tryFetch('https://b-cd.app/spotify/daily-top-songs', { headers: { 'User-Agent': UA, Accept: 'text/x-component', 'RSC': '1' } });
  console.log(`\n=== full RSC payload: status=${rsc.status} length=${rsc.length} ===`);
  if (rsc.text) {
    // Find and print the chunk(s) mentioning known song/chart keywords, to see how
    // the actual chart rows (position, streams, DoC, peak) are structured in the payload.
    const keywords = ['SWIM', 'streams', 'position', 'peak', 'daysOnChart', 'DoC', 'chartType', 'rank'];
    for (const kw of keywords) {
      const idx = rsc.text.indexOf(kw);
      console.log(`keyword "${kw}": ${idx === -1 ? 'not found' : `found at index ${idx}`}`);
    }
    // Print the largest JSON-looking segment -- RSC payloads are line-prefixed
    // (e.g. "8:[...]"), so split on newlines and show the longest few lines.
    const lines = rsc.text.split('\n');
    const longest = [...lines].sort((a, b) => b.length - a.length).slice(0, 3);
    console.log('\n--- 3 longest lines in RSC payload (likely the data-bearing ones) ---');
    for (const line of longest) console.log(line.slice(0, 4000));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
