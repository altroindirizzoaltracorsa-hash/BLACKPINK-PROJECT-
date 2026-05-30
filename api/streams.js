import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const TRACKS = {
  jump:     '5H1sKFMzDeMtXwND3V6hRY',
  shutdown: '6tCd8bPvYnceDG7W9M1RMk',
  ddududu:  '69BIczdH6QMnFx7dsSssN8',
};

// How long a cached live count stays valid before re-fetching from RapidAPI
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

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
  const a = parseDateLabel(labelA);
  const b = parseDateLabel(labelB);
  return Math.round((b - a) / 86400000);
}

async function fetchPlayCount(trackId) {
  const r = await fetch(
    `https://spotify-scraper.p.rapidapi.com/v1/track/metadata?trackId=${trackId}`,
    {
      headers: {
        'x-rapidapi-key': process.env.RAPIDAPI_KEY,
        'x-rapidapi-host': 'spotify-scraper.p.rapidapi.com',
      },
    }
  );
  if (!r.ok) throw new Error(`RapidAPI ${r.status}`);
  const data = await r.json();
  return data?.playCount || 0;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Cron requests must present CRON_SECRET to bypass the cache
  const isCron = req.query.cron === '1';
  if (isCron) {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers['authorization'] !== `Bearer ${secret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const today = new Date();
  const todayLabel = getDateLabel(today);
  const results = {};
  let fetchedLive = false;

  for (const [name, trackId] of Object.entries(TRACKS)) {
    try {
      const liveKey = `bp_live_${name}`; // { total, ts }  — short-lived live count cache
      const prevKey = `bp_prev_${name}`; // { total, date } — yesterday's snapshot for daily diff
      const histKey = `bp_hist_${name}`; // [{ date, streams, note? }]

      // Read all three keys in parallel
      const [cached, prev, hist] = await Promise.all([
        redis.get(liveKey),
        redis.get(prevKey),
        redis.get(histKey),
      ]);

      const history = hist || [];
      let total;

      const cacheAge = cached?.ts ? Date.now() - cached.ts : Infinity;
      const cacheValid = !isCron && cacheAge < CACHE_TTL_MS;

      if (cacheValid) {
        total = cached.total;
      } else {
        // Fresh fetch from RapidAPI, then warm the Redis cache
        total = await fetchPlayCount(trackId);
        fetchedLive = true;
        await redis.set(liveKey, { total, ts: Date.now() });

        // Compute daily delta and append to history
        if (prev && total > Number(prev.total)) {
          const gap = daysBetween(prev.date, todayLabel);
          if (gap >= 1) {
            const dailyStreams = total - Number(prev.total);
            const existing = history.find(h => h.date === prev.date);
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

        // Keep prevKey current so tomorrow's diff is accurate
        await redis.set(prevKey, { total, date: todayLabel });
      }

      results[name] = { total, history };
    } catch (e) {
      console.error(`streams: ${name}:`, e.message);
      results[name] = { total: 0, history: [] };
    }
  }

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  res.status(200).json({
    ...results,
    _meta: { updatedAt: new Date().toISOString(), live: fetchedLive },
  });
}
