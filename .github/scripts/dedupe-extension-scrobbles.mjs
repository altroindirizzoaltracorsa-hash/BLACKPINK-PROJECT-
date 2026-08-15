/**
 * Cleanup: removes duplicate rows from `extension_scrobbles` so the record is
 * truthful (one real play = one row).
 *
 * A real play is uniquely identified by the tuple
 *   (app_user_id, spotify_account, track_id, listened_at)
 * because one Spotify account cannot start the same track twice in the same
 * second. Any second+ row sharing that tuple is a double-write (an SW-restart /
 * poll-overlap race, or an older extension version co-existing) and is removed.
 *
 * For each duplicate group we KEEP the earliest-inserted row (min created_at,
 * tie-broken by min id) and delete the rest.
 *
 * SAFETY: dry-run by default. It only deletes when DRY_RUN=false is passed
 * explicitly. Dry-run prints exactly what WOULD be deleted and changes nothing.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, DRY_RUN ('true'|'false', default true).
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const DRY_RUN = (process.env.DRY_RUN || 'true').trim().toLowerCase() !== 'false';
const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

function fail(m) { console.error('❌ ' + m); process.exit(1); }

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
    if (offset > 500000) break;
  }
  return out;
}

async function deleteByIds(ids) {
  // PostgREST: DELETE ...?id=in.(a,b,c). Batch to keep the URL sane.
  const batch = 200;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += batch) {
    const slice = ids.slice(i, i + batch);
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/extension_scrobbles?id=in.(${slice.join(',')})`,
      { method: 'DELETE', headers: { ...headers, Prefer: 'return=representation' } },
    );
    if (!r.ok) fail(`delete failed: HTTP ${r.status} ${await r.text()}`);
    const rows = await r.json().catch(() => []);
    deleted += Array.isArray(rows) ? rows.length : 0;
    console.log(`   deleted batch ${i / batch + 1}: ${Array.isArray(rows) ? rows.length : '?'} rows`);
  }
  return deleted;
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) fail('SUPABASE_URL / SUPABASE_SERVICE_KEY not set');

  console.log('================ extension_scrobbles dedupe ================');
  console.log(`mode: ${DRY_RUN ? 'DRY-RUN (no changes)' : '⚠️  EXECUTE (will DELETE rows)'}`);

  const rows = await fetchAll('select=id,app_user_id,spotify_account,track_id,listened_at,created_at&order=created_at');
  console.log(`total rows scanned: ${rows.length}`);

  const groups = {};
  for (const r of rows) {
    const k = `${r.app_user_id}|${r.spotify_account || ''}|${r.track_id}|${r.listened_at}`;
    (groups[k] = groups[k] || []).push(r);
  }

  const toDelete = [];
  const perDay = {};
  let dupGroups = 0;
  for (const g of Object.values(groups)) {
    if (g.length < 2) continue;
    dupGroups += 1;
    // Keep earliest-inserted; delete the rest.
    g.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id));
    for (const r of g.slice(1)) {
      toDelete.push(r.id);
      const day = (r.listened_at || '').slice(0, 10);
      perDay[day] = (perDay[day] || 0) + 1;
    }
  }

  console.log(`duplicate groups:   ${dupGroups}`);
  console.log(`rows to delete:     ${toDelete.length}`);
  console.log('by day (surplus removed):');
  for (const day of Object.keys(perDay).sort()) console.log(`   ${day}  ${perDay[day]}`);

  console.log('sample of rows that would be removed (keeping the earliest of each group):');
  for (const g of Object.values(groups).filter((g) => g.length > 1).slice(0, 6)) {
    const [keep, ...drop] = [...g].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id));
    console.log(`   acct=${keep.spotify_account} ${keep.track_id} listened_at=${keep.listened_at}`);
    console.log(`     KEEP id=${keep.id} created=${keep.created_at}`);
    for (const d of drop) console.log(`     DROP id=${d.id} created=${d.created_at}`);
  }

  if (DRY_RUN) {
    console.log('');
    console.log('DRY-RUN complete. Nothing was changed. Re-run with DRY_RUN=false to delete.');
    return;
  }

  console.log('');
  console.log(`Deleting ${toDelete.length} rows...`);
  const n = await deleteByIds(toDelete);
  console.log(`✅ deleted ${n} rows.`);
  console.log('Next: add the unique index (supabase/extension_scrobbles_unique.sql) to prevent recurrence.');
}

main().catch((e) => fail(e.stack || e.message));
