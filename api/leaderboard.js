import { Redis } from '@upstash/redis';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const redis = Redis.fromEnv();
const LB_KEY = 'bu_leaderboard_v1';

// Chat shares this file (instead of its own /api/chat.js) to stay under
// Vercel Hobby's 12-serverless-function cap.
const CHAT_UNLOCK_THRESHOLD = 10000; // mirrors index.html's CHAT_THRESHOLD
const CHAT_UNLOCK_MIN = { jump: 3000, shutdown: 2000, ddududu: 1500 }; // mirrors index.html's CHAT_MIN
const CHAT_MIN_POST_INTERVAL_MS = 3000;
// Grandfathered in regardless of scrobble count — the fanbase's own account, not a listener. Mirrors index.html's CHAT_EXEMPT.
const CHAT_UNLOCK_EXEMPT = ['blinksunited'];

function isAdmin(req) {
  const adminSecret = process.env.ADMIN_SECRET;
  return !!adminSecret && req.query.key === adminSecret;
}

function supabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// Same ranking + tie-break as the client's Overall · All Tracks leaderboard
// view, so the tracked leader always matches whoever is actually shown as #1.
function computeLeader(users) {
  const entries = Object.values(users || {}).map(u => ({ username: u.username, score: u.scores?.overall_all || 0 }));
  entries.sort((a, b) => b.score - a.score || a.username.localeCompare(b.username));
  return entries[0]?.score > 0 ? entries[0] : null;
}

function updateLeaderStreak(data) {
  const leader = computeLeader(data.users);
  if (!leader) return;
  if (data.leaderStreak?.username?.toLowerCase() !== leader.username.toLowerCase()) {
    data.leaderStreak = { username: leader.username, since: new Date().toISOString() };
  }
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

  // ── GET /api/leaderboard?action=chat-messages — public: list recent chat messages ──
  if (req.method === 'GET' && action === 'chat-messages') {
    const sb = supabase();
    if (!sb) return res.status(503).json({ error: 'Server not configured' });

    const { data, error } = await sb
      .from('chat_messages')
      .select('id, username, avatar, message, created_at')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) return res.status(500).json({ error: error.message });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ messages: (data || []).reverse() });
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
    updateLeaderStreak(data);
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

  // ── POST ?action=chat-claim — first use on a browser binds a username to it,
  // so chat posts can be tied to "whoever already claimed this name" without
  // a full login system. Returns 409 if another browser claimed it first. ──
  if (req.method === 'POST' && action === 'chat-claim') {
    const sb = supabase();
    if (!sb) return res.status(503).json({ error: 'Server not configured' });

    const username = (req.body?.username || '').trim();
    if (!username) return res.status(400).json({ error: 'username required' });
    const key = username.toLowerCase();

    const lb = (await redis.get(LB_KEY)) || {};
    if ((lb.banned || []).includes(key)) return res.status(403).json({ error: 'This account is blocked' });

    const { data: existing, error: selErr } = await sb
      .from('chat_claims').select('username').eq('username', key).maybeSingle();
    if (selErr) return res.status(500).json({ error: selErr.message });
    if (existing) return res.status(409).json({ error: 'Username already claimed on another device' });

    const secret = crypto.randomBytes(24).toString('hex');
    const { error } = await sb.from('chat_claims').insert({ username: key, secret });
    if (error) return res.status(500).json({ error: error.message });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ secret });
  }

  // ── POST ?action=chat-send — post a chat message ──────────────
  if (req.method === 'POST' && action === 'chat-send') {
    const sb = supabase();
    if (!sb) return res.status(503).json({ error: 'Server not configured' });

    const { username, secret, message } = req.body || {};
    const text = (message || '').trim().slice(0, 500);
    if (!username || !secret) return res.status(400).json({ error: 'username and secret required' });
    if (!text) return res.status(400).json({ error: 'message required' });
    const key = username.toLowerCase();

    const lb = (await redis.get(LB_KEY)) || {};
    if ((lb.banned || []).includes(key)) return res.status(403).json({ error: 'This account is blocked' });

    const { data: claim, error: claimErr } = await sb
      .from('chat_claims').select('secret').eq('username', key).maybeSingle();
    if (claimErr) return res.status(500).json({ error: claimErr.message });
    if (!claim || claim.secret !== secret) return res.status(401).json({ error: 'Unauthorized' });

    const entry = lb.users?.[key];
    const scores = entry?.scores || {};
    const meetsThreshold = CHAT_UNLOCK_EXEMPT.includes(key) || (
      (scores.overall_artist || 0) >= CHAT_UNLOCK_THRESHOLD
      && (scores.overall_jump || 0) >= CHAT_UNLOCK_MIN.jump
      && (scores.overall_shutdown || 0) >= CHAT_UNLOCK_MIN.shutdown
      && (scores.overall_ddududu || 0) >= CHAT_UNLOCK_MIN.ddududu
    );
    if (!meetsThreshold) {
      return res.status(403).json({
        error: `Chat unlocks at ${CHAT_UNLOCK_THRESHOLD.toLocaleString()} all-time BLACKPINK scrobbles, including at least ${CHAT_UNLOCK_MIN.jump.toLocaleString()} JUMP, ${CHAT_UNLOCK_MIN.shutdown.toLocaleString()} Shut Down & ${CHAT_UNLOCK_MIN.ddududu.toLocaleString()} DDU-DU DDU-DU`,
      });
    }

    const { data: last, error: lastErr } = await sb
      .from('chat_messages').select('created_at').eq('username', entry.username)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (lastErr) return res.status(500).json({ error: lastErr.message });
    if (last && Date.now() - new Date(last.created_at).getTime() < CHAT_MIN_POST_INTERVAL_MS) {
      return res.status(429).json({ error: 'Slow down a little' });
    }

    const { error } = await sb.from('chat_messages').insert({
      username: entry.username,
      avatar: entry.avatar || null,
      message: text,
    });
    if (error) return res.status(500).json({ error: error.message });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true });
  }

  // ── POST ?action=chat-delete&key=ADMIN_SECRET — admin: remove a message ──
  if (req.method === 'POST' && action === 'chat-delete') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
    const sb = supabase();
    if (!sb) return res.status(503).json({ error: 'Server not configured' });

    const id = req.body?.id;
    if (!id) return res.status(400).json({ error: 'id required' });

    const { error } = await sb.from('chat_messages').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
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
    updateLeaderStreak(data);
    await redis.set(LB_KEY, data);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

