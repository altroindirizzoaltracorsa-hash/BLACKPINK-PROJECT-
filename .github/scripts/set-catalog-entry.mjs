/**
 * Sets a specific entry in the BLACKPINK catalog history.
 * Env vars: VERCEL_URL, ADMIN_KEY, CATALOG_DATE (DD/MM), CATALOG_TOTAL (integer)
 */

const VERCEL_URL = process.env.VERCEL_URL || 'https://blinksunited.com';
const ADMIN_KEY  = process.env.ADMIN_KEY;
const DATE       = process.env.CATALOG_DATE;
const TOTAL      = process.env.CATALOG_TOTAL;

async function main() {
  if (!ADMIN_KEY) { console.error('ADMIN_KEY not set'); process.exit(1); }
  if (!DATE || !TOTAL) { console.error('CATALOG_DATE and CATALOG_TOTAL required'); process.exit(1); }

  const url = `${VERCEL_URL}/api/streams?catalog=1&action=set&date=${encodeURIComponent(DATE)}&total=${TOTAL}&key=${encodeURIComponent(ADMIN_KEY)}`;
  console.log(`Setting catalog entry: ${DATE} = ${Number(TOTAL).toLocaleString()}`);

  const res  = await fetch(url);
  const body = await res.json();

  if (!res.ok || !body.ok) {
    console.error('Failed:', JSON.stringify(body));
    process.exit(1);
  }

  console.log(`✓ Set ${DATE}: ${Number(TOTAL).toLocaleString()}`);
  const hist = body.history || [];
  console.log(`History entries: ${hist.length}`);
  for (const h of hist.slice(-5)) {
    console.log(`  ${h.date}: ${h.total?.toLocaleString()} ${h.daily != null ? `(+${h.daily.toLocaleString()})` : ''}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
