import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const TRACKS = {
  jump:     '5H1sKFMzDeMtXwND3V6hRY',
  shutdown: '6tCd8bPvYnceDG7W9M1RMk',
  ddududu:  '69BIczdH6QMnFx7dsSssN8',
};

const LIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Token via Spotify Client Credentials ─────────────────────────────────────
// accounts.spotify.com/api/token is a proper server-to-server API endpoint.
// Unlike the web-player token URL it is NOT behind Spotify’s WAF and is
// reachable from Vercel without any proxy.
// Whether this token is accepted by the partner GraphQL API is what we’re testing.

async function getClientCredToken() {
  const cached = await redis.get('sp_cc_token');
  if (cached?.token && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const clientId     = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set');

  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res   = await fetch('https://accounts.spotify.com/api/token', {
    method:  'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    'grant_type=client_credentials',
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`cc_token_${res.status}: ${body.slice(0, 200)}`);

  const { access_token, expires_in } = JSON.parse(body);
  await redis.set('sp_cc_token', { token: access_token, expiresAt: Date.now() + expires_in * 1000 });
  return access_token;
}

// ── Partner GraphQL API ─────────────────────────────────────────────────────
// Called directly (no proxy) — api-partner.spotify.com may allow datacenter
// IPs since it’s an API endpoint rather than a user-facing web page.

async function fetchViaPartnerAPI(trackId, token) {
  const variables  = encodeURIComponent(JSON.stringify({ uri: `spotify:track:${trackId}`, locale: '' }));
  const extensions = encodeURIComponent(JSON.stringify({
    persistedQuery: { version: 1, sha256Hash: 'ae85b52abb74d20a4c331d4143d4772c95f34757' },
  }));
  const url = `https://api-partner.spotify.com/pathfinder/v1/query?operationName=getTrack&variables=${variables}&extensions=${extensions}`;

  const res  = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA, Accept: 'application/json', 'App-Platform': 'WebPlayer' },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`partner_${res.status}: ${body.slice(0, 300)}`);

  const data = JSON.parse(body);
  const raw  = data?.data?.trackUnion?.playcount;
  if (!raw) throw new Error(`partner_no_playcount. keys=${JSON.stringify(Object.keys(data?.data || {}))} body=${body.slice(0, 200)}`);
  return Number(raw);
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function getDateLabel(date) {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}
function parseDateLabel(label) {
  const [dd, mm] = label.split('/').map(Number);
  return new Date(Date.UTC(new Date().getUTCFullYear(), mm - 1, dd));
}
function daysBetween(labelA, labelB) {
  return Math.round((parseDateLabel(labelB) - parseDateLabel(labelA)) / 86_400_000);
}

// ── Vercel handler ────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const isCron = req.query.cron === '1';
  if (isCron) {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers['authorization'] !== `Bearer ${secret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const todayLabel  = getDateLabel(new Date());
  const results     = {};
  const debugErrors = [];
  let fetchedLive   = false;

  let token = null;
  try {
    token = await getClientCredToken();
    debugErrors.push('token: OK (client credentials)');
  } catch (e) {
    debugErrors.push(`token: ${e.message}`);
  }

  for (const [name, trackId] of Object.entries(TRACKS)) {
    try {
      const liveKey = `bp_live_${name}`;
      const prevKey = `bp_prev_${name}`;
      const histKey = `bp_hist_${name}`;

      const [cached, prev, hist] = await Promise.all([
        redis.get(liveKey),
        redis.get(prevKey),
        redis.get(histKey),
      ]);

      const history  = hist || [];
      const cacheAge = cached?.ts ? Date.now() - cached.ts : Infinity;
      const cacheValid = !isCron && cacheAge < LIVE_CACHE_TTL_MS;
      let total;

      if (cacheValid) {
        total = cached.total;
      } else {
        if (!token) throw new Error('no token available');
        total       = await fetchViaPartnerAPI(trackId, token);
        fetchedLive = true;
        await redis.set(liveKey, { total, ts: Date.now() });

        if (prev && total > Number(prev.total)) {
          const gap = daysBetween(prev.date, todayLabel);
          if (gap >= 1) {
            const dailyStreams = total - Number(prev.total);
            const existing    = history.find(h => h.date === prev.date);
            if (!existing) {
              const entry = { date: prev.date, streams: dailyStreams };
              if (gap > 1) entry.note = `${gap}-day gap`;
              history.push(entry);
            } else {
              existing.streams = dailyStreams;
            }
            if (history.length > 60) history.shift();
            await redis.set(histKey, history);
          }
        }
        await redis.set(prevKey, { total, date: todayLabel });
      }

      results[name] = { total, history };
    } catch (e) {
      debugErrors.push(`${name}: ${e.message}`);
      const stale   = await redis.get(`bp_live_${name}`);
      const history = await redis.get(`bp_hist_${name}`);
      results[name] = { total: stale?.total || 0, history: history || [] };
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ...results,
    _meta: { updatedAt: new Date().toISOString(), live: fetchedLive, errors: debugErrors },
  });
}
