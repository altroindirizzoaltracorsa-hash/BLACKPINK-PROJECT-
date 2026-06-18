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

function basicAuthHeader() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set');
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

async function getClientCredentialsToken() {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': basicAuthHeader(),
    },
    body: 'grant_type=client_credentials',
  });
  const data = await r.json();
  if (!data.access_token) throw new Error(data.error_description || 'Failed to get Spotify access token');
  return data.access_token;
}

// Client Credentials tokens can't reliably list another account's playlists
// (Spotify intermittently/consistently 403s /v1/users/{id}/playlists for them).
// If that account has gone through the one-time OAuth consent at
// /api/spotify-oauth-start, use its stored refresh token + /v1/me/playlists instead.
async function getUserAccessToken(accountId) {
  const refreshToken = await redis.get(`spotify_refresh_token:${accountId}`);
  if (!refreshToken) return null;

  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': basicAuthHeader(),
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
  });
  const data = await r.json();
  if (!data.access_token) return null;
  if (data.refresh_token) await redis.set(`spotify_refresh_token:${accountId}`, data.refresh_token);
  return data.access_token;
}

function extractMatches(items, accountId) {
  const matches = [];
  for (const pl of items || []) {
    const m = pl?.name?.match(DAY_PATTERN);
    if (m) matches.push({ id: pl.id, url: pl.external_urls?.spotify, name: pl.name, day: Number(m[1]), account: accountId });
  }
  return matches;
}

async function findCandidatePlaylists(accountId, clientCredToken) {
  const userToken = await getUserAccessToken(accountId);
  const url = userToken
    ? 'https://api.spotify.com/v1/me/playlists?limit=50'
    : `https://api.spotify.com/v1/users/${encodeURIComponent(accountId)}/playlists?limit=50`;
  const mode = userToken ? 'oauth' : 'client_credentials';

  const r = await fetch(url, {
    headers: { 'Authorization': `Bearer ${userToken || clientCredToken}` },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    return { matches: [], account: accountId, mode, status: r.status, error: body.slice(0, 200) };
  }
  const data = await r.json();
  return {
    matches: extractMatches(data.items, accountId),
    account: accountId,
    mode,
    status: r.status,
    namesSeen: (data.items || []).map(pl => pl.name),
  };
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const debugKey = process.env.SYNC_PLAYLIST_DEBUG_KEY;
  const auth = req.headers['authorization'];

  // Temporary: visit ?diag=1 (no auth needed) to see why a debug key isn't matching,
  // without exposing the actual secret values. Remove once SYNC_PLAYLIST_DEBUG_KEY works.
  if (req.query.diag) {
    return res.status(200).json({
      hasDebugKeyEnv: !!debugKey,
      debugKeyLength: debugKey ? debugKey.length : 0,
      receivedAuthHeader: auth ? `len ${auth.length}: "${auth}"` : null,
      expectedIfMatched: debugKey ? `Bearer ${debugKey}` : null,
    });
  }

  // Accepts CRON_SECRET (used by the scheduled cron) or a separate debug key
  // (for manually triggering a test run) so testing never requires touching
  // CRON_SECRET, which is shared with the cron-scrobbles GitHub Action.
  const authorized = !secret || auth === `Bearer ${secret}` || (debugKey && auth === `Bearer ${debugKey}`);
  if (!authorized) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const accountIds = getAccountIds();
  if (!accountIds.length) {
    return res.status(200).json({ ok: false, error: 'No accounts configured in SPOTIFY_PLAYLIST_ACCOUNTS' });
  }

  try {
    const token = await getClientCredentialsToken();
    const results = await Promise.all(accountIds.map(id => findCandidatePlaylists(id, token)));
    const allMatches = results.flatMap(r => r.matches);
    const accountDiagnostics = results.map(({ matches, ...rest }) => rest);

    if (!allMatches.length) {
      return res.status(200).json({ ok: false, error: 'No matching playlist found on any configured account', checked: accountIds, accountDiagnostics });
    }

    allMatches.sort((a, b) => b.day - a.day);
    const best = allMatches[0];

    await redis.set(KEY, { id: best.id, url: best.url, updatedAt: Date.now(), day: best.day, account: best.account });

    res.status(200).json({ ok: true, chosen: best, candidates: allMatches, accountDiagnostics });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
