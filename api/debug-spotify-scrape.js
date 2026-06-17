// TEMPORARY diagnostic endpoint — checks whether Spotify's public track page
// exposes the play count directly (no RapidAPI middleman), and whether it's
// reachable at all without being bot-blocked. Delete this file once we have
// an answer either way.
export default async function handler(req, res) {
  const trackId = req.query.trackId || '5H1sKFMzDeMtXwND3V6hRY'; // JUMP
  const url = `https://open.spotify.com/track/${trackId}`;

  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const html = await r.text();

    const blockSignals = ['Just a moment', 'Enable JavaScript', 'captcha', 'cf-browser-verification', 'Access Denied'];
    const blocked = blockSignals.filter(s => html.toLowerCase().includes(s.toLowerCase()));

    const patterns = {
      playcount_json: /"playcount"\s*:\s*"?(\d[\d,]*)"?/i,
      playCount_json: /"playCount"\s*:\s*"?(\d[\d,]*)"?/i,
      play_count_json: /"play_count"\s*:\s*"?(\d[\d,]*)"?/i,
      totalPlays_json: /"totalPlays"\s*:\s*"?(\d[\d,]*)"?/i,
      plays_text: /([\d,]{6,})\s*plays/i,
    };
    const matches = {};
    for (const [name, re] of Object.entries(patterns)) {
      const m = html.match(re);
      if (m) matches[name] = { value: m[1], context: html.slice(Math.max(0, m.index - 80), m.index + 80) };
    }

    const scriptTagIds = [...html.matchAll(/<script[^>]*\bid="([^"]+)"/g)].map(m => m[1]);

    res.status(200).json({
      requestedUrl: url,
      finalUrl: r.url,
      httpStatus: r.status,
      htmlLength: html.length,
      likelyBlocked: blocked.length > 0 ? blocked : null,
      matches,
      scriptTagIds,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
