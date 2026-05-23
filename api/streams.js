import { Redis } from '@upstash/redis';
const redis = Redis.fromEnv();

const TRACKS = {
  jump:     '5H1sKFMzDeMtXwND3V6hRY',
  shutdown: '6tCd8bPvYnceDG7W9M1RMk',
  ddududu:  '69BIczdH6QMnFx7dsSssN8',
};

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=10800');

  const today = new Date();
  const todayLabel = getDateLabel(today);
  const results = {};

  for (const [name, trackId] of Object.entries(TRACKS)) {
    try {
      const r = await fetch(
        `https://spotify-scraper.p.rapidapi.com/v1/track/metadata?trackId=${trackId}`,
        {
          headers: {
            'x-rapidapi-key': process.env.RAPIDAPI_KEY,
            'x-rapidapi-host': 'spotify-scraper.p.rapidapi.com',
          },
        }
      );
      const data = await r.json();
      const total = data?.playCount || 0;

      const prevKey = `bp_prev_${name}`;
      const histKey = `bp_hist_${name}`;

      // Read previous snapshot BEFORE overwriting it
      const prev = await redis.get(prevKey);
      const hist = (await redis.get(histKey)) || [];

      if (prev && total > Number(prev.total)) {
        const dailyStreams = total - Number(prev.total);
        const gap = daysBetween(prev.date, todayLabel);

        if (gap >= 1) {
          // Label under prev.date — that's the day whose streams just completed
          const entryDate = prev.date;
          const existing = hist.find(h => h.date === entryDate);
          if (!existing) {
            const entry = { date: entryDate, streams: dailyStreams };
            if (gap > 1) entry.note = `${gap}-day gap`;
            hist.push(entry);
          } else {
            // Update if we get a better reading later in the same cycle
            existing.streams = dailyStreams;
          }

          if (hist.length > 60) hist.shift();
          await redis.set(histKey, hist);
        }
      }

      // Save today's snapshot AFTER the diff is computed and logged
      await redis.set(prevKey, { total, date: todayLabel });

      results[name] = { total, history: hist };
    } catch (e) {
      results[name] = { total: 0, history: [] };
    }
  }

  res.status(200).json(results);
}
