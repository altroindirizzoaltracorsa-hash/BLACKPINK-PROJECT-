import { Redis } from '@upstash/redis';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const redis = Redis.fromEnv();
const LB_KEY = 'bu_leaderboard_v1';
const ANALYTICS_KEY = 'bu_analytics_v1';
const TRACK_EVENTS = new Set(['pageview', 'playlist_click', 'share_click', 'vote_click']);


// Chat shares this file (instead of its own /api/chat.js) to stay under
// Vercel Hobby's 12-serverless-function cap.
const CHAT_UNLOCK_THRESHOLD = 10000;    // mirrors index.html's CHAT_THRESHOLD (bp group plays)
const CHAT_UNLOCK_MEMBER_TOTAL = 2000;  // combined member solo plays required
const CHAT_UNLOCK_MEMBER_EACH  = 500;   // per-member minimum
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

function safeMeta(meta) {
  if (typeof meta !== 'string') return '';
  return meta.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
}

// Same ranking + tie-break as the client's Overall · All Tracks leaderboard
// view, so the tracked leader always matches whoever is actually shown as #1.
function computeLeader(users) {
  const entries = Object.values(users || {}).map(u => ({ username: u.displayName || u.username, score: u.scores?.overall_all || 0 }));
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

  // ── GET /api/leaderboard?action=purge-unverified&key=ADMIN_SECRET[&dry=1] — admin: remove old-method users ──
  // Deletes leaderboard entries whose linked usernames have no row in Supabase linked_accounts.
  // Pass dry=1 to preview without deleting.
  if (req.method === 'GET' && action === 'purge-unverified') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
    const sb = supabase();
    if (!sb) return res.status(503).json({ error: 'Supabase not configured' });

    const { data: linked, error: sbErr } = await sb
      .from('linked_accounts')
      .select('source_username');
    if (sbErr) return res.status(500).json({ error: sbErr.message });

    const verified = new Set((linked || []).map(a => (a.source_username || '').toLowerCase()));

    const data = (await redis.get(LB_KEY)) || { users: {} };
    const removed = [];
    const kept    = [];

    for (const [key, entry] of Object.entries(data.users || {})) {
      const accounts = Array.isArray(entry.linkedAccounts) && entry.linkedAccounts.length
        ? entry.linkedAccounts
        : [{ username: entry.username }];
      const hasVerified = accounts.some(a => verified.has((a.username || '').toLowerCase()));
      const info = { name: entry.displayName || entry.username, updatedAt: entry.updatedAt || null, lastScrobbleAt: entry.lastScrobbleAt || null };
      if (hasVerified) {
        kept.push(info);
      } else {
        removed.push(info);
        if (req.query.dry !== '1') delete data.users[key];
      }
    }

    if (req.query.dry !== '1') {
      updateLeaderStreak(data);
      await redis.set(LB_KEY, data);
    }

    // Sort most-recently-active first so recent accounts are visible at the top.
    const byActivity = (a, b) => {
      const ta = a.updatedAt || a.lastScrobbleAt || '';
      const tb = b.updatedAt || b.lastScrobbleAt || '';
      return tb.localeCompare(ta);
    };
    removed.sort(byActivity);
    kept.sort(byActivity);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ dry: req.query.dry === '1', removed, kept });
  }

  // ── GET /api/leaderboard?action=banned&key=ADMIN_SECRET — admin: list bans ──
  if (req.method === 'GET' && action === 'banned') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
    const data = (await redis.get(LB_KEY)) || {};
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ banned: data.banned || [] });
  }

  // ── GET /api/leaderboard?action=stats&key=ADMIN_SECRET — admin: site analytics counters ──
  if (req.method === 'GET' && action === 'stats') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
    const counts = (await redis.hgetall(ANALYTICS_KEY)) || {};
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ counts });
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

  // ── POST /api/leaderboard?action=track — public: record one analytics event ──
  if (req.method === 'POST' && action === 'track') {
    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    const event = body?.event;
    if (!TRACK_EVENTS.has(event)) return res.status(400).json({ error: 'Unknown event' });
    const meta = safeMeta(body?.meta);
    const fields = meta ? [event, `${event}:${meta}`] : [event];
    await Promise.all(fields.map(f => redis.hincrby(ANALYTICS_KEY, f, 1)));
    return res.status(204).end();
  }

  // ── POST /api/leaderboard?action=delete-entry&key=ADMIN_SECRET — admin: remove without banning ──
  if (req.method === 'POST' && action === 'delete-entry') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
    const username = (req.body?.username || '').trim().toLowerCase();
    if (!username) return res.status(400).json({ error: 'username required' });

    const data = (await redis.get(LB_KEY)) || { users: {} };
    data.users = data.users || {};
    delete data.users[username];
    updateLeaderStreak(data);
    await redis.set(LB_KEY, data);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true });
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

  // ── POST ?action=chat-reclaim — re-issue secret for a Supabase-authenticated user ──
  // Verifies the caller's Supabase JWT, checks the username is in their linked_accounts,
  // then replaces the stale claim so they can chat from a new device.
  if (req.method === 'POST' && action === 'chat-reclaim') {
    const sb = supabase();
    if (!sb) return res.status(503).json({ error: 'Server not configured' });

    const { username, accessToken } = req.body || {};
    if (!username || !accessToken) return res.status(400).json({ error: 'username and accessToken required' });
    const key = username.toLowerCase();

    // Verify the Supabase JWT and get the user
    const { data: { user }, error: authErr } = await sb.auth.getUser(accessToken);
    if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });

    // Confirm this username belongs to one of their linked accounts
    const { data: linked } = await sb
      .from('linked_accounts')
      .select('source_username')
      .eq('app_user_id', user.id);
    const owns = (linked || []).some(a => a.source_username.toLowerCase() === key);
    if (!owns) return res.status(403).json({ error: 'This username is not linked to your account' });

    // Replace the existing claim with a fresh secret
    const secret = crypto.randomBytes(24).toString('hex');
    await sb.from('chat_claims').delete().eq('username', key);
    const { error: insErr } = await sb.from('chat_claims').insert({ username: key, secret });
    if (insErr) return res.status(500).json({ error: insErr.message });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ secret });
  }

  // ── POST ?action=chat-send — post a chat message ──────────────
  if (req.method === 'POST' && action === 'chat-send') {
    const sb = supabase();
    if (!sb) return res.status(503).json({ error: 'Server not configured' });

    const { username, secret, accessToken, message } = req.body || {};
    const text = (message || '').trim().slice(0, 500);
    if (!username || (!secret && !accessToken)) return res.status(400).json({ error: 'username and auth required' });
    if (!text) return res.status(400).json({ error: 'message required' });
    const key = username.toLowerCase();

    const lb = (await redis.get(LB_KEY)) || {};
    if ((lb.banned || []).includes(key)) return res.status(403).json({ error: 'This account is blocked' });

    // Auth: Supabase session token (account-based, works on any device)
    // The JWT itself proves identity — no need to also verify the frontend-provided username.
    // We use all linked accounts for leaderboard entry lookup instead.
    let allLinkedKeys = null;
    if (accessToken) {
      const { data: { user }, error: authErr } = await sb.auth.getUser(accessToken);
      if (authErr || !user) return res.status(401).json({ error: 'Session expired — please reload' });
      const { data: linked } = await sb
        .from('linked_accounts').select('source_username').eq('app_user_id', user.id);
      const linkedList = linked || [];
      // If no accounts linked yet, fall back to looking up by the provided username
      // (same path as the legacy device-secret flow). Supabase auth still proves a real user.
      if (linkedList.length) {
        allLinkedKeys = new Set(linkedList.map(a => a.source_username.toLowerCase()));
      }
    } else {
      // Legacy: device-secret claim
      const { data: claim, error: claimErr } = await sb
        .from('chat_claims').select('secret').eq('username', key).maybeSingle();
      if (claimErr) return res.status(500).json({ error: claimErr.message });
      if (!claim || claim.secret !== secret) return res.status(401).json({ error: 'Unauthorized' });
    }

    // Look up leaderboard entry — try all linked account usernames so multi-account
    // users are found even when the leaderboard key doesn't match the chat username.
    const lookupKeys = allLinkedKeys ? [...allLinkedKeys] : [key];
    let entry = null;
    for (const k of lookupKeys) {
      entry = lb.users?.[k];
      if (entry) break;
    }
    if (!entry && lb.users) {
      entry = Object.values(lb.users).find(d =>
        Array.isArray(d.linkedAccounts) &&
        d.linkedAccounts.some(a => lookupKeys.includes((a.username || '').toLowerCase()))
      );
    }
    const scores = entry?.scores || {};
    const bpGroup = scores.overall_bp_group ?? scores.overall_artist ?? 0;
    // Member requirement only applies once the entry has been synced with new score fields.
    const memberSynced = 'overall_bp_group' in scores;
    const memberTotal = (scores.overall_jisoo || 0) + (scores.overall_lisa || 0) + (scores.overall_rose || 0) + (scores.overall_jennie || 0);
    const meetsMemberReq = !memberSynced || (
      memberTotal >= CHAT_UNLOCK_MEMBER_TOTAL
      && (scores.overall_jisoo  || 0) >= CHAT_UNLOCK_MEMBER_EACH
      && (scores.overall_lisa   || 0) >= CHAT_UNLOCK_MEMBER_EACH
      && (scores.overall_rose   || 0) >= CHAT_UNLOCK_MEMBER_EACH
      && (scores.overall_jennie || 0) >= CHAT_UNLOCK_MEMBER_EACH
    );
    const meetsThreshold = CHAT_UNLOCK_EXEMPT.includes(key) || (
      bpGroup >= CHAT_UNLOCK_THRESHOLD
      && meetsMemberReq
      && (scores.overall_jump     || 0) >= CHAT_UNLOCK_MIN.jump
      && (scores.overall_shutdown || 0) >= CHAT_UNLOCK_MIN.shutdown
      && (scores.overall_ddududu  || 0) >= CHAT_UNLOCK_MIN.ddududu
    );
    if (!meetsThreshold) {
      return res.status(403).json({
        error: `Chat requires ${CHAT_UNLOCK_THRESHOLD.toLocaleString()} BLACKPINK group streams + ${CHAT_UNLOCK_MEMBER_TOTAL.toLocaleString()} member solo streams (≥${CHAT_UNLOCK_MEMBER_EACH} each) + ${CHAT_UNLOCK_MIN.jump.toLocaleString()} JUMP + ${CHAT_UNLOCK_MIN.shutdown.toLocaleString()} Shut Down + ${CHAT_UNLOCK_MIN.ddududu.toLocaleString()} DDU-DU DDU-DU`,
      });
    }

    // Use display name as author; fall back to primary leaderboard key.
    const chatAuthor = entry.displayName || entry.username || username;

    const { data: last, error: lastErr } = await sb
      .from('chat_messages').select('created_at').eq('username', chatAuthor)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (lastErr) return res.status(500).json({ error: lastErr.message });
    if (last && Date.now() - new Date(last.created_at).getTime() < CHAT_MIN_POST_INTERVAL_MS) {
      return res.status(429).json({ error: 'Slow down a little' });
    }

    const { error } = await sb.from('chat_messages').insert({
      username: chatAuthor,
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

    const { username, scores, avatar, updatedAt, lastScrobbleAt, displayName, linkedAccounts, cleanupKeys, accessToken } = body || {};
    if (!username || !scores) return res.status(400).json({ error: 'username and scores required' });

    // Require Supabase auth — old-method (no-token) submissions are no longer accepted.
    if (!accessToken) return res.status(401).json({ error: 'Sign in required to appear on the leaderboard' });
    const sb = supabase();
    if (!sb) return res.status(503).json({ error: 'Server not configured' });
    const { data: { user }, error: authErr } = await sb.auth.getUser(accessToken);
    if (authErr || !user) return res.status(401).json({ error: 'Session expired — please sign in again' });

    // Verify at least one submitted username is linked to this Supabase account.
    const { data: linked } = await sb.from('linked_accounts').select('source_username').eq('app_user_id', user.id);
    const linkedSet = new Set((linked || []).map(a => a.source_username.toLowerCase()));
    const submitted = [username, ...(Array.isArray(linkedAccounts) ? linkedAccounts.map(a => a.username || '') : [])].map(u => u.toLowerCase());
    if (!submitted.some(u => linkedSet.has(u))) {
      return res.status(403).json({ error: 'Link your scrobbling account in settings before submitting scores' });
    }

    // Read current data, merge user entry, write back
    const data = (await redis.get(LB_KEY)) || { users: {} };
    data.users = data.users || {};

    if ((data.banned || []).includes(username.toLowerCase())) {
      return res.status(403).json({ error: 'This account is blocked from the leaderboard' });
    }

    data.users[username.toLowerCase()] = {
      username,
      displayName: displayName || username,
      linkedAccounts: linkedAccounts || [{ type: 'lastfm', username }],
      avatar,
      scores,
      updatedAt,
      lastScrobbleAt,
    };

    // Remove old per-account entries now merged into this combined entry.
    // Only delete entries whose username appears in the submitted linkedAccounts list
    // (so a user can only clean up accounts they claim to own).
    if (Array.isArray(cleanupKeys) && Array.isArray(linkedAccounts)) {
      const ownedKeys = new Set(linkedAccounts.map(a => (a.username || '').toLowerCase()));
      for (const k of cleanupKeys) {
        const kl = (k || '').toLowerCase();
        if (kl && kl !== username.toLowerCase() && ownedKeys.has(kl) && !(data.banned || []).includes(kl)) {
          delete data.users[kl];
        }
      }
    }

    data.lastUpdated = new Date().toISOString();
    updateLeaderStreak(data);
    await redis.set(LB_KEY, data);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

