// One-off: find the JSON API the Global-K Chart Preact islands call. BFS the
// island component bundles + their imported chunks (one-ish level), grep every
// JS for endpoint-looking strings and `fetch(` / chartType context. Read-only.

const PAGE = 'https://www.melon.com/en/global-k-chart/?chartType=D';
const ORIGIN = 'https://www.melon.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

async function get(url, accept = '*/*') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA, 'Accept': accept, 'Referer': PAGE }, signal: ctrl.signal });
    return { status: r.status, body: await r.text() };
  } finally { clearTimeout(t); } }

const uniq = a => [...new Set(a)];
const abs = u => (u.startsWith('http') ? u : new URL(u, ORIGIN).href);

function jsChunkRefs(js) {
  // import "..."; from "..."; import("..."); plus any "/fe-public/....js" literal
  const refs = [];
  for (const m of js.matchAll(/(?:from|import)\s*\(?\s*["'`](\/[^"'`]+?\.m?js)["'`]/g)) refs.push(m[1]);
  for (const m of js.matchAll(/["'`](\/fe-public\/[^"'`]+?\.m?js)["'`]/g)) refs.push(m[1]);
  return uniq(refs);
}

function endpoints(js) {
  const out = [];
  for (const m of js.matchAll(/["'`](https?:\/\/[^"'`]+|\/[a-z0-9._\-\/]*(?:api|chart|rank|global|globalk|list|data|v[0-9])[a-z0-9._\-\/]*)["'`]/gi)) {
    const s = m[1];
    if (/\.(png|jpe?g|svg|gif|webp|css|ico|woff2?)$/i.test(s)) continue;
    if (/googletag|kakao|facebook|twitter|m2\.melon\.com\/fe-public\/images/i.test(s)) continue;
    out.push(s);
  }
  return uniq(out);
}

async function main() {
  const page = await get(PAGE, 'text/html');
  const html = page.body;
  const seeds = uniq([
    ...[...html.matchAll(/component-url=["']([^"']+)["']/g)].map(m => m[1]),
    ...[...html.matchAll(/renderer-url=["']([^"']+)["']/g)].map(m => m[1]),
    ...[...html.matchAll(/<script[^>]+src=["'](\/fe-public\/[^"']+)["']/g)].map(m => m[1]),
  ]).map(abs);

  console.log(`seeds (${seeds.length}):`); seeds.forEach(s => console.log('  ' + s));

  const seen = new Set(), queue = [...seeds];
  const allEndpoints = new Set();
  let fetched = 0;
  while (queue.length && fetched < 40) {
    const url = queue.shift();
    if (seen.has(url)) continue; seen.add(url);
    let js;
    try { js = await get(url); } catch (e) { console.log(`  ! ${url} ${e.message}`); continue; }
    if (js.status !== 200) { console.log(`  ! ${url} status ${js.status}`); continue; }
    fetched++;
    const eps = endpoints(js.body);
    eps.forEach(e => allEndpoints.add(e));
    // context around chartType / fetch
    const ctx = [];
    for (const m of js.body.matchAll(/.{0,60}chartType.{0,80}/g)) ctx.push(m[0]);
    if (eps.length || ctx.length) {
      console.log(`\n[${url.split('/').pop()}] bytes=${js.body.length}`);
      eps.forEach(e => console.log('   ep: ' + e));
      uniq(ctx).slice(0, 3).forEach(c => console.log('   ctx: ' + c.replace(/\s+/g, ' ')));
    }
    for (const ref of jsChunkRefs(js.body)) { const a = abs(ref); if (!seen.has(a)) queue.push(a); }
    await new Promise(r => setTimeout(r, 250));
  }

  console.log(`\n==== fetched ${fetched} JS files ====`);
  console.log(`\nALL endpoint-ish strings:`);
  [...allEndpoints].sort().forEach(e => console.log('   ' + e));
}
main().catch(e => { console.error(e); process.exit(1); });
