// TEMPORARY diagnostic endpoint — checks what it actually takes to get an
// anonymous access token the way open.spotify.com's own web player does,
// so we can tell whether self-hosting a scraper (no RapidAPI) is realistic.
// Delete this file once we have an answer either way.
export default async function handler(req, res) {
  const trackId = req.query.trackId || '5H1sKFMzDeMtXwND3V6hRY'; // JUMP
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const steps = {};

  try {
    // Step 1: load the track page like a browser would, to pick up any cookies.
    const pageRes = await fetch(`https://open.spotify.com/track/${trackId}`, {
      headers: { 'User-Agent': userAgent },
    });
    const rawSetCookie = pageRes.headers.get('set-cookie') || '';
    const cookieHeader = rawSetCookie.split(',').map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
    steps.pageLoad = { status: pageRes.status, gotCookies: !!cookieHeader };

    // Step 2: try the same anonymous-token endpoint the web player calls.
    const tokenRes = await fetch('https://open.spotify.com/get_access_token?reason=transport&productType=web_player', {
      headers: {
        'User-Agent': userAgent,
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
    });
    const tokenBody = await tokenRes.text();
    steps.tokenFetch = { status: tokenRes.status, body: tokenBody.slice(0, 1500) };

    res.status(200).json({ trackId, steps });
  } catch (e) {
    res.status(500).json({ error: e.message, steps });
  }
}
