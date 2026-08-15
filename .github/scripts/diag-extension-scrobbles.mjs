/**
 * One-off diagnostic: audits the `extension_scrobbles` table (written by
 * api/ingest-scrobble.js) to answer "is the extension's server-side record
 * inflated / duplicated?".
 *
 * For today's UTC window (the campaign day starts 00:00 UTC) it reports, per
 * campaign track:
 *   - total rows
 *   - per-Spotify-account breakdown
 *   - EXACT duplicate plays: rows sharing (app_user_id, spotify_account,
 *     listened_at). Since the extension sends listened_at = the play's start
 *     second, a real play can only produce ONE such tuple — so 2+ rows for one
 *     tuple means the same play was ingested more than once (double-write).
 *
 * Read-only. Uses the Supabase REST API with the service key. No deps.
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY. Safe to delete once used.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

const TRACKS = ['jump', 'shutdown', 'ddududu', 'ltal', 'go'];

// Optional scoping for a manual ground-truth check: set these to compare a hand
// count against the server for ONE account over an exact window. All optional.
const SCOPE_ACCT = (process.env.DIAG_ACCT || '').trim();          // exact spotify_account label, e.g. "D"
const SCOPE_FROM = (process.env.DIAG_FROM || '').trim();          // ISO, e.g. 2026-08-15T14:00:00Z
const SCOPE_TO   = (process.env.DIAG_TO || '').trim();            // ISO, e.g. 2026-08-15T14:30:00Z
const SCOPE_TRACK = (process.env.DIAG_TRACK || '').trim().toLowerCase(); // e.g. "jump"

function fail(m) { console.error('❌ ' + m); process.exit(1); }

async function totalCount(query) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/extension_scrobbles?${query}`, {
    headers: { ...headers, Prefer: 'count=exact', Range: '0-0' },
  });
  if (!r.ok && r.status !== 206) fail(`count query failed: HTTP ${r.status} ${await r.text()}`);
  const cr = r.headers.get('content-range') || '';
  return cr.includes('/') ? cr.split('/')[1] : '?';
}

async function fetchAll(query) {
  const page = 1000;
  let offset = 0, out = [];
  for (;;) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/extension_scrobbles?${query}&limit=${page}&offset=${offset}`, { headers });
    if (!r.ok) fail(`fetch failed: HTTP ${r.status} ${await r.text()}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < page) break;
    offset += page;
    if (offset > 500000) break; // safety
  }
  return out;
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) fail('SUPABASE_URL / SUPABASE_SERVICE_KEY not set');

  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const todayISO = todayStart.toISOString();

  console.log('================ extension_scrobbles audit ================');
  console.log(`now (UTC):        ${now.toISOString()}`);
  console.log(`today window:     >= ${todayISO}`);
  console.log(`all-time rows:    ${await totalCount('select=id')}`);
  console.log(`today rows (all): ${await totalCount(`select=id&listened_at=gte.${todayISO}`)}`);
  console.log('');

  for (const track of TRACKS) {
    const rows = await fetchAll(
      `select=app_user_id,spotify_account,listened_at,created_at&track_id=eq.${track}&listened_at=gte.${todayISO}&order=listened_at`,
    );
    if (!rows.length) { console.log(`── ${track.toUpperCase()}: 0 rows today`); continue; }

    // Per-account tally.
    const byAcct = {};
    for (const r of rows) {
      const a = r.spotify_account || '(none)';
      byAcct[a] = (byAcct[a] || 0) + 1;
    }

    // Exact duplicate plays: same (app_user_id, spotify_account, listened_at).
    const groups = {};
    for (const r of rows) {
      const k = `${r.app_user_id}|${r.spotify_account || ''}|${r.listened_at}`;
      (groups[k] = groups[k] || []).push(r);
    }
    const dupGroups = Object.entries(groups).filter(([, g]) => g.length > 1);
    const surplus = dupGroups.reduce((s, [, g]) => s + (g.length - 1), 0);
    const uniquePlays = Object.keys(groups).length;

    console.log(`── ${track.toUpperCase()}: ${rows.length} rows today  |  unique plays: ${uniquePlays}  |  duplicate surplus: ${surplus}`);
    console.log(`   per account: ${Object.entries(byAcct).sort((a, b) => b[1] - a[1]).map(([a, n]) => `${a}=${n}`).join(', ')}`);
    if (dupGroups.length) {
      console.log(`   ⚠️  ${dupGroups.length} play(s) ingested more than once. Examples:`);
      for (const [k, g] of dupGroups.slice(0, 8)) {
        const [uid, acct, la] = k.split('|');
        const inserts = g.map((r) => r.created_at).sort();
        const gaps = inserts.slice(1).map((t, i) => Math.round((new Date(t) - new Date(inserts[i])) / 1000) + 's');
        console.log(`     acct=${acct} listened_at=${la} ×${g.length}  insert-gaps=[${gaps.join(', ')}]  uid=${uid.slice(0, 8)}`);
      }
    }
    console.log('');
  }

  // ---- Optional: scoped slice for a manual ground-truth comparison ----
  // Requires a window (DIAG_FROM). DIAG_ACCT may be blank (= ALL accounts) or a
  // comma-separated list (e.g. "S,M,D") for a multi-account test. DIAG_TRACK
  // optional (blank = all campaign tracks).
  if (SCOPE_FROM) {
    const acctList = SCOPE_ACCT.split(',').map((s) => s.trim()).filter(Boolean);
    let q = `select=spotify_account,track_id,listened_at,created_at`
          + `&listened_at=gte.${encodeURIComponent(SCOPE_FROM)}`;
    if (acctList.length === 1) q += `&spotify_account=eq.${encodeURIComponent(acctList[0])}`;
    else if (acctList.length > 1) q += `&spotify_account=in.(${acctList.map((a) => `"${a}"`).join(',')})`;
    if (SCOPE_TRACK) q += `&track_id=eq.${SCOPE_TRACK}`;
    if (SCOPE_TO) q += `&listened_at=lt.${encodeURIComponent(SCOPE_TO)}`;
    q += '&order=spotify_account,listened_at';
    const rows = await fetchAll(q);

    console.log('');
    console.log('================ MANUAL GROUND-TRUTH SLICE ================');
    console.log(`accounts=${acctList.length ? acctList.join(', ') : '(all)'}  track=${SCOPE_TRACK || '(all campaign tracks)'}`);
    console.log(`window: ${SCOPE_FROM} .. ${SCOPE_TO || '(now)'}`);

    // Group by account -> per-track rows/distinct. Distinct play = (track,listened_at).
    const byAcct = {};
    for (const r of rows) {
      const a = r.spotify_account || '(none)';
      const acc = (byAcct[a] = byAcct[a] || { rows: 0, keys: new Set(), byTrack: {} });
      acc.rows += 1;
      acc.keys.add(`${r.track_id}|${r.listened_at}`);
      const t = (acc.byTrack[r.track_id] = acc.byTrack[r.track_id] || { rows: 0, keys: new Set() });
      t.rows += 1;
      t.keys.add(r.listened_at);
    }
    for (const a of Object.keys(byAcct).sort()) {
      const acc = byAcct[a];
      console.log('');
      console.log(`── ${a}:  raw rows=${acc.rows}  distinct plays=${acc.keys.size}  duplicate surplus=${acc.rows - acc.keys.size}`);
      for (const [t, v] of Object.entries(acc.byTrack).sort((x, y) => y[1].rows - x[1].rows)) {
        const flag = v.rows !== v.keys.size ? '  ⚠️ dup' : '';
        console.log(`     ${t.padEnd(10)} rows=${v.rows}  distinct=${v.keys.size}${flag}`);
      }
    }
    console.log('');
    console.log('(compare "distinct plays" per account to your hand count. surplus>0 = a duplicate slipped in.)');
  }

  // ---- Per-day duplicate timeline (all-time) — does dup-rate spike on the
  //      days two extension versions overlapped, or is it constant? ----
  console.log('');
  console.log('================ PER-DAY DUPLICATE TIMELINE (all-time) ================');
  const allRows = await fetchAll('select=track_id,spotify_account,listened_at');
  const perDay = {};
  for (const r of allRows) {
    const day = (r.listened_at || '').slice(0, 10); // UTC date
    if (!day) continue;
    const d = (perDay[day] = perDay[day] || { rows: 0, keys: new Set() });
    d.rows += 1;
    d.keys.add(`${r.spotify_account || ''}|${r.track_id}|${r.listened_at}`);
  }
  console.log('day         rows   uniquePlays   dupSurplus   dup%');
  for (const day of Object.keys(perDay).sort()) {
    const d = perDay[day];
    const uniq = d.keys.size;
    const surplus = d.rows - uniq;
    const pct = d.rows ? ((surplus / d.rows) * 100).toFixed(1) : '0.0';
    console.log(`${day}  ${String(d.rows).padStart(5)}   ${String(uniq).padStart(11)}   ${String(surplus).padStart(10)}   ${pct.padStart(4)}%`);
  }

  console.log('');
  console.log('================ how to read this ================');
  console.log('duplicate surplus = 0  →  the extension recorded each play once; the server record is NOT inflated.');
  console.log('duplicate surplus > 0  →  the same play was ingested multiple times (double-write). insert-gaps show how far apart.');
  console.log('To scope one account+window for a manual check, set DIAG_ACCT, DIAG_FROM, DIAG_TO (ISO), DIAG_TRACK.');
}

main().catch((e) => fail(e.stack || e.message));
