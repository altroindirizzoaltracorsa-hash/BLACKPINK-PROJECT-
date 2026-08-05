/*
 * blinksunited.com direct target.
 *
 * Instead of a public scrobbling service, this posts each accepted scrobble
 * straight to blinksunited's own ingest endpoint, identified by a per-install
 * profile token. All Spotify accounts running in this browser funnel to the
 * one blinksunited profile the token belongs to.
 *
 * This bypasses Last.fm entirely, so it is NOT subject to Last.fm's anti-spam
 * filtering — the trade-off is that the counts are self-reported and only as
 * trustworthy as the site chooses to make them.
 */

export async function scrobble(endpoint, token, track, timestamp, account) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      artist: track.artist,
      title: track.title,
      album: track.album || '',
      duration: track.duration || 0,
      timestamp,
      account: account || '',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

// Optional connectivity/token check for the options page.
export async function validateToken(endpoint, token) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, validate: true }),
    });
    const data = await res.json().catch(() => ({}));
    return { valid: !!(res.ok && data.valid), profile: data.profile || null, error: data.error };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}
