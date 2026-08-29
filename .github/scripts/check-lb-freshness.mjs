/*
 * Read-only: is the community leaderboard actually updating? Hits the public
 * leaderboard GET and reports how stale it is plus the community daily/overall
 * totals per track, so we can tell "extension is writing but the board froze"
 * apart from "everything's fine".
 */
const BASE = process.env.LB_BASE || 'https://blinksunited.com';
const TIDS = ['jump', 'shutdown', 'ddududu', 'go', 'ltal', 'fallenangel', 'heaven'];

function communityTotal(users, key) {
  const secondary = new Set();
  for (const [k, d] of Object.entries(users)) {
    for (const a of (d.linkedAccounts || [])) {
      const ak = (a.username || '').toLowerCase();
      if (ak && ak !== k.toLowerCase()) secondary.add(ak);
    }
  }
  let sum = 0;
  for (const [k, d] of Object.entries(users)) {
    if (secondary.has(k.toLowerCase())) continue;
    sum += (d.scores?.[key] || 0);
  }
  return sum;
}

(async () => {
  const r = await fetch(`${BASE}/api/leaderboard`, { headers: { 'User-Agent': 'gh-lb-freshness' } });
  if (!r.ok) { console.error(`HTTP ${r.status}: ${await r.text()}`); process.exit(1); }
  const d = await r.json();
  const users = d.users || {};
  const now = Date.now();
  const upd = d.lastUpdated ? Date.parse(d.lastUpdated) : null;

  console.log('Leaderboard freshness\n');
  console.log(`  lastUpdated   : ${d.lastUpdated || '(none)'}` + (upd ? `  (${Math.round((now - upd) / 60000)} min ago)` : ''));
  console.log(`  users on board: ${Object.keys(users).length}`);
  console.log(`  currentDayLabel : ${d.currentDayLabel || '(none)'}`);
  console.log(`  _faepSnap       : ${JSON.stringify(d._faepSnap || null)}`);

  console.log('\n  track        daily (today)   overall (all-time)');
  for (const t of TIDS) {
    const day = communityTotal(users, `daily_${t}`);
    const all = communityTotal(users, `overall_${t}`);
    console.log(`  ${t.padEnd(12)} ${String(day.toLocaleString()).padEnd(15)} ${all.toLocaleString()}`);
  }
  const dayAll = TIDS.reduce((a, t) => a + communityTotal(users, `daily_${t}`), 0);
  console.log(`\n  community daily total (7 tracks): ${dayAll.toLocaleString()}`);
})();
