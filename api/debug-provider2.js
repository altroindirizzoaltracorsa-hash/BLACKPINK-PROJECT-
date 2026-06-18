// TEMPORARY diagnostic endpoint — calls the spotify-scraper-api provider
// directly (bypassing the spotify-scraper fallback chain) to confirm the
// new RAPIDAPI_KEYS_API2 key actually works end-to-end.
// Delete this file once we have an answer either way.
export default async function handler(req, res) {
  const trackId = req.query.trackId || '5H1sKFMzDeMtXwND3V6hRY'; // JUMP
  const keys = (process.env.RAPIDAPI_KEYS_API2 || '').split(',').map(k => k.trim()).filter(Boolean);

  if (keys.length === 0) {
    return res.status(200).json({ error: 'RAPIDAPI_KEYS_API2 is not set' });
  }

  try {
    const r = await fetch(
      `https://spotify-scraper-api.p.rapidapi.com/api/v1/track/info?track_id=${trackId}`,
      { headers: { 'x-rapidapi-key': keys[0], 'x-rapidapi-host': 'spotify-scraper-api.p.rapidapi.com' } }
    );
    const data = await r.json();
    res.status(200).json({ trackId, httpStatus: r.status, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
