import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const TRACKS = {
  jump:     '5H1sKFMzDeMtXwND3V6hRY',
  shutdown: '6tCd8bPvYnceDG7W9M1RMk',
  ddududu:  '69BIczdH6QMnFx7dsSssN8',
};

const LIVE_CACHE_TTL_MS = 60 * 60 * 1000;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function getAnonToken() {
  const cached = await redis.get('sp_anon_token');
  if (cached?.token && cached.expiresAt > Date.now() + 120_000) {
    return cached.token;
  }
  const res = await fetch(
    'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
    {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': 'sp_t=1',
      },
    }
  );
  // Surface the raw response body so we can debug what Spotify returns
  const body = await res.text();
  if (!res.ok) throw new Error(`token_${res.status}: ${body.slice(0, 300)}`);
  const parsed = JSON.parse(body);
  if (!parsed.accessToken) throw new Error(`token_no_key: ${body.slice(0, 300)}`);
  await redis.set('sp_anon_token', { token: parsed.accessToken, expiresAt: parsed.accessTokenExpirationTimestampMs });
  return parsed.accessToken;
}

async function fetchViaPartnerAPI(trackId, token) {
  const variables  = encodeURIComponent(JSON.stringify({ uri: `spotify:track:${trackId}`, locale: '' }));
  const extensions = encodeURIComponent(JSON.stringify({
    persistedQuery: { version: 1, sha256Hash: 'ae85b52abb74d20a4c331d4143d4772c95f34757' },
  }));
  const res = await fetch(
    `https://api-partner.spotify.com/pathfinder/v1/query?operationName=getTrack&variables=${variables}&extensions=${extensions}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': UA,
        'Accept': 'application/json',
        'App-Platform': 'WebPlayer',
      },
    }
  );
  const body = await res.text();
  if (res.status === 401) {
    await redis.del('sp_anon_token');
    throw new Error(`partner_401: ${body.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`partner_${res.status}: ${body.slice(0, 200)}`);
  const data = JSON.parse(body);
  const raw  = data?.data?.trackUnion?.playcount;
  if (!raw) throw new Error(`partner_no_playcount: ${body.slice(0, 300)}`);
  return Number(raw);
}

async function fetchViaHTMLScrape(trackId) {
  const res = await fetch(`https://open.spotify.com/track/${trackId}`, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`scrape_${res.status}`);
  const html = await res.text();
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s);
  if (!match) throw new Error(`scrape_no_next_data (page_len=${html.length}, first200=${html.slice(0,200).replace(/\n/g,' ')}`);
  const nextData = JSON.parse(match[1]);
  const entity   = nextData?.props?.pageProps?.state?.data?.entity;
  const raw      = entity?.playcount ?? entity?.play_count;
  if (!raw) throw new Error(`scrape_no_playcount: keys=${JSON.stringify(Object.keys(entity||{}))}`);
  return Number(raw);
}

async function fetchPlayCount(trackId, token) {
  const errs = [];
  if (token) {
    try {
      return await fetchViaPartnerAPI(trackId, token);
    } catch (e) {
      errs.push(`partner: ${e.message}`);
    }
  } else {
    errs.push('partner: skipped (no token)');
  }
  try {
    return await fetchViaHTMLScrape(trackId);
  } catch (e) {
    errs.push(`scrape: ${e.message}`);
  }
  throw new Error(errs.join(' | '));
}

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
    token = await getAnonToken();
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
        total       = await fetchPlayCount(trackId, token);
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
