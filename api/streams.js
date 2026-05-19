import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const TRACKS = {
  jump:     '5H1sKFMzDeMtXwND3V6hRY',
  shutdown: '6tCd8bPvYnceDG7W9M1RMk',
  ddududu:  '69BIczdH6QMnFx7dsSssN8',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=10800');

  const results = {};

  for (const [name, trackId] of Object.entries(TRACKS)) {
    try {
      const r = await fetch(
        `https://spotify-scraper.p.rapidapi.com/v1/track/metadata?trackId=${trackId}`,
        { headers: {
          'x-rapidapi-key': process.env.RAPIDAPI_KEY,
          'x-rapidapi-host': 'spotify-scraper.p.rapidapi.com'
        }}
      );
      const data = await r.json();
      const total = data?.playCount || 0;

      const prevKey = `bp_prev_${name}`;
      const histKey = `bp_hist_${name}`;

      // Get previous snapshot: { total, date }
      const prev = await redis.get(prevKey);

      let dailyStreams = null;
      let entryDate = null;

      if (prev && total > Number(prev.total)) {
        dailyStreams = total - Number(prev.total);
        // Use the date the previous snapshot was taken — that's the day those streams happened
        entryDate = prev.date;
      }

      // Save today's snapshot with today's date
      const todayLabel = new Date().toISOString().slice(5, 10).replace('-', '/');
      await redis.set(prevKey, { total, date: todayLabel });

      // Add to history if we have a daily count and date
      if (dailyStreams && entryDate) {
        const hist = (await redis.get(histKey)) || [];
        const alreadyLogged = hist.find(h => h.date === entryDate);
        if (!alreadyLogged) {
          hist.push({ date: entryDate, streams: dailyStreams });
          if (hist.length > 60) hist.shift();
          await redis.set(histKey, hist);
        }
      }

      const hist = (await redis.get(histKey)) || [];
      results[name] = { total, history: hist };

    } catch(e) {
      results[name] = { total: 0, history: [] };
    }
  }

  res.status(200).json(results);
}
