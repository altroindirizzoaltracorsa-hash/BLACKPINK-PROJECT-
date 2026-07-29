/**
 * Runs in GitHub Actions (network isn't blocked from reaching Vercel).
 * Forces the production /api/streams campaign-tracks endpoint (JUMP, Shut
 * Down, DDU-DU DDU-DU official Spotify play counts) to refresh right now,
 * bypassing the Rome-hour watch-window gate that normally only lets this
 * refresh from live visitor traffic during Spotify's usual update window.
 * A successful forced refresh also fire-and-forget triggers the catalog
 * total refresh server-side (see api/streams.js), but fetch-catalog.mjs
 * still calls it explicitly afterward so this job's logs show a real result
 * instead of depending on that best-effort trigger.
 */

const VERCEL_URL = process.env.VERCEL_URL || 'https://blinksunited.com';
const ADMIN_KEY  = process.env.ADMIN_KEY;

async function main() {
  if (!ADMIN_KEY) { console.error('ADMIN_KEY secret not set'); process.exit(1); }

  const url = `${VERCEL_URL}/api/streams?force=1&key=${encodeURIComponent(ADMIN_KEY)}`;
  const res = await fetch(url);
  const body = await res.json();

  if (!res.ok) {
    console.error('Campaign tracks refresh failed:', JSON.stringify(body));
    process.exit(1);
  }

  for (const track of ['jump', 'shutdown', 'ddududu']) {
    const t = body[track];
    if (!t) { console.log(`${track}: no data returned`); continue; }
    console.log(`✓ ${track}: ${t.total.toLocaleString()} total${t.stale ? ' (stale — live fetch failed, showing last known-good)' : ''}`);
  }
  if (body._debug?.errors && Object.keys(body._debug.errors).length) {
    console.log('Per-track errors:', JSON.stringify(body._debug.errors));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
