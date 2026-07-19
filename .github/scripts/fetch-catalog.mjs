/**
 * Runs in GitHub Actions (network isn't blocked from reaching Vercel).
 * Forces the production /api/streams catalog-total endpoint to refresh,
 * reusing its existing fallback chain (Worker -> RapidAPI -> Spotify partner
 * API via a browser-cached anon token -> kworb.net scrape) instead of
 * re-deriving a Spotify anon token here.
 */

const VERCEL_URL = process.env.VERCEL_URL || 'https://blackpink-project.vercel.app';
const ADMIN_KEY  = process.env.ADMIN_KEY;

async function main() {
  if (!ADMIN_KEY) { console.error('ADMIN_KEY secret not set'); process.exit(1); }

  const url = `${VERCEL_URL}/api/streams?catalog=1&force=1&key=${encodeURIComponent(ADMIN_KEY)}`;
  const res = await fetch(url);
  const body = await res.json();

  if (!res.ok || !body.total) {
    console.error('Catalog refresh failed:', JSON.stringify(body));
    process.exit(1);
  }

  console.log(`✓ Total: ${body.total.toLocaleString()} (source: ${body.source})`);
  console.log(`History entries: ${body.history?.length}`);
  if (body.errors?.length) {
    console.log('Methods tried before the winning source (in order):');
    for (const e of body.errors) console.log(`  - ${e}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
