import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const LB_KEY = 'bu_leaderboard_v1';

function isAdmin(req) {
  const adminSecret = process.env.ADMIN_SECRET;
  return !!adminSecret && req.query.key === adminSecret;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  // ── GET /api/leaderboard?action=banned&key=ADMIN_SECRET — admin: list bans ──
  if (req.method === 'GET' && action === 'banned') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
    const data = (await redis.get(LB_KEY)) || {};
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ banned: data.banned || [] });
  }

  // ── GET: return full leaderboard ──────────────────────────────
  if (req.method === 'GET') {
    const data = (await redis.get(LB_KEY)) || { users: {}, lastUpdated: new Date().toISOString() };
    res.setHeader('Cache-Control', 'no-store');
    const { banned, ...publicData } = data;
    return res.status(200).json(publicData);
  }

  // ── POST /api/leaderboard?action=ban&key=ADMIN_SECRET — admin: remove + block a user ──
  if (req.method === 'POST' && action === 'ban') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
    const username = (req.body?.username || '').trim().toLowerCase();
    if (!username) return res.status(400).json({ error: 'username required' });

    const data = (await redis.get(LB_KEY)) || { users: {} };
    data.users  = data.users  || {};
    data.banned = data.banned || [];
    if (!data.banned.includes(username)) data.banned.push(username);
    delete data.users[username];
    await redis.set(LB_KEY, data);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, banned: data.banned });
  }

  // ── POST /api/leaderboard?action=unban&key=ADMIN_SECRET — admin: lift a ban ──
  if (req.method === 'POST' && action === 'unban') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
    const username = (req.body?.username || '').trim().toLowerCase();
    if (!username) return res.status(400).json({ error: 'username required' });

    const data = (await redis.get(LB_KEY)) || { users: {} };
    data.banned = (data.banned || []).filter(u => u !== username);
    await redis.set(LB_KEY, data);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, banned: data.banned });
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

    if ((data.banned || []).includes(username.toLowerCase())) {
      return res.status(403).json({ error: 'This account is blocked from the leaderboard' });
    }

    data.users[username.toLowerCase()] = { username, avatar, scores, updatedAt, lastScrobbleAt };
    data.lastUpdated = new Date().toISOString();
    await redis.set(LB_KEY, data);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

