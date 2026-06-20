import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const KEY = 'bp_current_playlist';
const PENDING_KEY = 'bp_pending_playlist';

function extractPlaylistId(url) {
  const match = String(url || '').match(/playlist[/:]([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

// Replicate the Italy 2am reset logic from index.html / control-ranking.js
function lastSunday(year, month) {
  const d = new Date(Date.UTC(year, month + 1, 0));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}
function getItalyOffset() {
  const now = new Date();
  const year = now.getUTCFullYear();
  return (now >= lastSunday(year, 2) && now < lastSunday(year, 9)) ? 2 : 1;
}
// Returns the ms timestamp of the next 2am-Italy boundary after now.
function nextItaly2am() {
  const offset = getItalyOffset();
  const it = new Date(Date.now() + offset * 3600 * 1000);
  const y = it.getUTCFullYear(), m = it.getUTCMonth(), d = it.getUTCDate();
  const hour = it.getUTCHours();
  let dayStart = new Date(Date.UTC(y, m, d, 2 - offset, 0, 0));
  if (hour < 2) dayStart = new Date(dayStart.getTime() - 86400000);
  return dayStart.getTime() + 86400000;
}

// A manually-saved link defaults to staging in PENDING_KEY instead of going
// live immediately, so the admin can load tomorrow's playlist in advance
// without it replacing today's. Promote it here, lazily, on every read.
async function promotePendingIfDue() {
  const pending = await redis.get(PENDING_KEY);
  if (!pending || Date.now() < pending.publishAt) return;
  await redis.set(KEY, { id: pending.id, url: pending.url, updatedAt: Date.now() });
  await redis.del(PENDING_KEY);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    await promotePendingIfDue();
    const adminSecret = process.env.ADMIN_SECRET;

    // ?key= doubles as the auth check for the "Today's Playlist" admin panel —
    // wrong key gets a 401 instead of silently falling back to the public response.
    if (req.query.key) {
      if (!adminSecret || req.query.key !== adminSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const [data, pending] = await Promise.all([redis.get(KEY), redis.get(PENDING_KEY)]);
      return res.status(200).json({ ...(data || {}), pending: pending || null });
    }

    const data = await redis.get(KEY);
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json(data || {});
  }

  if (req.method === 'POST') {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret || req.query.key !== adminSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const id = extractPlaylistId(req.body?.url);
    if (!id) return res.status(400).json({ error: 'Could not find a playlist ID in that link' });

    if (req.body?.publishNow) {
      await redis.del(PENDING_KEY);
      const data = { id, url: req.body.url, updatedAt: Date.now() };
      await redis.set(KEY, data);
      return res.status(200).json({ live: data });
    }

    const pending = { id, url: req.body.url, publishAt: nextItaly2am(), savedAt: Date.now() };
    await redis.set(PENDING_KEY, pending);
    return res.status(200).json({ pending });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
