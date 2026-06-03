import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const LB_KEY = 'bu_leaderboard_v1';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: return full leaderboard ──────────────────────────────
  if (req.method === 'GET') {
    const data = (await redis.get(LB_KEY)) || { users: {}, lastUpdated: new Date().toISOString() };
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(data);
  }

  // ── POST: upsert a single user's scores ───────────────────────
  if (req.method === 'POST') {
    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    const { username, scores, avatar, updatedAt, lastScrobbleAt } = body || {};
    if (!username || !scores) return res.status(400).json({ error: 'username and scores required' });

    // Read current data, merge user entry, write back
    const data = (await redis.get(LB_KEY)) || { users: {} };
    data.users = data.users || {};
    data.users[username.toLowerCase()] = { username, avatar, scores, updatedAt, lastScrobbleAt };
    data.lastUpdated = new Date().toISOString();
    await redis.set(LB_KEY, data);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
