import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const KEY = 'bp_current_playlist';
const QUEUE_KEY = 'bp_pending_playlist_queue';

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
// Start of the current Italy-day (the most recent past 2am boundary), in ms.
function currentItalyDayStart() {
  const offset = getItalyOffset();
  const it = new Date(Date.now() + offset * 3600 * 1000);
  const y = it.getUTCFullYear(), m = it.getUTCMonth(), d = it.getUTCDate();
  const hour = it.getUTCHours();
  let dayStart = new Date(Date.UTC(y, m, d, 2 - offset, 0, 0));
  if (hour < 2) dayStart = new Date(dayStart.getTime() - 86400000);
  return dayStart.getTime();
}
function nextItaly2am() {
  return currentItalyDayStart() + 86400000;
}

// Manually-saved links queue up in QUEUE_KEY instead of going live immediately,
// so the admin can load several days of playlists in advance without any of
// them replacing the currently-live one early. At most one entry is promoted
// per Italy-day, in the order it was saved — checked lazily on every read.
async function promotePendingIfDue() {
  const live = await redis.get(KEY);
  if (live?.updatedAt >= currentItalyDayStart()) return; // already refreshed this Italy-day
  const next = await redis.lpop(QUEUE_KEY);
  if (!next) return;
  await redis.set(KEY, { id: next.id, url: next.url, updatedAt: Date.now(), ...(next.day ? { day: next.day } : {}) });
}

// Annotates each queued entry with an estimated go-live time, one Italy-day
// apart. The next 2am-Italy boundary is always the earliest possible slot for
// queue[0] — whether today's live entry is already "fresh" only matters to
// promotePendingIfDue() at the moment that boundary actually arrives, not now.
async function buildQueueStatus() {
  const [live, queueRaw] = await Promise.all([redis.get(KEY), redis.lrange(QUEUE_KEY, 0, -1)]);
  const nextSlot = nextItaly2am();
  const queue = (queueRaw || []).map((item, i) => ({ ...item, etaPublishAt: nextSlot + i * 86400000 }));
  return { live, queue };
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
      const { live, queue } = await buildQueueStatus();
      return res.status(200).json({ ...(live || {}), queue });
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
    const day = req.body?.day ? Number(req.body.day) : undefined;

    if (req.body?.publishNow) {
      const data = { id, url: req.body.url, updatedAt: Date.now(), ...(day ? { day } : {}) };
      await redis.set(KEY, data);
      const { queue } = await buildQueueStatus();
      return res.status(200).json({ live: data, queue });
    }

    await redis.rpush(QUEUE_KEY, { id, url: req.body.url, savedAt: Date.now(), ...(day ? { day } : {}) });
    const { queue } = await buildQueueStatus();
    return res.status(200).json({ queued: true, queue });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
