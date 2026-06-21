import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const KEY = 'bu_analytics_v1';

// Allow-list keeps the Redis hash bounded — arbitrary client input can't
// write arbitrary fields into it.
const EVENTS = new Set(['pageview', 'playlist_click', 'share_click', 'vote_click']);

function isAdmin(req) {
  const adminSecret = process.env.ADMIN_SECRET;
  return !!adminSecret && req.query.key === adminSecret;
}

function safeMeta(meta) {
  if (typeof meta !== 'string') return '';
  return meta.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET /api/track?key=ADMIN_SECRET — admin: read all counters ──
  if (req.method === 'GET') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
    const counts = (await redis.hgetall(KEY)) || {};
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ counts });
  }

  // ── POST /api/track — public: record one event ──────────────────
  if (req.method === 'POST') {
    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    const event = body?.event;
    if (!EVENTS.has(event)) return res.status(400).json({ error: 'Unknown event' });

    const meta = safeMeta(body?.meta);
    const fields = meta ? [event, `${event}:${meta}`] : [event];
    await Promise.all(fields.map(f => redis.hincrby(KEY, f, 1)));

    return res.status(204).end();
  }

  res.status(405).json({ error: 'Method not allowed' });
}
