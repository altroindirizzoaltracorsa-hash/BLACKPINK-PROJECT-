import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const TRACKS = {
  jump:     '5H1sKFMzDeMtXwND3V6hRY',
  shutdown: '6tCd8bPvYnceDG7W9M1RMk',
  ddududu:  '69BIczdH6QMnFx7dsSssN8',
};

const LIVE_CACHE_TTL_MS = 60 * 60 * 1000;

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
function yesterdayLabel() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return getDateLabel(d);
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

  const todayLabel = getDateLabel(new Date());
  const results    = {};
  const errors     = {};
  let fetchedLive  = false;

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

      const history   = hist || [];
      const cacheAge  = cached?.ts ? Date.now() - cached.ts : Infinity;
      // Skip cache if we haven't recorded today's history entry yet, even if the
      // live total is recent — otherwise a fetch that straddles midnight stays
      // cached across the day boundary and the daily diff never gets written.
      const needsDailyUpdate = !prev || prev.date !== todayLabel;
      const cacheValid = !isCron && !needsDailyUpdate && cacheAge < LIVE_CACHE_TTL_MS && (cached?.total || 0) > 0;
      let total;

      if (cacheValid) {
        total = cached.total;
      } else {
        const r = await fetch(
          `https://spotify-scraper.p.rapidapi.com/v1/track/metadata?trackId=${trackId}`,
          { headers: {
              'x-rapidapi-key':  process.env.RAPIDAPI_KEY,
              'x-rapidapi-host': 'spotify-scraper.p.rapidapi.com',
          } }
        );
        const data = await r.json();
        if (!r.ok || data?.message) errors[name] = data?.message || `HTTP ${r.status}`;
        total = data?.playCount || 0;
        fetchedLive = true;
        if (total > 0) await redis.set(liveKey, { total, ts: Date.now() });

        const prevTotal = Number(prev?.total || 0);

        if (total > 0 && prevTotal > 0 && total > prevTotal) {
          const gap = daysBetween(prev.date, todayLabel);

          if (gap >= 1) {
            const yLabel = yesterdayLabel();
            const dailyStreams = total - prevTotal;
            const existing = history.find(h => h.date === yLabel);
            if (!existing) {
              const entry = { date: yLabel, streams: dailyStreams };
              if (gap > 1) entry.note = `${gap}-day gap`;
              history.push(entry);
            } else {
              existing.streams = dailyStreams;
            }
            if (history.length > 60) history.shift();
            await redis.set(histKey, history);
          }

          await redis.set(prevKey, { total, date: todayLabel });
        }

        if (total > 0 && !prev) {
          await redis.set(prevKey, { total, date: todayLabel });
        }
      }

      results[name] = { total, history };
    } catch (e) {
      console.error(`streams: ${name}:`, e.message);
      const stale   = await redis.get(`bp_live_${name}`);
      const history = await redis.get(`bp_hist_${name}`);
      results[name] = { total: stale?.total || 0, history: history || [] };
    }
  }

  const prevSnaps = {};
  for (const name of Object.keys(TRACKS)) {
    prevSnaps[name] = await redis.get(`bp_prev_${name}`);
  }

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  res.status(200).json({
    ...results,
    _debug: { hasRapidKey: !!process.env.RAPIDAPI_KEY, errors, live: fetchedLive, prev: prevSnaps, ts: new Date().toISOString() },
  });
}
