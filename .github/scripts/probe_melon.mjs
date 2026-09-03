// One-off feasibility probe: can we fetch Melon's Global K-Chart from CI, and how
// is it structured? Prints status, size, block-page signals, member-name hits,
// and a markup snippet around the first chart row so we can design a parser.
// Read-only. Delete after use.

const URLS = [
  'https://www.melon.com/en/global-k-chart/?chartType=D',
  'https://www.melon.com/en/global-k-chart/?chartType=W',
  'https://www.melon.com/en/global-k-chart/index.htm?chartType=D',
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const MEMBERS = ['BLACKPINK', 'JISOO', 'JENNIE', 'ROSE', 'ROSÉ', 'LISA'];

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en,ko;q=0.9',
        'Referer': 'https://www.melon.com/',
      },
      signal: ctrl.signal,
    });
    const body = await r.text();
    return { status: r.status, finalUrl: r.url, body };
  } finally { clearTimeout(t); }
}

function analyze(url, res) {
  console.log(`\n===== ${url}`);
  console.log(`status=${res.status}  finalUrl=${res.finalUrl}  bytes=${res.body.length}`);
  const b = res.body;
  const low = b.toLowerCase();
  // block/captcha signals
  for (const sig of ['captcha', 'access denied', 'blocked', 'forbidden', '비정상', '자동', 'robot']) {
    if (low.includes(sig)) console.log(`  ⚠ contains "${sig}"`);
  }
  // structure hints
  console.log(`  <tr occurrences: ${(b.match(/<tr[\s>]/g) || []).length}`);
  console.log(`  rank-class hits: ${(b.match(/class="[^"]*rank[^"]*"/g) || []).length}`);
  console.log(`  __NEXT_DATA__: ${b.includes('__NEXT_DATA__')}   <table: ${(b.match(/<table/g) || []).length}`);
  for (const m of MEMBERS) {
    const n = (b.match(new RegExp(m, 'gi')) || []).length;
    if (n) console.log(`  member "${m}": ${n} hits`);
  }
  // snippet around first member hit
  let idx = -1, who = '';
  for (const m of MEMBERS) { const i = low.indexOf(m.toLowerCase()); if (i >= 0 && (idx < 0 || i < idx)) { idx = i; who = m; } }
  if (idx >= 0) {
    console.log(`  --- markup around first "${who}" (idx ${idx}) ---`);
    console.log(b.slice(Math.max(0, idx - 1400), idx + 400).replace(/\s+/g, ' '));
  } else {
    console.log('  (no member names found — dumping first 800 chars)');
    console.log(b.slice(0, 800).replace(/\s+/g, ' '));
  }
}

async function main() {
  for (const u of URLS) {
    try { analyze(u, await fetchText(u)); }
    catch (e) { console.log(`\n===== ${u}\n  FETCH ERROR: ${e.message}`); }
    await new Promise(r => setTimeout(r, 600));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
