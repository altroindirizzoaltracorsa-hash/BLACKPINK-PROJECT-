// One-off: the Global-K Chart page (Astro) loads rankings client-side. Find the
// JSON API it calls. Dump script srcs, astro-island props, and any URL/endpoint
// strings, then fetch the JS bundles and grep them for the data endpoint.
// Read-only. Delete after use.

const PAGE = 'https://www.melon.com/en/global-k-chart/?chartType=D';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

async function get(url, accept = 'text/html,*/*') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept': accept, 'Accept-Language': 'en,ko;q=0.9', 'Referer': 'https://www.melon.com/' },
      signal: ctrl.signal,
    });
    return { status: r.status, ct: r.headers.get('content-type') || '', url: r.url, body: await r.text() };
  } finally { clearTimeout(t); }
}

function uniq(a) { return [...new Set(a)]; }

async function main() {
  const page = await get(PAGE);
  console.log(`PAGE status=${page.status} ct=${page.ct} bytes=${page.body.length}`);
  const html = page.body;

  // 1) script + module srcs
  const srcs = uniq([...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(m => m[1]));
  console.log(`\n[scripts] ${srcs.length}`);
  srcs.forEach(s => console.log('   ' + s));

  // 2) astro-island tags (props may hold data or an endpoint)
  const islands = [...html.matchAll(/<astro-island[^>]*>/g)].map(m => m[0]);
  console.log(`\n[astro-islands] ${islands.length}`);
  islands.slice(0, 4).forEach(t => console.log('   ' + t.slice(0, 1200)));

  // 3) endpoint-looking strings in the HTML itself
  const urlRe = /https?:\/\/[^\s"'<>()]+|\/[a-z0-9._\-\/]*(?:api|chart|global|rank|json)[a-z0-9._\-\/?=&]*/gi;
  const hits = uniq((html.match(urlRe) || []).filter(u => /api|chart|global|rank|\.json/i.test(u)));
  console.log(`\n[endpoint-ish strings in HTML] ${hits.length}`);
  hits.slice(0, 40).forEach(u => console.log('   ' + u));

  // 4) fetch JS bundles and grep them for endpoints
  const jsUrls = srcs.map(s => s.startsWith('http') ? s : new URL(s, PAGE).href).filter(u => /\.m?js(\?|$)/.test(u));
  for (const ju of jsUrls.slice(0, 6)) {
    try {
      const js = await get(ju, '*/*');
      const eps = uniq((js.body.match(/["'`](\/[^"'`]*?(?:api|chart|rank|global)[^"'`]*|https?:\/\/[^"'`]*?(?:api|chart|rank|global)[^"'`]*)["'`]/gi) || [])
        .map(s => s.replace(/^["'`]|["'`]$/g, '')));
      console.log(`\n[bundle ${ju.split('/').pop()}] status=${js.status} bytes=${js.body.length} endpoints=${eps.length}`);
      eps.slice(0, 30).forEach(e => console.log('   ' + e));
    } catch (e) {
      console.log(`\n[bundle ${ju}] ERROR ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 400));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
