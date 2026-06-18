const REDIRECT_URI = 'https://blackpink-project.vercel.app/api/spotify-oauth-callback';

export default function handler(req, res) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const account = req.query.account;
  if (!clientId) return res.status(500).json({ error: 'SPOTIFY_CLIENT_ID not set' });
  if (!account) return res.status(400).json({ error: 'Missing ?account=<spotify_user_id> query param' });

  const url = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: 'playlist-read-private playlist-read-collaborative',
    state: account,
  }).toString();

  res.writeHead(302, { Location: url });
  res.end();
}
