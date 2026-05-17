export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=10800'); // Vercel caches for 3 hours

  const ids = {
    jump:     '5H1sKFMzDeMtXwND3V6hRY',
    shutdown: '6tCd8bPvYnceDG7W9M1RMk',
    ddududu:  '69BIczdH6QMnFx7dsSssN8',
  };

  const results = {};
  for (const [name, trackId] of Object.entries(ids)) {
    try {
      const r = await fetch(
        `https://spotify-scraper.p.rapidapi.com/v1/track/metadata?trackId=${trackId}`,
        { headers: {
          'x-rapidapi-key': process.env.RAPIDAPI_KEY,
          'x-rapidapi-host': 'spotify-scraper.p.rapidapi.com'
        }}
      );
      const data = await r.json();
      results[name] = data?.playCount || 0;
    } catch(e) {
      results[name] = 0;
    }
  }
  res.status(200).json(results);
}
