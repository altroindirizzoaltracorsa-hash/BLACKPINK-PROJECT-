// Admin-only endpoint: returns per-user control song scrobble counts
// Control song identity lives in env vars — never exposed to client JS
// Usage: GET /api/control-ranking?key=ADMIN_SECRET&users=user1,user2,...

const LASTFM_KEY = '666b8ef2f3cc360fbc20df275fba2981';
const LASTFM_BASE = 'https://ws.audioscrobbler.com/2.0/';

// Replicate Italy 2am reset logic from index.html
// Day boundary = 00:00 UTC — Spotify's own rollover, and the same boundary
// index.html buckets scores against. It was computed as 2 AM Rome, which equals
// 00:00 UTC only on summer time; when DST ended on 2026-10-25 it slid to 01:00
// UTC and stopped matching. No hour or city is named here — the reset is
// formatted in the reader's local clock where it is displayed.
function getTimeBounds() {
  const n = new Date();
  const dayStart = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 86400000);
  const dow = dayStart.getUTCDay();
  const daysToMon = dow === 0 ? 6 : dow - 1;
  const weekStart = new Date(dayStart.getTime() - daysToMon * 86400000);
  return {
    dayFrom:  Math.floor(dayStart  / 1000),
    dayTo:    Math.floor(dayEnd    / 1000),
    weekFrom: Math.floor(weekStart / 1000),
    weekTo:   Math.floor(dayEnd    / 1000),
  };
}

// Normalize a string for loose matching: lowercase, strip non-alphanumeric except spaces
function norm(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

// Count how many times artist/track appears in a time window,
// paginating until we have all records (capped at 5 pages).
async function countScrobbles(username, artist, track, from, to) {
  const artistNorm = norm(artist);
  const trackNorm  = norm(track);
  let count = 0;
  let page  = 1;
  const maxPages = 5;
  const samples = []; // first few matched track names for debug

  while (page <= maxPages) {
    const url = `${LASTFM_BASE}?method=user.getRecentTracks&user=${encodeURIComponent(username)}&from=${from}&to=${to}&limit=200&page=${page}&api_key=${LASTFM_KEY}&format=json`;
    let d;
    try {
      const r = await fetch(url);
      d = await r.json();
    } catch(e) { break; }

    const attr   = d?.recenttracks?.['@attr'] || {};
    const tracks = d?.recenttracks?.track || [];
    if (!tracks.length) break;

    for (const t of tracks) {
      if (t['@attr']?.nowplaying) continue;
      const aNorm = norm(t.artist?.['#text']);
      const tNorm = norm(t.name);
      // Artist must match exactly; track uses bidirectional contains to handle
      // cases where Last.fm adds/omits a concert subtitle vs the env var value.
      const artistMatch = aNorm === artistNorm;
      const trackMatch  = tNorm === trackNorm || tNorm.includes(trackNorm) || trackNorm.includes(tNorm);
      if (artistMatch && trackMatch) {
        count++;
        if (samples.length < 2) samples.push(`${t.artist?.['#text']} — ${t.name}`);
      }
    }

    const total      = parseInt(attr.totalPages || '1', 10);
    const fetchedAll = tracks.length < 200 || page >= total;
    if (fetchedAll) break;
    page++;
  }
  return { count, samples };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Auth
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret || req.query.key !== adminSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Config
  const artist = process.env.CONTROL_ARTIST;
  const track  = process.env.CONTROL_TRACK;
  if (!artist || !track) {
    return res.status(500).json({ error: 'CONTROL_ARTIST / CONTROL_TRACK env vars not set' });
  }

  // Users list from query param
  const raw = req.query.users || '';
  const users = raw.split(',').map(u => u.trim()).filter(Boolean);
  if (!users.length) {
    return res.status(400).json({ error: 'No users supplied' });
  }

  const { dayFrom, dayTo, weekFrom, weekTo } = getTimeBounds();

  // Fetch in batches of 4 to avoid hammering Last.fm
  const results = [];
  const batchSize = 4;
  for (let i = 0; i < users.length; i += batchSize) {
    const batch = users.slice(i, i + batchSize);
    const batchRes = await Promise.all(batch.map(async username => {
      const [daily, weekly] = await Promise.all([
        countScrobbles(username, artist, track, dayFrom, dayTo),
        countScrobbles(username, artist, track, weekFrom, weekTo),
      ]);
      return { username, daily: daily.count, weekly: weekly.count, samples: weekly.samples };
    }));
    results.push(...batchRes);
  }

  results.sort((a, b) => b.weekly - a.weekly || b.daily - a.daily);

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    users: results,
    song: `${artist} — ${track}`,
    _debug: { artistNorm: norm(artist), trackNorm: norm(track) },
  });
}
