import { Redis } from '@upstash/redis';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const redis = Redis.fromEnv();
const LB_KEY = 'bu_leaderboard_v1';
const UNLOCK_THRESHOLD = 10000; // mirrors index.html's CHAT_THRESHOLD
const UNLOCK_MIN = { jump: 3000, shutdown: 2000, ddududu: 1500 }; // mirrors index.html's CHAT_MIN
const MIN_POST_INTERVAL_MS = 3000;

function supabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function isAdmin(req) {
  const adminSecret = process.env.ADMIN_SECRET;
  return !!adminSecret && req.query.key === adminSecret;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sb = supabase();
  if (!sb) return res.status(503).json({ error: 'Server not configured' });

  const action = req.query.action;

  // ── GET: list recent messages (public, read-only) ─────────────
  if (req.method === 'GET' && !action) {
    const { data, error } = await sb
      .from('chat_messages')
      .select('id, username, avatar, message, created_at')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) return res.status(500).json({ error: error.message });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ messages: (data || []).reverse() });
  }

  // ── POST ?action=claim — first use on a browser binds a username to it,
  // so chat posts can be tied to "whoever already claimed this name" without
  // a full login system. Returns 409 if another browser claimed it first. ──
  if (req.method === 'POST' && action === 'claim') {
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

  // ── POST ?action=send — post a chat message ───────────────────
  if (req.method === 'POST' && action === 'send') {
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
    const meetsThreshold = (scores.overall_all || 0) >= UNLOCK_THRESHOLD
      && (scores.overall_jump || 0) >= UNLOCK_MIN.jump
      && (scores.overall_shutdown || 0) >= UNLOCK_MIN.shutdown
      && (scores.overall_ddududu || 0) >= UNLOCK_MIN.ddududu;
    if (!meetsThreshold) {
      return res.status(403).json({
        error: `Chat unlocks at ${UNLOCK_THRESHOLD.toLocaleString()} Overall · All Tracks scrobbles, including at least ${UNLOCK_MIN.jump.toLocaleString()} JUMP, ${UNLOCK_MIN.shutdown.toLocaleString()} Shut Down & ${UNLOCK_MIN.ddududu.toLocaleString()} DDU-DU DDU-DU`,
      });
    }

    const { data: last, error: lastErr } = await sb
      .from('chat_messages').select('created_at').eq('username', entry.username)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (lastErr) return res.status(500).json({ error: lastErr.message });
    if (last && Date.now() - new Date(last.created_at).getTime() < MIN_POST_INTERVAL_MS) {
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

  // ── POST ?action=delete&key=ADMIN_SECRET — admin: remove a message ────
  if (req.method === 'POST' && action === 'delete') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
    const id = req.body?.id;
    if (!id) return res.status(400).json({ error: 'id required' });

    const { error } = await sb.from('chat_messages').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
