/**
 * One-off diagnostic: hits b-cd.app's real charts API (found via user-supplied
 * devtools inspection: https://api.b-cd.app/api/spotify/charts?chart_type=...)
 * to see its response shape and, most importantly, what upstream source note
 * (if any) it exposes -- ahead of designing our own Charts feature.
 * Safe to remove once the Charts feature is built.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function tryFetch(url, opts = {}) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json,*/*' }, ...opts });
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
  console.log(`access-control-allow-origin=${result.headers['access-control-allow-origin']}`);
  console.log(result.text.slice(0, 6000));
}

async function main() {
  const base = 'https://api.b-cd.app/api/spotify/charts';

  const r1 = await tryFetch(`${base}?chart_type=daily-songs&limit=10&bts=true&country=GLOBAL`);
  log('daily-songs, GLOBAL, limit=10', r1);

  const r2 = await tryFetch(`${base}?chart_type=daily-songs&limit=200&bts=false&country=GLOBAL`);
  log('daily-songs, GLOBAL, limit=200, bts=false', r2);

  const r3 = await tryFetch(`${base}?chart_type=daily-artists&limit=10&bts=true&country=GLOBAL`);
  log('daily-artists, GLOBAL, limit=10', r3);

  const r4 = await tryFetch(`${base}?chart_type=weekly-songs&limit=10&bts=true&country=GLOBAL`);
  log('weekly-songs, GLOBAL, limit=10', r4);

  // Try a non-existent/malformed request to see if error responses leak useful info
  // (e.g. an upstream source name, or validation messages revealing the schema).
  const r5 = await tryFetch(`${base}`);
  log('no query params at all', r5);
}

main().catch(e => { console.error(e); process.exit(1); });
