import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const KEY = 'bp_current_playlist';
const OAUTH_REDIRECT_URI = 'https://blinksunited.com/api/spotify-oauth-callback';

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

// /v1/users/{id}/playlists only ever returns that user's PUBLIC playlists, so
// any valid token can read it — it doesn't require that user's own consent.
// Client Credentials tokens blanket-403 here (Spotify Development Mode catalog
// restriction), but an OAuth user token from a *different* connected account
// works, since OAuth tokens aren't subject to that restriction.
async function findCandidatePlaylists(accountId, browseToken, clientCredToken) {
  const userToken = await getUserAccessToken(accountId);
  const url = userToken
    ? 'https://api.spotify.com/v1/me/playlists?limit=50'
    : `https://api.spotify.com/v1/users/${encodeURIComponent(accountId)}/playlists?limit=50`;
  const mode = userToken ? 'oauth' : (browseToken ? 'oauth-browse' : 'client_credentials');
  const token = userToken || browseToken || clientCredToken;

  const r = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
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

async function getAnyUserToken(accountIds) {
  for (const id of accountIds) {
    const token = await getUserAccessToken(id);
    if (token) return token;
  }
  return null;
}

// /api/spotify-oauth-start and /api/spotify-oauth-callback are rewritten to this
// same function (vercel.json) to stay under the Hobby plan's 12-function cap —
// they're handled here based on query params rather than separate files.
function startOAuth(req, res) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const account = req.query.account;
  if (!clientId) return res.status(500).json({ error: 'SPOTIFY_CLIENT_ID not set' });
  if (!account) return res.status(400).json({ error: 'Missing ?account=<spotify_user_id> query param' });

  const url = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: 'playlist-read-private playlist-read-collaborative',
    state: account,
  }).toString();

  res.writeHead(302, { Location: url });
  res.end();
}

async function handleOAuthCallback(req, res) {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Spotify authorization failed: ${error}`);
  if (!code || !state) return res.status(400).send('Missing code or state');

  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': basicAuthHeader(),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: OAUTH_REDIRECT_URI,
    }).toString(),
  });
  const data = await r.json();
  if (!data.refresh_token) {
    return res.status(500).send(`Failed to get refresh token: ${data.error_description || JSON.stringify(data)}`);
  }

  await redis.set(`spotify_refresh_token:${state}`, data.refresh_token);
  res.status(200).send(`Connected ${state}. You can close this tab.`);
}

export default async function handler(req, res) {
  if (req.query.code || req.query.error) {
    return handleOAuthCallback(req, res);
  }
  if (req.query.account) {
    return startOAuth(req, res);
  }

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
    const [clientCredToken, browseToken] = await Promise.all([
      getClientCredentialsToken(),
      getAnyUserToken(accountIds),
    ]);
    const results = await Promise.all(accountIds.map(id => findCandidatePlaylists(id, browseToken, clientCredToken)));
    const allMatches = results.flatMap(r => r.matches);
    const accountDiagnostics = results.map(({ matches, ...rest }) => rest);

    if (!allMatches.length) {
      return res.status(200).json({ ok: false, error: 'No matching playlist found on any configured account', checked: accountIds, accountDiagnostics });
    }

    allMatches.sort((a, b) => b.day - a.day);
    const best = allMatches[0];

    // Never let a flaky scan (stale token, privacy-toggle lag, etc.) regress the
    // live playlist to a lower day number than what's already published.
    const current = await redis.get(KEY);
    const currentDay = current?.day || 0;
    if (best.day < currentDay) {
      return res.status(200).json({
        ok: false,
        error: `Found Day ${best.day} but Day ${currentDay} is already live — refusing to go backwards`,
        candidates: allMatches,
        accountDiagnostics,
      });
    }

    await redis.set(KEY, { id: best.id, url: best.url, updatedAt: Date.now(), day: best.day, account: best.account });

    res.status(200).json({ ok: true, chosen: best, candidates: allMatches, accountDiagnostics });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
