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

// Retry transient failures with backoff so a lone network blip or a 5xx doesn't
// silently DROP a real play (which would undercount the campaign). Safe to retry
// because the ingest endpoint is idempotent — it upserts on a unique
// (account, track, start-second) key, so a re-sent scrobble is a no-op, never a
// duplicate. Only transient statuses are retried; a 4xx (e.g. 401 bad token) or
// an app-level {ok:false} is permanent and throws immediately.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [800, 2400]; // wait before attempt 2, then attempt 3

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function scrobble(endpoint, token, track, timestamp, account) {
  const body = JSON.stringify({
    token,
    artist: track.artist,
    title: track.title,
    album: track.album || '',
    duration: track.duration || 0,
    timestamp,
    account: account || '',
  });

  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1] || 2400);
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (e) {
      lastErr = e; // network error — transient, retry
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok !== false) return data;
    // Permanent failure (non-retryable status, or app-level ok:false): give up.
    if (!RETRYABLE_STATUS.has(res.status)) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    lastErr = new Error(data.error || `HTTP ${res.status}`); // transient — retry
  }
  throw lastErr || new Error('scrobble failed after retries');
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
