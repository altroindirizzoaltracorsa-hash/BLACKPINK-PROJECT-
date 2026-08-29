/*
 * Read-only per-user diagnostic. For USERNAME:
 *   1. resolve appUserId via the ext-week admin endpoint
 *   2. pull that profile's leaderboard scores + linkedAccounts
 *   3. group their extension_scrobbles by spotify_account — count, per-track,
 *      latest listen — so we can see which of their many accounts are actually
 *      attributed and writing, vs silently dropping off their profile
 *
 * Needs ADMIN_KEY + SUPABASE_URL + SUPABASE_SERVICE_KEY.
 */
const BASE  = process.env.LB_BASE || 'https://blinksunited.com';
const ADMIN = process.env.ADMIN_KEY;
const URL   = process.env.SUPABASE_URL;
const KEY   = process.env.SUPABASE_SERVICE_KEY;
const USER  = process.env.USERNAME;
if (!ADMIN || !URL || !KEY || !USER) { console.error('Missing ADMIN_KEY / SUPABASE_* / USERNAME'); process.exit(1); }

const TIDS = ['jump','shutdown','ddududu','go','ltal','fallenangel','heaven'];
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok && r.status !== 206) { console.error(`HTTP ${r.status} for ${url.split('?')[0]}: ${await r.text()}`); process.exit(1); }
  return r.json();
}

async function extRows(appUserId) {
  const rows = [];
  const LIMIT = 1000;
  for (let off = 0; off < 100000; off += LIMIT) {
    const qs = `select=spotify_account,track_id,listened_at&app_user_id=eq.${encodeURIComponent(appUserId)}&order=listened_at.desc`;
    const batch = await getJSON(`${URL}/rest/v1/extension_scrobbles?${qs}`, { headers: { ...H, Range: `${off}-${off + LIMIT - 1}` } });
    rows.push(...batch);
    if (batch.length < LIMIT) break;
  }
  return rows;
}

(async () => {
  console.log(`Per-user scrobble diagnostic — ${USER}\n`);

  // 1. appUserId via ext-week
  const ew = await getJSON(`${BASE}/api/leaderboard?action=ext-week&key=${encodeURIComponent(ADMIN)}&user=${encodeURIComponent(USER)}`);
  const appUserId = ew.appUserId;
  console.log(`  appUserId: ${appUserId || '(NOT RESOLVED — username not linked to a profile?)'}`);
  if (!appUserId) return;

  // 2. leaderboard scores + linked accounts
  const lb = await getJSON(`${BASE}/api/leaderboard`);
  const key = Object.keys(lb.users || {}).find(k => k.toLowerCase() === USER.toLowerCase());
  const u = key ? lb.users[key] : null;
  console.log(`\n── Leaderboard credits this profile with ──`);
  if (!u) { console.log('  (no leaderboard entry under this username)'); }
  else {
    const s = u.scores || {};
    console.log(`  extensionIncluded: ${u.extensionIncluded}`);
    console.log(`  linkedAccounts   : ${(u.linkedAccounts || []).map(a => a.username).join(', ') || '(none)'}`);
    for (const t of TIDS) console.log(`    ${t.padEnd(12)} overall ${String((s['overall_'+t]||0).toLocaleString()).padEnd(12)} today ${(s['daily_'+t]||0).toLocaleString()}`);
  }

  // 3. extension_scrobbles grouped by spotify_account
  const rows = await extRows(appUserId);
  console.log(`\n── extension_scrobbles under this appUserId : ${rows.length.toLocaleString()} total ──`);
  if (!rows.length) { console.log('  NONE — no raw scrobbles are attributed to this profile.'); return; }
  const now = Date.now();
  const byAcct = {};
  for (const r of rows) {
    const a = r.spotify_account || '(blank)';
    (byAcct[a] ||= { n: 0, latest: r.listened_at, tracks: {} });
    byAcct[a].n++;
    if (r.listened_at > byAcct[a].latest) byAcct[a].latest = r.listened_at;
    byAcct[a].tracks[r.track_id] = (byAcct[a].tracks[r.track_id] || 0) + 1;
  }
  const accts = Object.entries(byAcct).sort((a, b) => b[1].n - a[1].n);
  console.log(`  distinct spotify accounts attributed: ${accts.length}\n`);
  console.log(`  ${'spotify_account'.padEnd(26)} ${'scrobbles'.padEnd(11)} ${'last seen'.padEnd(14)} top tracks`);
  for (const [a, d] of accts) {
    const mins = Math.round((now - Date.parse(d.latest)) / 60000);
    const ago = mins < 120 ? `${mins}m ago` : `${Math.round(mins/60)}h ago`;
    const top = Object.entries(d.tracks).sort((x,y)=>y[1]-x[1]).slice(0,4).map(([t,n])=>`${t}:${n}`).join(' ');
    console.log(`  ${a.padEnd(26)} ${String(d.n.toLocaleString()).padEnd(11)} ${ago.padEnd(14)} ${top}`);
  }

  // per-track grand total from raw rows, to compare with leaderboard overall_*
  const tot = {}; for (const t of TIDS) tot[t] = 0;
  for (const r of rows) if (tot[r.track_id] != null) tot[r.track_id]++;
  console.log(`\n── raw extension total per track (this appUserId) ──`);
  for (const t of TIDS) console.log(`    ${t.padEnd(12)} ${tot[t].toLocaleString()}`);
  console.log('\nIf leaderboard "overall" >> raw here, the rest comes from Last.fm/LB/statsfm.');
  console.log('If an account you use is missing above, its plays are NOT on this profile.');
})();
