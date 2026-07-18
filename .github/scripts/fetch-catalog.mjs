/**
 * Runs in GitHub Actions (Azure IPs, not blocked by Spotify).
 * Fetches the BLACKPINK Spotify catalog total and POSTs it to the Vercel API.
 */

const ARTIST_ID    = '41MozSoPIsD1dJM0CLPjZF';
const UA           = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PARTNER_HASH = 'ae85b52abb74d20a4c331d4143d4772c95f34757a435d55406e6a2f17ad41c42';

const VERCEL_URL   = process.env.VERCEL_URL   || 'https://blackpink-project.vercel.app';
const ADMIN_KEY    = process.env.ADMIN_KEY;
const CLIENT_ID    = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

async function getAnonToken() {
  const r = await fetch(
    'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
    { headers: { 'User-Agent': UA, 'Accept': 'application/json' } },
  );
  const text = await r.text();
  if (!r.ok || !text.trimStart().startsWith('{')) {
    throw new Error(`anon-token ${r.status}: ${text.slice(0, 300)}`);
  }
  const d = JSON.parse(text);
  if (!d.accessToken) throw new Error(`accessToken missing: ${text.slice(0, 200)}`);
  console.log('✓ Got anon token');
  return d.accessToken;
}

async function getClientToken() {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set');
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`,
    },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`client-token ${r.status}: ${await r.text()}`);
  const d = await r.json();
  if (!d.access_token) throw new Error('client token: access_token missing');
  console.log('✓ Got client credentials token');
  return d.access_token;
}

async function getAllTrackIds(clientToken) {
  const albumIds = [];
  let url = `https://api.spotify.com/v1/artists/${ARTIST_ID}/albums?include_groups=album,single`;
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${clientToken}` } });
    if (!r.ok) throw new Error(`albums ${r.status}: ${await r.text()}`);
    const d = await r.json();
    for (const a of (d.items || [])) albumIds.push(a.id);
    url = d.next || null;
  }
  const seen = new Set(), ids = [];
  for (let i = 0; i < albumIds.length; i += 20) {
    const chunk = albumIds.slice(i, i + 20).join(',');
    const r = await fetch(`https://api.spotify.com/v1/albums?ids=${chunk}&market=US`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    if (!r.ok) continue;
    for (const album of ((await r.json()).albums || [])) {
      for (const t of (album?.tracks?.items || [])) {
        if (t?.id && !seen.has(t.id)) { seen.add(t.id); ids.push(t.id); }
      }
    }
  }
  console.log(`✓ Found ${ids.length} tracks across ${albumIds.length} albums`);
  return ids;
}

async function getPlayCount(trackId, anonToken) {
  const vars = JSON.stringify({ uri: `spotify:track:${trackId}` });
  const exts = JSON.stringify({ persistedQuery: { version: 1, sha256Hash: PARTNER_HASH } });
  const r = await fetch(
    `https://api-partner.spotify.com/pathfinder/v1/query?operationName=getTrack&variables=${encodeURIComponent(vars)}&extensions=${encodeURIComponent(exts)}`,
    { headers: { Authorization: `Bearer ${anonToken}`, 'User-Agent': UA } },
  );
  if (!r.ok) return 0;
  const d = await r.json();
  return Number(d?.data?.trackUnion?.playcount) || 0;
}

async function main() {
  if (!ADMIN_KEY) { console.error('ADMIN_KEY secret not set'); process.exit(1); }

  // Get both tokens in parallel
  const [anonToken, clientToken] = await Promise.all([getAnonToken(), getClientToken()]);

  // Enumerate all track IDs
  const trackIds = await getAllTrackIds(clientToken);
  if (!trackIds.length) { console.error('No track IDs found'); process.exit(1); }

  // Fetch play counts in batches of 20
  let total = 0, failed = 0;
  for (let i = 0; i < trackIds.length; i += 20) {
    const batch = trackIds.slice(i, i + 20);
    const counts = await Promise.all(
      batch.map(id => getPlayCount(id, anonToken).catch(() => { failed++; return 0; })),
    );
    total += counts.reduce((s, c) => s + c, 0);
    process.stdout.write(`\r  Tracks: ${Math.min(i + 20, trackIds.length)}/${trackIds.length}, running total: ${total.toLocaleString()}`);
  }
  console.log();

  if (total < 1_000_000_000) {
    console.error(`Total ${total} looks wrong (< 1B), aborting`);
    process.exit(1);
  }

  console.log(`✓ Total: ${total.toLocaleString()} (${failed} failed)`);

  // POST to Vercel API
  const postUrl = `${VERCEL_URL}/api/streams?catalog=1&action=set&total=${total}&key=${encodeURIComponent(ADMIN_KEY)}`;
  const res = await fetch(postUrl, { method: 'GET' }); // action=set uses GET
  const body = await res.json();
  if (!res.ok) {
    console.error('Failed to save:', body);
    process.exit(1);
  }
  console.log(`✓ Saved to Redis. History entries: ${body.history?.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
