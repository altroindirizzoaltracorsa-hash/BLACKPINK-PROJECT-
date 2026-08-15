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

  // ---- Optional: exact scoped slice for a manual ground-truth comparison ----
  if (SCOPE_ACCT && SCOPE_FROM) {
    const track = SCOPE_TRACK || 'jump';
    let q = `select=listened_at,created_at&track_id=eq.${track}`
          + `&spotify_account=eq.${encodeURIComponent(SCOPE_ACCT)}`
          + `&listened_at=gte.${encodeURIComponent(SCOPE_FROM)}`;
    if (SCOPE_TO) q += `&listened_at=lt.${encodeURIComponent(SCOPE_TO)}`;
    q += '&order=listened_at';
    const rows = await fetchAll(q);
    const distinct = new Set(rows.map((r) => r.listened_at));
    console.log('');
    console.log('================ MANUAL GROUND-TRUTH SLICE ================');
    console.log(`account=${SCOPE_ACCT}  track=${track}`);
    console.log(`window: ${SCOPE_FROM} .. ${SCOPE_TO || '(now)'}`);
    console.log(`raw rows stored:   ${rows.length}   <- what a naive count would show`);
    console.log(`distinct plays:    ${distinct.size}   <- deduped (count this against your hand count)`);
    console.log(`duplicate surplus: ${rows.length - distinct.size}`);
    console.log('each distinct play (listened_at) — line these up with what you watched:');
    for (const la of [...distinct].sort()) console.log(`   ${la}`);
  }

  console.log('');
  console.log('================ how to read this ================');
  console.log('duplicate surplus = 0  →  the extension recorded each play once; the server record is NOT inflated.');
  console.log('duplicate surplus > 0  →  the same play was ingested multiple times (double-write). insert-gaps show how far apart.');
  console.log('To scope one account+window for a manual check, set DIAG_ACCT, DIAG_FROM, DIAG_TO (ISO), DIAG_TRACK.');
}

main().catch((e) => fail(e.stack || e.message));
