// One-off: deep-dive the Global-K Chart data bundle to extract the exact request
// URL/base for the ranking API. Read-only. Delete after use.

const BUNDLE = 'https://www.melon.com/fe-public/index2.BOB-slyW.js';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

async function get(url) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 25000);
  try { const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://www.melon.com/en/global-k-chart/' }, signal: ctrl.signal }); return { status: r.status, body: await r.text() }; }
  finally { clearTimeout(t); } }

const uniq = a => [...new Set(a)];
function ctxAll(s, re, before = 80, after = 160, cap = 12) {
  const out = []; let m;
  const g = new RegExp(re, 'g');
  while ((m = g.exec(s)) && out.length < cap) out.push(s.slice(Math.max(0, m.index - before), m.index + after).replace(/\s+/g, ' '));
  return uniq(out);
}

async function main() {
  const js = (await get(BUNDLE)).body;
  console.log(`bundle bytes=${js.length}\n`);

  console.log('== all "/global-k-chart..." path literals ==');
  uniq((js.match(/["'`](\/[a-z0-9\-\/{}$:._]*global-k-chart[a-z0-9\-\/{}$:._]*)["'`]/gi) || []).map(x => x.replace(/^["'`]|["'`]$/g, ''))).forEach(p => console.log('   ' + p));
  uniq((js.match(/global-k-chart[a-z0-9\-\/]*/gi) || [])).forEach(p => console.log('   ~ ' + p));

  console.log('\n== axios/base config ==');
  ctxAll(js, /baseURL|axios|\.create\(|create\(\{|apiBase|BASE_URL|import\.meta\.env/i).forEach(c => console.log('   ' + c));

  console.log('\n== request calls (.get/.post/fetch/request) with a url ==');
  ctxAll(js, /\.(get|post|request)\(`|\.(get|post|request)\(["'`]\/|fetch\(`|fetch\(["']\//i, 60, 180).forEach(c => console.log('   ' + c));

  console.log('\n== the chart fetcher (gr / globalKChart) body ==');
  ctxAll(js, /globalKChart(?!Expand)/, 20, 420, 4).forEach(c => console.log('   ' + c));

  console.log('\n== template-literal URLs (`...${...}...`) mentioning chart/global/api ==');
  uniq((js.match(/`[^`]*(?:chart|global|api|melon\.com)[^`]*`/gi) || []).filter(x => x.includes('/') && x.length < 200)).slice(0, 25).forEach(u => console.log('   ' + u));
}
main().catch(e => { console.error(e); process.exit(1); });
