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

  // 2. Try the charts endpoint under several plausible base paths -- the page that
  // made this request lives at /spotify/daily-top-songs, and the observed devtools
  // request was a *relative* URL ("charts?chart_type=..."), which resolves against
  // the current path's directory, not the site root. Root-level /charts 404'd.
  const chartTypes = ['daily-songs', 'daily-artists', 'weekly-songs', 'weekly-artists', 'weekly-albums'];
  const basePaths = [
    '/spotify/charts',
    '/spotify/daily-top-songs/charts',
    '/api/spotify/charts',
    '/api/charts',
  ];
  for (const base of basePaths) {
    for (const ct of chartTypes.slice(0, 2)) { // just probe 2 types per base path to keep this short
      const r = await tryFetch(`https://b-cd.app${base}?chart_type=${ct}&limit=10`);
      log(`${base}?chart_type=${ct}&limit=10`, r);
    }
  }

  // 3. Fetch the actual page's Next.js RSC payload (the ?_rsc= requests seen in
  // devtools) to see if the chart data is embedded directly in server-rendered
  // props rather than fetched client-side at all.
  const rsc = await tryFetch('https://b-cd.app/spotify/daily-top-songs', { headers: { 'User-Agent': UA, Accept: 'text/x-component', 'RSC': '1' } });
  log('page as RSC payload (Accept: text/x-component, RSC:1)', rsc);
}

main().catch(e => { console.error(e); process.exit(1); });
