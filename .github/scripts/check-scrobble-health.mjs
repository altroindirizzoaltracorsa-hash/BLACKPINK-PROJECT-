/*
 * Read-only health check on extension_scrobbles.
 *
 * Pulls the last WINDOW_H hours of rows and reports:
 *   1. Is data flowing?  total rows, distinct scrobblers, latest listen, last-hour volume
 *   2. Per track_id counts + how many distinct accounts hit each track
 *   3. Classification correctness — for each known song title, how its rows are
 *      bucketed by track_id (flags anything landing in the wrong bucket, e.g. a
 *      Fallen Angel / Heaven play still filed under solo_jennie instead of its own id)
 *   4. Anything unexpected — track_ids we don't recognise
 *
 * extension_scrobbles columns: app_user_id, track_id, artist, title, spotify_account,
 * listened_at, created_at.
 */
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL || !KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }

const WINDOW_H = Number(process.env.WINDOW_H || 24);
const sinceISO = new Date(Date.now() - WINDOW_H * 3600000).toISOString();

// track_ids we expect the ingest to produce.
const CAMPAIGN = ['jump', 'shutdown', 'ddududu', 'go', 'ltal', 'fallenangel', 'heaven'];
const BUCKETS  = ['bp_group', 'solo_jisoo', 'solo_jennie', 'solo_rose', 'solo_lisa'];
const EXPECTED = new Set([...CAMPAIGN, ...BUCKETS]);

// title substring → the track_id that title SHOULD map to (campaign matches win
// over the artist-bucket fallback). Order matters: most specific first.
const TITLE_RULES = [
  { needle: 'less than a lover', id: 'ltal' },
  { needle: 'fallen angel',      id: 'fallenangel' },
  { needle: 'heaven',            id: 'heaven' },
  { needle: 'ddu-du',            id: 'ddududu' },
  { needle: 'shut down',         id: 'shutdown' },
  { needle: 'jump',              id: 'jump' },
];

async function page(offset, limit) {
  const qs = [
    'select=app_user_id,track_id,artist,title,spotify_account,listened_at,created_at',
    `listened_at=gte.${sinceISO}`,
    'order=listened_at.desc',
  ].join('&');
  const r = await fetch(`${URL}/rest/v1/extension_scrobbles?${qs}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${offset}-${offset + limit - 1}` },
  });
  if (!r.ok && r.status !== 206) { console.error(`HTTP ${r.status}: ${await r.text()}`); process.exit(1); }
  return r.json();
}

async function fetchAll() {
  const rows = [];
  const LIMIT = 1000;
  for (let off = 0; off < 40000; off += LIMIT) {
    const batch = await page(off, LIMIT);
    rows.push(...batch);
    if (batch.length < LIMIT) break;
  }
  return rows;
}

const pad = (s, n) => String(s).padEnd(n);
const num = (n) => n.toLocaleString();

(async () => {
  console.log(`extension_scrobbles health — last ${WINDOW_H}h (since ${sinceISO})\n`);
  const rows = await fetchAll();
  if (!rows.length) { console.log('No rows in window. Extension is NOT delivering scrobbles.'); return; }

  const now = Date.now();
  const lastHour = rows.filter(r => now - Date.parse(r.listened_at) <= 3600000).length;
  const last10m  = rows.filter(r => now - Date.parse(r.listened_at) <= 600000).length;
  const accounts = new Set(rows.map(r => r.spotify_account).filter(Boolean));
  const users    = new Set(rows.map(r => r.app_user_id).filter(Boolean));
  const latest   = rows.reduce((a, r) => r.listened_at > a ? r.listened_at : a, '');

  console.log('── 1. Is data flowing? ─────────────────────────────');
  console.log(`  total scrobbles      : ${num(rows.length)}`);
  console.log(`  distinct spotify accts: ${num(accounts.size)}`);
  console.log(`  distinct app users    : ${num(users.size)}`);
  console.log(`  latest listened_at    : ${latest}  (${Math.round((now - Date.parse(latest)) / 60000)} min ago)`);
  console.log(`  in last 60 min        : ${num(lastHour)}`);
  console.log(`  in last 10 min        : ${num(last10m)}`);

  // Per track_id
  const byTid = {};
  for (const r of rows) {
    const t = r.track_id || '(null)';
    (byTid[t] ||= { n: 0, accts: new Set() });
    byTid[t].n++;
    if (r.spotify_account) byTid[t].accts.add(r.spotify_account);
  }
  console.log('\n── 2. Per track_id (24h) ───────────────────────────');
  console.log(`  ${pad('track_id', 16)} ${pad('scrobbles', 11)} distinct accts`);
  const order = [...CAMPAIGN, ...BUCKETS, ...Object.keys(byTid).filter(t => !EXPECTED.has(t) && t !== '(null)'), '(null)'];
  for (const t of order) {
    const b = byTid[t];
    const label = b ? `${pad(num(b.n), 11)} ${num(b.accts.size)}` : `${pad('0', 11)} — (none)`;
    const flag = (!EXPECTED.has(t) && t !== '(null)') ? '  ⚠ unexpected bucket' : (t === '(null)' && b ? '  ⚠ null track_id' : '');
    console.log(`  ${pad(t, 16)} ${label}${flag}`);
  }

  // Classification correctness by title
  console.log('\n── 3. Classification check (title → track_id) ──────');
  for (const rule of TITLE_RULES) {
    const matched = rows.filter(r => (r.title || '').toLowerCase().includes(rule.needle));
    if (!matched.length) { console.log(`  "${rule.needle}" → expect ${rule.id}: no rows in window`); continue; }
    const dist = {};
    for (const r of matched) { const t = r.track_id || '(null)'; (dist[t] ||= { n: 0, min: r.listened_at, max: r.listened_at }); dist[t].n++; if (r.listened_at < dist[t].min) dist[t].min = r.listened_at; if (r.listened_at > dist[t].max) dist[t].max = r.listened_at; }
    const wrong = Object.keys(dist).filter(t => t !== rule.id).reduce((a, t) => a + dist[t].n, 0);
    const ok = dist[rule.id]?.n || 0;
    const verdict = wrong === 0 ? '✓ all correct' : `⚠ ${num(wrong)} mis-filed`;
    console.log(`  "${rule.needle}" → expect ${pad(rule.id, 12)} : ${num(matched.length)} rows  [${verdict}]`);
    for (const [t, d] of Object.entries(dist).sort((a, b) => b[1].n - a[1].n)) {
      const mark = t === rule.id ? ' ' : '✗';
      console.log(`        ${mark} ${pad(t, 14)} ${pad(num(d.n), 8)}  ${d.min.slice(5, 16)} → ${d.max.slice(5, 16)}`);
    }
  }

  console.log('\nNOTE: extension_scrobbles is the extension-recorded portion only.');
  console.log('Last.fm / ListenBrainz / Stats.fm plays are read as aggregates elsewhere.');
})();
