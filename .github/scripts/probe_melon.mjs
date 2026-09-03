// One-off: hit the Global-K Chart JSON endpoint directly, confirm it's fetchable
// from CI, and dump its structure + any BLACKPINK/member entries. Read-only.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const CANDIDATES = [
  'https://www.melon.com/m6/chart/globalk.json?chartType=D',
  'https://m2.melon.com/m6/chart/globalk.json?chartType=D',
  'https://www.melon.com/m6/chart/globalk.json?chartType=W',
];
const MEMBER_RE = /BLACKPINK|블랙핑크|JISOO|지수|JENNIE|제니|ROS[EÉ]|로제|LISA|리사/i;

async function get(url) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json,*/*', 'Referer': 'https://www.melon.com/en/global-k-chart/' }, signal: ctrl.signal });
    return { status: r.status, ct: r.headers.get('content-type') || '', body: await r.text() };
  } finally { clearTimeout(t); } }

// find the array of chart rows anywhere in the object
function findRows(o) {
  if (Array.isArray(o)) {
    if (o.length && o[0] && typeof o[0] === 'object' && ('ARTISTID' in o[0] || 'RANK' in o[0] || 'ARTISTNAME' in o[0] || 'artistId' in o[0])) return o;
    for (const v of o) { const r = findRows(v); if (r) return r; }
    return null;
  }
  if (o && typeof o === 'object') for (const v of Object.values(o)) { const r = findRows(v); if (r) return r; }
  return null;
}

async function main() {
  for (const url of CANDIDATES) {
    let res;
    try { res = await get(url); } catch (e) { console.log(`\n=== ${url}\n  ERROR ${e.message}`); continue; }
    console.log(`\n=== ${url}\n  status=${res.status} ct=${res.ct} bytes=${res.body.length}`);
    if (res.status !== 200) { console.log('  body: ' + res.body.slice(0, 200).replace(/\s+/g, ' ')); continue; }
    let data;
    try { data = JSON.parse(res.body); } catch { console.log('  not JSON. head: ' + res.body.slice(0, 200).replace(/\s+/g, ' ')); continue; }
    console.log('  top-level keys: ' + JSON.stringify(Object.keys(data)));
    const rows = findRows(data);
    console.log('  rows found: ' + (rows ? rows.length : 'none'));
    if (rows && rows.length) {
      console.log('  first row keys: ' + JSON.stringify(Object.keys(rows[0])));
      console.log('  first row: ' + JSON.stringify(rows[0]).slice(0, 700));
      const bp = rows.filter(r => MEMBER_RE.test(JSON.stringify(r)));
      console.log(`  BLACKPINK/member rows: ${bp.length}`);
      bp.slice(0, 8).forEach(r => console.log('     ' + JSON.stringify(r).slice(0, 300)));
    } else {
      console.log('  raw head: ' + res.body.slice(0, 600).replace(/\s+/g, ' '));
    }
    await new Promise(r => setTimeout(r, 400));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
