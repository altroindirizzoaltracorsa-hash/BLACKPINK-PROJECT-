import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const REDIRECT_URI = 'https://blackpink-project.vercel.app/api/spotify-oauth-callback';

export default async function handler(req, res) {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Spotify authorization failed: ${error}`);
  if (!code || !state) return res.status(400).send('Missing code or state');

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: REDIRECT_URI,
    }).toString(),
  });
  const data = await r.json();
  if (!data.refresh_token) {
    return res.status(500).send(`Failed to get refresh token: ${data.error_description || JSON.stringify(data)}`);
  }

  await redis.set(`spotify_refresh_token:${state}`, data.refresh_token);
  res.status(200).send(`Connected ${state}. You can close this tab.`);
}
