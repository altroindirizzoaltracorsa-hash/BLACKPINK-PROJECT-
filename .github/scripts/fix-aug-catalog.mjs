/**
 * Fixes the Aug 2/3 catalog entries using delete-then-set to avoid
 * the forceOverwrite code path.
 *
 * Steps:
 *  1. Delete 02/08 (wrong value: 17,600,158,856)
 *  2. Delete 03/08 (may or may not exist)
 *  3. Set 02/08 = 17,595,602,852
 *  4. Set 03/08 = 17,600,158,856
 *  5. Print full history for verification
 */

const BASE  = process.env.VERCEL_URL || 'https://blinksunited.com';
const KEY   = process.env.ADMIN_KEY;

if (!KEY) { console.error('ADMIN_KEY not set'); process.exit(1); }

async function api(params) {
  const qs  = new URLSearchParams({ ...params, key: KEY });
  const url = `${BASE}/api/streams?catalog=1&${qs}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) console.warn(`  HTTP ${res.status}:`, JSON.stringify(body));
  return { ok: res.ok, body };
}

async function deleteEntry(date) {
  console.log(`\n[DELETE] ${date}`);
  const { ok, body } = await api({ action: 'delete', date });
  if (!ok) { console.error(`  FAILED`); process.exit(1); }
  console.log(`  ✓ removed ${body.removed ?? 0} entry/entries`);
}

async function setEntry(date, total) {
  console.log(`\n[SET] ${date} = ${Number(total).toLocaleString()}`);
  const { ok, body } = await api({ action: 'set', date, total: String(total) });
  if (!ok || !body.ok) {
    console.error(`  FAILED:`, JSON.stringify(body));
    process.exit(1);
  }
  console.log(`  ✓ set`);
  return body;
}

async function main() {
  console.log('=== Fix Aug 2/3 Catalog Entries ===');
  console.log('Target: 02/08 = 17,595,602,852 | 03/08 = 17,600,158,856\n');

  // Step 1+2: Delete both entries so we start clean
  await deleteEntry('02/08');
  await deleteEntry('03/08');

  // Step 3: Set 02/08 fresh (no existing entry → else branch in updateCatalogHistory)
  await setEntry('02/08', '17595602852');

  // Step 4: Set 03/08 fresh
  const result = await setEntry('03/08', '17600158856');

  // Step 5: Print full history from the last set response
  const hist = result.history || [];
  console.log(`\n=== Final history (${hist.length} entries) ===`);
  for (const h of hist) {
    const flag = (h.date === '02/08' || h.date === '03/08') ? ' <--' : '';
    console.log(`  ${h.date}: ${h.total?.toLocaleString()} ${h.daily != null ? `(+${h.daily.toLocaleString()})` : ''}${flag}`);
  }

  // Verify
  const aug2 = hist.find(h => h.date === '02/08');
  const aug3 = hist.find(h => h.date === '03/08');
  const ok = aug2?.total === 17595602852 && aug3?.total === 17600158856;
  console.log(`\n${ok ? '✓ VERIFIED CORRECT' : '✗ VERIFICATION FAILED'}`);
  if (!ok) {
    console.error(`  02/08: ${aug2?.total} (expected 17595602852)`);
    console.error(`  03/08: ${aug3?.total} (expected 17600158856)`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
