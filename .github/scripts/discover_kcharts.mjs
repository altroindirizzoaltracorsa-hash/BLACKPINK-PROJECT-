// One-off: discover every chart path the 가이섬 aggregator exposes, so we can find
// charts we don't yet track (e.g. Melon's Global Top 100 K-Pop chart). Read-only.
// Fetches the homepage + each service landing page, extracts /chart/... links and
// their menu labels, and prints them grouped by service. Delete after use.

const BASE = 'https://xn--o39an51b2re.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en;q=0.9' }, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

// Pull every /chart/<service>/<name> path out of the raw HTML/JSON, with any
// anchor text we can associate. Returns Map path -> Set(labels).
function extractPaths(html) {
  const found = new Map();
  const add = (p, label) => {
    p = p.replace(/["'\\].*$/, '');
    if (!/^\/chart\/[a-z0-9-]+\/[a-z0-9-]+$/i.test(p)) return;
    if (!found.has(p)) found.set(p, new Set());
    if (label) found.get(p).add(label.trim());
  };
  // anchors with visible text
  const aRe = /<a[^>]+href=["'](\/chart\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = aRe.exec(html))) add(m[1], m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
  // bare occurrences anywhere (hrefs without text, or embedded in __NEXT_DATA__)
  const pRe = /\/chart\/[a-z0-9-]+\/[a-z0-9-]+/gi;
  while ((m = pRe.exec(html))) add(m[0], '');
  return found;
}

async function main() {
  const all = new Map();
  const seed = ['/', '/chart/melon/top100', '/chart/melon/realtime'];
  for (const s of seed) {
    try {
      const html = await fetchHtml(BASE + s);
      const paths = extractPaths(html);
      for (const [p, labels] of paths) {
        if (!all.has(p)) all.set(p, new Set());
        for (const l of labels) all.get(p).add(l);
      }
      console.log(`# scanned ${s}: found ${paths.size} chart paths`);
    } catch (e) {
      console.log(`# ${s} -> ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 400));
  }

  // group by service
  const byService = new Map();
  for (const [p, labels] of [...all].sort()) {
    const svc = p.split('/')[2];
    if (!byService.has(svc)) byService.set(svc, []);
    byService.get(svc).push([p, [...labels].filter(Boolean).join(' | ')]);
  }
  console.log(`\n=== ${all.size} distinct chart paths across ${byService.size} services ===\n`);
  for (const [svc, rows] of [...byService].sort()) {
    console.log(`## ${svc}`);
    for (const [p, label] of rows) console.log(`   ${p}${label ? '   « ' + label + ' »' : ''}`);
    console.log();
  }
  // highlight anything global/kpop
  const hot = [...all.keys()].filter(p => /global|kpop|k-pop|케이팝|글로벌/i.test(p));
  console.log('=== candidates matching global/kpop in the PATH ===');
  console.log(hot.length ? hot.join('\n') : '   (none — the global chart may live under a non-obvious path; check labels above)');
}

main().catch(e => { console.error(e); process.exit(1); });
