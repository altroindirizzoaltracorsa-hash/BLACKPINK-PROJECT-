/**
 * Spotify OAuth handler — one-time user authorization flow (Edge Runtime).
 *
 * GET /api/spotify-auth                → redirects to Spotify login
 * GET /api/spotify-auth?code=...       → exchanges code for tokens, stores refresh token in Redis
 *
 * After authorizing once, the refresh token is stored permanently in Redis.
 * fetchCatalogViaSpotifyAPI() in streams.js uses it to mint a fresh access token on
 * every catalog fetch without ever touching the IP-blocked get_access_token endpoint.
 *
 * Setup (one time):
 *   1. In Spotify Developer Dashboard → "Blackpink Catalog" app → Edit → Redirect URIs
 *      Add: https://blinksunited.com/api/spotify-auth
 *   2. Visit https://blinksunited.com/api/spotify-auth?key=<admin-key>
 *   3. Log in with your Spotify account → done.
 */

export const config = { runtime: 'edge' };

import { Redis } from '@upstash/redis';

export const SPOTIFY_USER_CREDS_KEY = 'bp_spotify_user_creds';

const REDIRECT_URI = 'https://blinksunited.com/api/spotify-auth';

export default async function handler(req) {
  const url    = new URL(req.url);
  const id     = process.env.SPOTIFY_CLIENT_ID_2 || process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET_2 || process.env.SPOTIFY_CLIENT_SECRET;

  const code  = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const key   = url.searchParams.get('key');

  if (error) {
    return new Response(`Spotify auth error: ${error}`, { status: 400 });
  }

  // Step 1 — no code yet: redirect to Spotify authorization page
  if (!code) {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret || key !== adminSecret) {
      return new Response('Unauthorized. Visit /api/spotify-auth?key=<admin-key>', { status: 401 });
    }
    const params = new URLSearchParams({
      client_id:     id,
      response_type: 'code',
      redirect_uri:  REDIRECT_URI,
      scope:         'user-read-private',
      state:         'catalog',
    });
    return Response.redirect(`https://accounts.spotify.com/authorize?${params}`, 302);
  }

  // Step 2 — Spotify redirected back with a code: exchange it for tokens
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${btoa(`${id}:${secret}`)}`,
    },
    body: new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  const d = await r.json();

  if (!d.access_token) {
    return new Response(JSON.stringify({ error: 'Token exchange failed', details: d }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // SECOND DATABASE (optional). Upstash suspended the primary on 2026-10-24 for
// exceeding its free monthly bandwidth, and a free plan can neither export nor
// browse a suspended database — the data is intact but unreachable until the
// allowance resets on the 1st. Setting UPSTASH_REDIS_REST_URL_B/_TOKEN_B points
// the endpoints whose data rebuilds itself at a fresh free database so the site
// runs, while the leaderboard keeps using the primary and simply stays down:
// bu_leaderboard_v1 is mutated in place rather than recomputed from Supabase,
// so pointing IT at an empty store would start it at zero and never self-heal.
// Leaving it be means it returns intact with nothing to merge.
// Unset both vars and everything goes back to one database.
function redisClient() {
  const url = process.env.UPSTASH_REDIS_REST_URL_B;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN_B;
  if (url && token) return new Redis({ url, token });
  return Redis.fromEnv();
}

const redis = redisClient();
  await redis.set(SPOTIFY_USER_CREDS_KEY, {
    access_token:  d.access_token,
    refresh_token: d.refresh_token,
    expires_at:    Date.now() + d.expires_in * 1000,
    ts:            Date.now(),
  });

  return new Response(`
    <html><body style="font-family:sans-serif;padding:2rem;max-width:500px">
    <h2>✓ Spotify authorized!</h2>
    <p>Refresh token saved to Redis. The daily catalog fetch will now use your user token automatically — no GitHub Actions or Cloudflare Worker needed.</p>
    <p style="color:#666;font-size:.9rem">Refresh token is permanent (until you revoke access in your Spotify account). Access tokens are refreshed automatically every hour.</p>
    </body></html>
  `, { status: 200, headers: { 'Content-Type': 'text/html' } });
}
