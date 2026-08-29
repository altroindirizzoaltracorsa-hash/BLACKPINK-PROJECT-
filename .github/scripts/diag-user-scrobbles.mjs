/*
 * Read-only per-user diagnostic (v2, resilient to missing links). For USERNAME:
 *   A. leaderboard entry (method/source, appUserId, extensionIncluded, linkedAccounts, scores)
 *   B. linked_accounts rows that reference the username or its app_user_id
 *   C. scrobble_tokens rows for the username / app_user_id
 *   D. if an appUserId is found, group its extension_scrobbles by spotify_account
 *   E. recent distinct spotify_account values across ALL users (last 48h) so we can
 *      eyeball whether the person's accounts are landing under some OTHER profile
 *
 * Needs SUPABASE_URL + SUPABASE_SERVICE_KEY (ADMIN_KEY optional).
 */
const BASE = process.env.LB_BASE || 'https://blinksunited.com';
const URL  = process.env.SUPABASE_URL;
const KEY  = process.env.SUPABASE_SERVICE_KEY;
const USER = process.env.USERNAME;
if (!URL || !KEY || !USER) { console.error('Missing SUPABASE_* / USERNAME'); process.exit(1); }

const TIDS = ['jump','shutdown','ddududu','go','ltal','fallenangel','heaven'];
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function j(url, opts) {
  try {
    const r = await fetch(url, opts);
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { ok: r.ok || r.status === 206, status: r.status, body };
  } catch (e) { return { ok: false, status: 0, body: String(e) }; }
}
const sb = (path) => j(`${URL}/rest/v1/${path}`, { headers: H });

async function extRowsBy(col, val) {
  const rows = [];
  for (let off = 0; off < 100000; off += 1000) {
    const r = await j(`${URL}/rest/v1/extension_scrobbles?select=spotify_account,track_id,listened_at&${col}=eq.${encodeURIComponent(val)}&order=listened_at.desc`, { headers: { ...H, Range: `${off}-${off + 999}` } });
    if (!r.ok || !Array.isArray(r.body)) break;
    rows.push(...r.body);
    if (r.body.length < 1000) break;
  }
  return rows;
}

function groupByAcct(rows) {
  const now = Date.now(), by = {};
  for (const r of rows) {
    const a = r.spotify_account || '(blank)';
    (by[a] ||= { n: 0, latest: r.listened_at });
    by[a].n++;
    if (r.listened_at > by[a].latest) by[a].latest = r.listened_at;
  }
  for (const [a, d] of Object.entries(by).sort((x, y) => y[1].n - x[1].n)) {
    const mins = Math.round((now - Date.parse(d.latest)) / 60000);
    const ago = mins < 120 ? `${mins}m` : `${Math.round(mins/60)}h`;
    console.log(`      ${a.padEnd(28)} ${String(d.n.toLocaleString()).padEnd(9)} last ${ago} ago`);
  }
}

(async () => {
  console.log(`Per-user diagnostic v2 — ${USER}\n`);

  // A. leaderboard entry
  const lb = await j(`${BASE}/api/leaderboard`);
  let appUserId = null;
  if (lb.ok && lb.body?.users) {
    const key = Object.keys(lb.body.users).find(k => k.toLowerCase() === USER.toLowerCase());
    const u = key ? lb.body.users[key] : null;
    console.log('── A. Leaderboard entry ──');
    if (!u) console.log('  (no leaderboard entry under this exact username)');
    else {
      appUserId = u.appUserId || u.app_user_id || null;
      console.log(`  method/source   : ${u.method || u.source || '(unset)'}`);
      console.log(`  appUserId       : ${appUserId || '(none on entry)'}`);
      console.log(`  extensionIncluded: ${u.extensionIncluded}`);
      console.log(`  linkedAccounts  : ${(u.linkedAccounts || []).map(a => a.username || a).join(', ') || '(none)'}`);
      console.log(`  scores          : ` + TIDS.map(t => `${t}=${(u.scores?.['overall_'+t]||0)}`).join(' '));
    }
  } else console.log(`── A. leaderboard fetch failed: ${lb.status}`);

  // B. linked_accounts by username
  console.log('\n── B. linked_accounts rows matching this username ──');
  const la = await sb(`linked_accounts?or=(username.ilike.${encodeURIComponent(USER)},display_name.ilike.${encodeURIComponent(USER)})&limit=50`);
  if (!la.ok) console.log(`  query failed (${la.status}): ${JSON.stringify(la.body).slice(0,200)}`);
  else if (!la.body.length) console.log('  NONE — no linked_accounts row references this username.');
  else { for (const row of la.body) { console.log(`  ${JSON.stringify(row)}`); if (!appUserId) appUserId = row.app_user_id || row.appUserId; } }

  // C. scrobble_tokens by username
  console.log('\n── C. scrobble_tokens rows matching this username ──');
  const st = await sb(`scrobble_tokens?username=ilike.${encodeURIComponent(USER)}&limit=50`);
  if (!st.ok) console.log(`  query failed (${st.status}): ${JSON.stringify(st.body).slice(0,200)}`);
  else if (!st.body.length) console.log('  NONE — no scrobble_tokens row for this username.');
  else for (const row of st.body) { const red = { ...row }; if (red.token) red.token = '***'; console.log(`  ${JSON.stringify(red)}`); if (!appUserId) appUserId = row.app_user_id || row.appUserId; }

  // D. extension_scrobbles under the resolved appUserId
  console.log('\n── D. extension_scrobbles under resolved appUserId ──');
  if (!appUserId) console.log('  no appUserId resolved from A/B/C → cannot attribute raw scrobbles to this profile.');
  else {
    console.log(`  appUserId = ${appUserId}`);
    const rows = await extRowsBy('app_user_id', appUserId);
    console.log(`  ${rows.length.toLocaleString()} rows, by spotify_account:`);
    groupByAcct(rows);
    const tot = Object.fromEntries(TIDS.map(t => [t, 0]));
    for (const r of rows) if (tot[r.track_id] != null) tot[r.track_id]++;
    console.log('  per track: ' + TIDS.map(t => `${t}=${tot[t]}`).join(' '));
  }

  // E. recent account pool (last 48h) — who is scrobbling under what app_user_id
  console.log('\n── E. recent spotify_account → app_user_id pool (last 48h) ──');
  const since = new Date(Date.now() - 48 * 3600000).toISOString();
  const recent = await j(`${URL}/rest/v1/extension_scrobbles?select=spotify_account,app_user_id,listened_at&listened_at=gte.${since}&order=listened_at.desc`, { headers: { ...H, Range: '0-4999' } });
  if (recent.ok && Array.isArray(recent.body)) {
    const map = {};
    for (const r of recent.body) { const a = r.spotify_account || '(blank)'; (map[a] ||= { n: 0, users: new Set() }); map[a].n++; map[a].users.add(r.app_user_id); }
    console.log(`  ${Object.keys(map).length} distinct accounts active:`);
    for (const [a, d] of Object.entries(map).sort((x, y) => y[1].n - x[1].n)) {
      console.log(`      ${a.padEnd(28)} ${String(d.n).padEnd(6)} under app_user_id(s): ${[...d.users].join(', ')}`);
    }
  } else console.log(`  query failed: ${recent.status}`);
})();
