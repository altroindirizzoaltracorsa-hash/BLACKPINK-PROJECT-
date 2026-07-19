/**
 * Cloudflare Worker — BLACKPINK Spotify catalog total
 *
 * Deploy this in your Cloudflare dashboard (Workers & Pages → Create Worker → paste).
 *
 * Environment variables to set in the Worker's Settings → Variables:
 *   WORKER_KEY            — any long random string you choose (used as the API key)
 *   SPOTIFY_CLIENT_ID     — your Spotify app Client ID   (use the "Blackpink Catalog" app)
 *   SPOTIFY_CLIENT_SECRET — your Spotify app Client Secret
 *
 * Then in Vercel, add:
 *   SPOTIFY_WORKER_URL    — https://<your-worker>.workers.dev
 *   SPOTIFY_WORKER_KEY    — same value as WORKER_KEY above
 */

const ARTIST_ID = '41MozSoPIsD1dJM0CLPjZF';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PARTNER_HASH = 'ae85b52abb74d20a4c331d4143d4772c95f34757a435d55406e6a2f17ad41c42';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

// Spotify anon token — works from Cloudflare IPs (not blocked like Vercel/AWS)
async function getAnonToken() {
  const r = await fetch(
    'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
    { headers: { 'User-Agent': UA, 'Accept': 'application/json' } },
  );
  const text = await r.text();
  if (!r.ok || !text.trimStart().startsWith('{')) {
    throw new Error(`anon-token ${r.status}: ${text.slice(0, 200)}`);
  }
  const d = JSON.parse(text);
  if (!d.accessToken) throw new Error(`accessToken missing (got: ${text.slice(0, 200)})`);
  return d.accessToken;
}

// Client-credentials token — used only for the official albums/tracks API
async function getClientToken(clientId, clientSecret) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`client-token ${r.status}: ${await r.text()}`);
  const d = await r.json();
  if (!d.access_token) throw new Error('client token: access_token missing');
  return d.access_token;
}

// Enumerate all BLACKPINK track IDs via the official Spotify API
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
  return ids;
}

// Query the Spotify partner API for a single track's play count
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

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }

    // Auth: key in query string or x-worker-key header
    const url = new URL(request.url);
    const key = url.searchParams.get('key') || request.headers.get('x-worker-key');
    if (!env.WORKER_KEY || key !== env.WORKER_KEY) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: JSON_HEADERS });
    }

    // Validate Spotify credentials are set
    if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
      return new Response(
        JSON.stringify({ error: 'SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set in Worker env' }),
        { status: 500, headers: JSON_HEADERS },
      );
    }

    try {
      // Fetch anon token and client token in parallel
      const [anonToken, clientToken] = await Promise.all([
        getAnonToken(),
        getClientToken(env.SPOTIFY_CLIENT_ID, env.SPOTIFY_CLIENT_SECRET),
      ]);

      // Get all track IDs using the client-credentials token
      const trackIds = await getAllTrackIds(clientToken);
      if (!trackIds.length) {
        return new Response(JSON.stringify({ error: 'No track IDs found' }), { status: 502, headers: JSON_HEADERS });
      }

      // Sum play counts in batches of 20 (parallel within each batch)
      let total = 0, failed = 0;
      for (let i = 0; i < trackIds.length; i += 20) {
        const batch = trackIds.slice(i, i + 20);
        const counts = await Promise.all(
          batch.map(id => getPlayCount(id, anonToken).catch(() => { failed++; return 0; })),
        );
        total += counts.reduce((s, c) => s + c, 0);
      }

      if (total === 0) {
        return new Response(
          JSON.stringify({ error: 'All play counts returned 0 — anon token may be invalid or partner API changed', trackCount: trackIds.length }),
          { status: 502, headers: JSON_HEADERS },
        );
      }

      return new Response(
        JSON.stringify({ total, trackCount: trackIds.length, failed, source: 'cloudflare-worker' }),
        { status: 200, headers: JSON_HEADERS },
      );
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: JSON_HEADERS });
    }
  },
};
