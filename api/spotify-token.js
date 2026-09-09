export const config = { runtime: 'edge' };

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

export default async function handler(req) {
  // Try 1: anon token from Spotify (works if not IP-blocked)
  try {
    const r = await fetch(
      'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
      { headers: { 'User-Agent': UA, 'Accept': 'application/json' } }
    );
    const text = await r.text();
    if (r.ok && text.trimStart().startsWith('{')) {
      const d = JSON.parse(text);
      if (d.accessToken) return new Response(JSON.stringify({ accessToken: d.accessToken, source: 'anon' }), { status: 200, headers: CORS });
    }
  } catch {}

  // Try 2: client credentials token (always works from server, no IP restriction)
  const id     = process.env.SPOTIFY_CLIENT_ID_2     || process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET_2 || process.env.SPOTIFY_CLIENT_SECRET;
  if (id && secret) {
    try {
      const r = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${btoa(`${id}:${secret}`)}`,
        },
        body: 'grant_type=client_credentials',
      });
      const d = await r.json();
      if (d.access_token) return new Response(JSON.stringify({ accessToken: d.access_token, source: 'client-credentials' }), { status: 200, headers: CORS });
    } catch {}
  }

  return new Response(JSON.stringify({ error: 'Could not obtain Spotify token' }), { status: 502, headers: CORS });
}
