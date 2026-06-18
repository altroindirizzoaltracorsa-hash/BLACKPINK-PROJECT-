import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const KEY = 'bp_current_playlist';

// Playlists are named like "JUMP -> 1B [Day 21]" — the day number only ever
// increases through a campaign, so across however many candidate accounts
// currently host a live playlist, the highest day number is the newest one.
const DAY_PATTERN = /\[Day\s*(\d+)\]/i;

function getAccountIds() {
  return (process.env.SPOTIFY_PLAYLIST_ACCOUNTS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

async function getAccessToken() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set');

  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  const data = await r.json();
  if (!data.access_token) throw new Error(data.error_description || 'Failed to get Spotify access token');
  return data.access_token;
}

async function findCandidatePlaylists(accountId, token) {
  const matches = [];
  const r = await fetch(`https://api.spotify.com/v1/users/${encodeURIComponent(accountId)}/playlists?limit=50`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!r.ok) return matches;
  const data = await r.json();
  for (const pl of data.items || []) {
    const m = pl?.name?.match(DAY_PATTERN);
    if (m) matches.push({ id: pl.id, url: pl.external_urls?.spotify, name: pl.name, day: Number(m[1]), account: accountId });
  }
  return matches;
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['authorization'] !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const accountIds = getAccountIds();
  if (!accountIds.length) {
    return res.status(200).json({ ok: false, error: 'No accounts configured in SPOTIFY_PLAYLIST_ACCOUNTS' });
  }

  try {
    const token = await getAccessToken();
    const results = await Promise.all(accountIds.map(id => findCandidatePlaylists(id, token)));
    const allMatches = results.flat();

    if (!allMatches.length) {
      return res.status(200).json({ ok: false, error: 'No matching playlist found on any configured account', checked: accountIds });
    }

    allMatches.sort((a, b) => b.day - a.day);
    const best = allMatches[0];

    await redis.set(KEY, { id: best.id, url: best.url, updatedAt: Date.now(), day: best.day, account: best.account });

    res.status(200).json({ ok: true, chosen: best, candidates: allMatches });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
