/*
 * One-off backfill: re-file the pre-fix Fallen Angel / Heaven plays that landed in
 * the generic `solo_jennie` bucket (they were ingested before the per-song ingest
 * fix went live ~16:10 on Aug 28) into their own track_ids.
 *
 *   title ~ "fallen angel", track_id = solo_jennie  →  track_id = fallenangel
 *   title ~ "heaven",       track_id = solo_jennie  →  track_id = heaven
 *
 * Safe: post-fix plays already file correctly, so any solo_jennie row with these
 * titles is definitionally a pre-fix stray. Idempotent — a second run moves 0 rows.
 *
 * DRY RUN by default. Set APPLY=1 to actually write.
 */
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const APPLY = process.env.APPLY === '1';
if (!URL || !KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }

const MOVES = [
  { needle: 'fallen angel', from: 'solo_jennie', to: 'fallenangel' },
  { needle: 'heaven',       from: 'solo_jennie', to: 'heaven' },
];

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

// Preview: the exact rows a move would touch (id, title, listened_at).
async function preview(m) {
  const qs = [
    'select=id,title,artist,listened_at',
    `track_id=eq.${m.from}`,
    `title=ilike.*${encodeURIComponent(m.needle)}*`,
    'order=listened_at.asc',
  ].join('&');
  const r = await fetch(`${URL}/rest/v1/extension_scrobbles?${qs}`, { headers: H });
  if (!r.ok) { console.error(`preview HTTP ${r.status}: ${await r.text()}`); process.exit(1); }
  return r.json();
}

async function apply(m) {
  const qs = [
    `track_id=eq.${m.from}`,
    `title=ilike.*${encodeURIComponent(m.needle)}*`,
  ].join('&');
  const r = await fetch(`${URL}/rest/v1/extension_scrobbles?${qs}`, {
    method: 'PATCH',
    headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ track_id: m.to }),
  });
  if (!r.ok) { console.error(`PATCH HTTP ${r.status}: ${await r.text()}`); process.exit(1); }
  const updated = await r.json();
  return updated.length;
}

(async () => {
  console.log(`EP classification backfill — ${APPLY ? '*** APPLY ***' : 'DRY RUN (set APPLY=1 to write)'}\n`);
  for (const m of MOVES) {
    const rows = await preview(m);
    console.log(`── "${m.needle}"  ${m.from} → ${m.to} : ${rows.length} row(s) ──`);
    // Show the exact distinct titles so we can confirm none are false positives.
    const titles = {};
    for (const r of rows) titles[r.title] = (titles[r.title] || 0) + 1;
    for (const [t, n] of Object.entries(titles)) console.log(`     ${n}×  "${t}"`);
    if (rows.length) console.log(`     span: ${rows[0].listened_at} → ${rows[rows.length - 1].listened_at}`);
    if (APPLY && rows.length) {
      const n = await apply(m);
      console.log(`     ✔ moved ${n} row(s) to ${m.to}`);
    }
    console.log('');
  }

  // Re-check after apply so the log proves 0 strays remain.
  if (APPLY) {
    console.log('── verify (should be 0 each) ──');
    for (const m of MOVES) {
      const rows = await preview(m);
      console.log(`     ${m.from} still holding "${m.needle}": ${rows.length}`);
    }
  }
})();
