import { Redis } from '@upstash/redis';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const redis = Redis.fromEnv();
const LB_KEY = 'bu_leaderboard_v1';
const ANALYTICS_KEY = 'bu_analytics_v1';
const GOAL_HISTORY_KEY = 'bu_goal_history_v1';

// Italy-aware day key, matching the client's italyDayKey(offsetDays).
// Day boundary = 2am CET/CEST; before 2am it's still the previous calendar day.
function serverItalyDayKey(offsetDays = 0) {
  const now = Date.now();
  const yr  = new Date(now).getUTCFullYear();
  const lastSun = (y, m) => { const d = new Date(Date.UTC(y, m + 1, 0)); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d; };
  const offsetMs = now >= lastSun(yr, 2).getTime() && now < lastSun(yr, 9).getTime() ? 7200000 : 3600000;
  const itDate = new Date(now + offsetMs);
  if (itDate.getUTCHours() < 2) itDate.setUTCDate(itDate.getUTCDate() - 1);
  itDate.setUTCDate(itDate.getUTCDate() - offsetDays);
  return itDate.toISOString().slice(0, 10);
}

function computeGoalStreak(days) {
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    if (!days[serverItalyDayKey(i)]?.primary) break;
    streak++;
  }
  return streak;
}
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

// Diagnostic: record the last ~50 rejected leaderboard submissions so we can see
// server-side WHY an account never appears (401 token vs 403 not-linked), without
// depending on a client-side banner. Read via GET ?action=submit-rejects&key=…
async function logSubmitReject(username, status, reason, extra) {
  try {
    const rec = JSON.stringify({ username: username || null, status, reason: reason || null, extra: extra || null, at: new Date().toISOString() });
    await redis.lpush('bu_submit_rejects', rec);
    await redis.ltrim('bu_submit_rejects', 0, 49);
  } catch (e) { /* never let logging break a request */ }
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

// ── Italy 2am day/week bounds (unix seconds), matching cron-scrobbles.js ──
function bpLastSunday(y, m) { const d = new Date(Date.UTC(y, m + 1, 0)); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d; }
function bpItalyOffset() { const n = new Date(); const y = n.getUTCFullYear(); return (n >= bpLastSunday(y, 2) && n < bpLastSunday(y, 9)) ? 2 : 1; }
function bpDayBounds() {
  const offset = bpItalyOffset();
  const it = new Date(Date.now() + offset * 3600 * 1000);
  let dayStart = new Date(Date.UTC(it.getUTCFullYear(), it.getUTCMonth(), it.getUTCDate(), 2 - offset, 0, 0));
  if (it.getUTCHours() < 2) dayStart = new Date(dayStart.getTime() - 86400000);
  return { from: Math.floor(dayStart / 1000), to: Math.floor((dayStart.getTime() + 86400000) / 1000) };
}
function bpWeekBounds() {
  const { from: dayFrom } = bpDayBounds();
  const dayFromDate = new Date(dayFrom * 1000);
  const dow = dayFromDate.getUTCDay();
  const daysToMon = dow === 0 ? 6 : dow - 1;
  const weekStart = new Date(dayFromDate.getTime() - daysToMon * 86400000);
  return { from: Math.floor(weekStart / 1000), to: Math.floor((weekStart.getTime() + 7 * 86400000) / 1000) };
}

// Extension (blinksunited-direct) plays for one profile, per track, by window.
// Additive on top of Last.fm/LB scores; 0 for anyone who hasn't linked the
// extension, so regular submissions are byte-for-byte unaffected.
async function extensionCountsForUser(sb, appUserId, dayFrom, dayTo, weekFrom, weekTo) {
  const empty = () => ({ jump: 0, shutdown: 0, ddududu: 0, ltal: 0, go: 0 });
  const out = { total: empty(), week: empty(), today: empty() };
  if (!sb || !appUserId) return out;
  // Counted in the database (see supabase/extension_counts_fn.sql) so it scales
  // to unlimited rows — no per-query 1000-row cap, no fetching every play.
  const { data, error } = await sb.rpc('extension_counts', {
    uid: appUserId,
    day_from: new Date(dayFrom * 1000).toISOString(),
    week_from: new Date(weekFrom * 1000).toISOString(),
  });
  if (error || !data) return out;
  for (const r of data) {
    const id = r.track_id;
    if (!(id in out.total)) continue;
    out.total[id] = Number(r.total) || 0;
    out.week[id]  = Number(r.week)  || 0;
    out.today[id] = Number(r.today) || 0;
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  // ── GET ?action=missing-from-board&key=ADMIN_SECRET — admin: how many linked
  //    (esp. multi-account) users are NOT on the leaderboard. Quantifies the blast
  //    radius of the fresh-session submit crash. ──
  if (req.method === 'GET' && action === 'missing-from-board') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
    const sb = supabase();
    if (!sb) return res.status(503).json({ error: 'Supabase not configured' });
    const { data: linked, error: le } = await sb.from('linked_accounts').select('app_user_id, source, source_username');
    if (le) return res.status(500).json({ error: le.message });
    const byUser = {};
    for (const r of (linked || [])) { (byUser[r.app_user_id] ||= []).push(r); }
    const board = (await redis.get(LB_KEY))?.users || {};
    const onBoard = new Set();
    const boardAppUsers = new Set();
    for (const [k, e] of Object.entries(board)) {
      onBoard.add(k.toLowerCase());
      if (e.appUserId) boardAppUsers.add(e.appUserId);
      for (const a of (e.linkedAccounts || [])) onBoard.add((a.username || '').toLowerCase());
    }
    let total = 0, multi = 0, missingSingle = 0;
    const missingMulti = [];
    for (const [uid, accts] of Object.entries(byUser)) {
      total++;
      const isMulti = accts.length >= 2 || (accts.length === 1 && (accts[0].source || '').toLowerCase() !== 'lastfm');
      const present = boardAppUsers.has(uid) || accts.some(a => onBoard.has((a.source_username || '').toLowerCase()));
      if (isMulti) {
        multi++;
        if (!present) missingMulti.push({ uid, accounts: accts.map(a => `${a.source}:${a.source_username}`) });
      } else if (!present) {
        missingSingle++;
      }
    }
    return res.status(200).json({
      linkedUsersTotal: total,
      multiAccountUsers: multi,
      multiAccountMissing: missingMulti.length,
      singleAccountMissing: missingSingle,
      missingMultiSample: missingMulti.slice(0, 60),
    });
  }

  // ── GET ?action=ext-week&key=ADMIN&user=<scrobbler> — admin diagnostic: this
  //    week's extension per-day counts for the profile that linked <user>. Used to
  //    verify a past day's extension contribution directly from the DB. ──
  if (req.method === 'GET' && action === 'ext-week') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
    const sb = supabase();
    if (!sb) return res.status(503).json({ error: 'Supabase not configured' });
    const user = (req.query.user || '').trim().toLowerCase();
    if (!user) return res.status(400).json({ error: 'user required' });
    const { data: la } = await sb.from('linked_accounts').select('app_user_id, source_username');
    const row = (la || []).find(r => (r.source_username || '').toLowerCase() === user);
    if (!row) return res.status(404).json({ error: `no linked_accounts row for ${user}` });
    const { from: weekFrom } = bpWeekBounds();
    const weekStartIso = new Date(weekFrom * 1000).toISOString();
    const { data, error } = await sb.rpc('extension_week_days', { uid: row.app_user_id, week_from: weekStartIso });
    if (error) return res.status(500).json({ error: error.message });
    // day_index 0=Mon … 6=Sun relative to weekFrom
    return res.status(200).json({ appUserId: row.app_user_id, weekStart: weekStartIso, days: data || [] });
  }

  // ── GET ?action=submit-rejects&key=ADMIN_SECRET — admin: recent rejected submissions.
  //    Kept as a lightweight, low-overhead diagnostic (only writes on a rejection, which
  //    is rare) so "why isn't account X on the board" can be answered without guesswork. ──
  if (req.method === 'GET' && action === 'submit-rejects') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
    const parse = arr => (arr || []).map(r => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return r; } });
    let rejects = [];
    try {
      rejects = parse(await redis.lrange('bu_submit_rejects', 0, 49));
    } catch (e) { return res.status(500).json({ error: String(e) }); }
    return res.status(200).json({ rejectCount: rejects.length, rejects });
  }

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
      // NEVER purge a row that belongs to a signed-in Supabase account. appUserId
      // is set on every authenticated submit, so its presence is proof this is a
      // real account — not an old Last.fm-only guest — even if that account's
      // scrobbler username happens not to appear in the linked_accounts snapshot
      // (e.g. same username under a different scrobbler service). This is what
      // stops the purge from wiping real X/Discord/Google accounts.
      if (entry.appUserId || hasVerified) {
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

  // ── GET /api/leaderboard?action=rename-log&key=ADMIN_SECRET — admin: view rename history ──
  if (req.method === 'GET' && action === 'rename-log') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
    const data = (await redis.get(LB_KEY)) || {};
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ renameLog: data.renameLog || [] });
  }

  // ── GET: return full leaderboard ──────────────────────────────
  if (req.method === 'GET') {
    const data = (await redis.get(LB_KEY)) || { users: {}, lastUpdated: new Date().toISOString() };
    res.setHeader('Cache-Control', 'no-store');
    const { banned, renameLog, ...publicData } = data;
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

  // ── POST /api/leaderboard?action=rename-user&key=ADMIN_SECRET — admin: fix username after Last.fm rename ──
  // Renames a user across all three stores: Redis leaderboard key, Supabase user_stamps, and linked_accounts.
  // Use when a user changes their Last.fm username and can no longer load their profile.
  if (req.method === 'POST' && action === 'rename-user') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
    const sb = supabase();
    if (!sb) return res.status(503).json({ error: 'Supabase not configured' });

    const oldName = (req.body?.oldUsername || '').trim().toLowerCase();
    const newName = (req.body?.newUsername || '').trim().toLowerCase();
    if (!oldName || !newName) return res.status(400).json({ error: 'oldUsername and newUsername required' });
    if (oldName === newName) return res.status(400).json({ error: 'Names are the same' });

    const results = {};

    // 1. Redis leaderboard: rename key, update internal fields
    const data = (await redis.get(LB_KEY)) || { users: {} };
    data.users = data.users || {};
    if (data.users[oldName]) {
      const entry = data.users[oldName];
      entry.username = newName;
      if (!entry.displayName || entry.displayName.toLowerCase() === oldName) entry.displayName = newName;
      // Update username references inside linkedAccounts
      if (Array.isArray(entry.linkedAccounts)) {
        entry.linkedAccounts = entry.linkedAccounts.map(a =>
          (a.username || '').toLowerCase() === oldName ? { ...a, username: newName } : a
        );
      }
      // Defensive merge: remove any existing entry for the new name so we don't duplicate
      delete data.users[newName];
      data.users[newName] = entry;
      delete data.users[oldName];
      updateLeaderStreak(data);
      await redis.set(LB_KEY, data);
      results.leaderboard = 'renamed';
    } else if (data.users[newName]) {
      results.leaderboard = 'new name already exists, old key not found — skipped';
    } else {
      results.leaderboard = 'old key not found';
    }

    // 2. Supabase user_stamps: rename lfm_username
    const { error: stampsErr, count: stampsCount } = await sb
      .from('user_stamps')
      .update({ lfm_username: newName })
      .ilike('lfm_username', oldName)
      .select('*', { count: 'exact', head: true });
    results.stamps = stampsErr ? `error: ${stampsErr.message}` : `${stampsCount ?? '?'} rows updated`;

    // 3. Supabase linked_accounts: update source_username
    const { error: laErr, count: laCount } = await sb
      .from('linked_accounts')
      .update({ source_username: newName })
      .ilike('source_username', oldName)
      .eq('source', 'lastfm')
      .select('*', { count: 'exact', head: true });
    results.linked_accounts = laErr ? `error: ${laErr.message}` : `${laCount ?? '?'} rows updated`;

    // Append to rename log (keep last 50 entries)
    const freshData = (await redis.get(LB_KEY)) || {};
    freshData.renameLog = freshData.renameLog || [];
    freshData.renameLog.push({ oldUsername: oldName, newUsername: newName, timestamp: new Date().toISOString(), results });
    if (freshData.renameLog.length > 50) freshData.renameLog = freshData.renameLog.slice(-50);
    await redis.set(LB_KEY, freshData);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, oldUsername: oldName, newUsername: newName, results });
  }

  // ── POST /api/leaderboard?action=set-display-name — user: update their own display name ──
  // Updates both the leaderboard Redis entry and (client-side) Supabase user_metadata.
  // Matching is done via the user's linked_accounts rows so the right entry is always
  // found even if the Redis key has drifted (e.g. an emoji suffix or a prior rename).
  if (req.method === 'POST' && action === 'set-display-name') {
    const { displayName, accessToken } = req.body || {};
    if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
      return res.status(400).json({ error: 'displayName required' });
    }
    const sb = supabase();
    if (!sb) return res.status(503).json({ error: 'Server not configured' });
    const { data: { user }, error: authErr } = await sb.auth.getUser(accessToken);
    if (authErr || !user) return res.status(401).json({ error: 'Session expired — please sign in again' });

    const { data: linked } = await sb.from('linked_accounts').select('source_username').eq('app_user_id', user.id);
    const linkedUsernames = new Set((linked || []).map(a => (a.source_username || '').toLowerCase()));
    if (linkedUsernames.size === 0) {
      return res.status(400).json({ error: 'Link a scrobbling account first' });
    }

    const cleanName = displayName.trim().slice(0, 40);
    const data = (await redis.get(LB_KEY)) || { users: {} };
    data.users = data.users || {};

    // Find and update every entry that belongs to this user (matched by any linked username).
    // This handles the case where the Redis key has drifted from the current linked username.
    let updated = 0;
    for (const entry of Object.values(data.users)) {
      const entryUsernames = new Set([
        (entry.username || '').toLowerCase(),
        ...(Array.isArray(entry.linkedAccounts) ? entry.linkedAccounts.map(a => (a.username || '').toLowerCase()) : []),
      ].filter(Boolean));
      if ([...entryUsernames].some(u => linkedUsernames.has(u))) {
        entry.displayName = cleanName;
        updated++;
      }
    }

    if (updated > 0) {
      updateLeaderStreak(data);
      await redis.set(LB_KEY, data);
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, displayName: cleanName, entriesUpdated: updated });
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

    const { username, scores, avatar, updatedAt, lastScrobbleAt, displayName, linkedAccounts, cleanupKeys, accessToken, extensionIncluded, providerScores } = body || {};
    if (!username || !scores) return res.status(400).json({ error: 'username and scores required' });

    // Require Supabase auth — old-method (no-token) submissions are no longer accepted.
    if (!accessToken) { await logSubmitReject(username, 401, 'no accessToken'); return res.status(401).json({ error: 'Sign in required to appear on the leaderboard' }); }
    const sb = supabase();
    if (!sb) return res.status(503).json({ error: 'Server not configured' });
    const { data: { user }, error: authErr } = await sb.auth.getUser(accessToken);
    if (authErr || !user) { await logSubmitReject(username, 401, 'getUser failed: ' + (authErr?.message || 'no user')); return res.status(401).json({ error: 'Session expired — please sign in again' }); }

    // Verify at least one submitted username is linked to this Supabase account.
    const { data: linked } = await sb.from('linked_accounts').select('source_username').eq('app_user_id', user.id);
    const linkedSet = new Set((linked || []).map(a => a.source_username.toLowerCase()));
    const submitted = [username, ...(Array.isArray(linkedAccounts) ? linkedAccounts.map(a => a.username || '') : [])].map(u => u.toLowerCase());
    if (!submitted.some(u => linkedSet.has(u))) {
      await logSubmitReject(username, 403, 'no submitted username in linked_accounts for this user', { submitted, linked: Array.from(linkedSet), appUserId: user.id });
      return res.status(403).json({ error: 'Link your scrobbling account in settings before submitting scores' });
    }

    // Add this profile's extension (blinksunited-direct) plays on top of the
    // Last.fm/LB scores the client computed. Best-effort and additive: it never
    // blocks a submission, and adds 0 for anyone without extension plays, so a
    // normal submission passes through unchanged.
    // SKIPPED when the client already folded the extension into the submitted
    // numbers (extensionIncluded) — the multi-account badges page does this so the
    // leaderboard stores the exact same numbers it displays; adding again here
    // would double-count.
    if (!extensionIncluded) try {
      const { from: exDayFrom, to: exDayTo }   = bpDayBounds();
      const { from: exWeekFrom, to: exWeekTo } = bpWeekBounds();
      const ext = await extensionCountsForUser(sb, user.id, exDayFrom, exDayTo, exWeekFrom, exWeekTo);
      const TIDS = ['jump', 'shutdown', 'ddududu', 'ltal', 'go'];
      const hasAny = TIDS.some(id => ext.total[id] || ext.week[id] || ext.today[id]);
      if (hasAny) {
        for (const id of TIDS) {
          if (ext.total[id]) scores[`overall_${id}`] = (scores[`overall_${id}`] || 0) + ext.total[id];
          if (ext.week[id])  scores[`weekly_${id}`]  = (scores[`weekly_${id}`]  || 0) + ext.week[id];
          if (ext.today[id]) scores[`daily_${id}`]   = (scores[`daily_${id}`]   || 0) + ext.today[id];
        }
        const sum = (pre) => TIDS.reduce((n, id) => n + (scores[`${pre}_${id}`] || 0), 0);
        scores.overall_all = sum('overall');
        scores.daily_all   = sum('daily');
        scores.weekly_all  = sum('weekly');
      }
    } catch (e) { /* extension counts are best-effort; never block a submission */ }

    // Read current data, merge user entry, write back
    const data = (await redis.get(LB_KEY)) || { users: {} };
    data.users = data.users || {};

    if ((data.banned || []).includes(username.toLowerCase())) {
      return res.status(403).json({ error: 'This account is blocked from the leaderboard' });
    }

    // If the existing entry already has a custom displayName (one set by admin or
    // a prior explicit submission), keep it when the incoming submission is falling
    // back to the raw username — so a Last.fm name never silently overwrites a
    // human-readable alias like "Vivalalisa🌸".
    const existingEntry = data.users[username.toLowerCase()];
    if (existingEntry?.displayName && existingEntry.displayName !== existingEntry.username) {
      if (!displayName || displayName === username) {
        displayName = existingEntry.displayName;
      }
    }

    // Registered-value floor: a submission must never lower a count already
    // registered for the current day/week (a partial/slow load can compute less).
    // Counts only climb until the 2am-Rome reset; overall is left alone so a
    // disconnected scrobbler can still reduce it. Mirrors the cron's floor.
    if (existingEntry?.scores && scores) {
      const ex = existingEntry.scores;
      const TIDS = ['jump', 'shutdown', 'ddududu', 'ltal', 'go'];
      if (ex.daily_date === scores.daily_date) {
        for (const id of TIDS) scores[`daily_${id}`] = Math.max(scores[`daily_${id}`] || 0, ex[`daily_${id}`] || 0);
        scores.daily_all = TIDS.reduce((n, id) => n + (scores[`daily_${id}`] || 0), 0);
      }
      if (ex.weekly_start === scores.weekly_start) {
        for (const id of TIDS) scores[`weekly_${id}`] = Math.max(scores[`weekly_${id}`] || 0, ex[`weekly_${id}`] || 0);
        scores.weekly_all = TIDS.reduce((n, id) => n + (scores[`weekly_${id}`] || 0), 0);
      }
    }

    data.users[username.toLowerCase()] = {
      username,
      displayName: displayName || username,
      linkedAccounts: linkedAccounts || [{ type: 'lastfm', username }],
      avatar,
      scores,
      updatedAt,
      lastScrobbleAt,
      // Musicat/Stats.fm breakdown the badges page computed. Stored so the hourly
      // cron can re-add these providers without scraping them (it can't fetch them
      // reliably under load). Preserve the last one if this submission omitted it,
      // so a provider-less refresh path can't wipe a fan's provider contribution.
      providerScores: providerScores || existingEntry?.providerScores || null,
      // Supabase account that owns this entry. Used to scope cleanup/merge so a
      // submission can only ever remove ITS OWN other rows — never a different
      // signed-in account that happens to share a linked username.
      appUserId: user.id,
    };

    // Remove old per-account entries now merged into this combined entry.
    // Accounts are matched by SOURCE + username together — never username alone.
    // Two accounts that share a username but sit on different scrobblers (e.g.
    // "souralis" on Musicat vs. ListenBrainz) are DIFFERENT accounts and must
    // never fold/delete each other. The synthetic `extension` source is skipped
    // entirely: its username is a shared constant label ("Blinks United"), not an
    // identity, so it can never be a match key.
    if (Array.isArray(cleanupKeys) && Array.isArray(linkedAccounts)) {
      const src  = a => (a.type || a.source || '').toLowerCase();
      const pair = a => `${src(a)}:${(a.username || '').toLowerCase()}`;
      const ownedUsernames = new Set(
        linkedAccounts.filter(a => src(a) !== 'extension')
          .map(a => (a.username || '').toLowerCase()).filter(Boolean));
      const ownedPairs = new Set(
        linkedAccounts.filter(a => src(a) !== 'extension').map(pair));
      for (const k of cleanupKeys) {
        const kl = (k || '').toLowerCase();
        if (!kl || kl === username.toLowerCase() || !ownedUsernames.has(kl) || (data.banned || []).includes(kl)) continue;
        const target = data.users[kl];
        if (!target) continue;
        // Never touch a row owned by a DIFFERENT signed-in account.
        if (target.appUserId && target.appUserId !== user.id) continue;
        // For a legacy row (no owner), only fold it in when EVERY account it lists
        // is one this user owns, matched by source+username. This is what enforces
        // "same username, different scrobbler → keep both".
        if (!target.appUserId) {
          const tgtAccts = Array.isArray(target.linkedAccounts) && target.linkedAccounts.length
            ? target.linkedAccounts
            : [{ type: 'lastfm', username: target.username }];
          const allOwned = tgtAccts.every(a => src(a) !== 'extension' && ownedPairs.has(pair(a)));
          if (!allOwned) continue;
        }
        delete data.users[kl];
      }
    }

    // Defensive merge: cleanupKeys only covers keys the client itself knows to
    // expect (its current linkedAccounts' own usernames). If this identity's
    // "stable key" ever changed across past submissions -- e.g. an early
    // submission fell back to a different value before a Last.fm/session fetch
    // succeeded -- the old key is orphaned. Close that gap server-side by folding
    // in any other row owned by the SAME Supabase account, whatever raw key it
    // sits under. Ownership (appUserId) is the only safe signal here: a shared
    // linked username is NOT proof of the same person and must never delete
    // across accounts (that is how distinct users were wiping each other off the
    // board). Legacy rows with no recorded owner are left untouched — they get an
    // owner the next time that account submits.
    {
      const src  = a => (a.type || a.source || '').toLowerCase();
      const pair = a => `${src(a)}:${(a.username || '').toLowerCase()}`;
      const ownedPairs = new Set(
        (Array.isArray(linkedAccounts) ? linkedAccounts : [])
          .filter(a => src(a) !== 'extension').map(pair));
      const selfKey = username.toLowerCase();
      for (const [k, entry] of Object.entries(data.users)) {
        if (k === selfKey || (data.banned || []).includes(k)) continue;
        // Fold in another row only when it's provably THIS person's:
        //  - same Supabase owner id, OR
        //  - a legacy row (no owner) whose every non-extension account is one this
        //    user owns (by source+username) — e.g. an old duplicate keyed by the
        //    display name ("_demibandwout") rather than a scrobbler username. A
        //    shared username alone never qualifies (that is how distinct users used
        //    to wipe each other); the whole account set must be owned. Respects
        //    "same username, different scrobbler → keep both".
        let sameOwner;
        if (entry.appUserId) {
          sameOwner = entry.appUserId === user.id;
        } else {
          const accts = Array.isArray(entry.linkedAccounts) && entry.linkedAccounts.length
            ? entry.linkedAccounts
            : [{ type: 'lastfm', username: entry.username }];
          const real = accts.filter(a => src(a) !== 'extension');
          sameOwner = real.length > 0 && real.every(a => ownedPairs.has(pair(a)));
        }
        if (!sameOwner) continue;
        // Inherit a custom displayName from the entry being merged in, so it
        // survives when the new submission falls back to a raw username.
        if (entry.displayName && entry.displayName !== (entry.username || '')) {
          const myEntry = data.users[username.toLowerCase()];
          if (myEntry && (!myEntry.displayName || myEntry.displayName === username)) {
            myEntry.displayName = entry.displayName;
          }
        }
        delete data.users[k];
      }
    }

    data.lastUpdated = new Date().toISOString();
    updateLeaderStreak(data);
    await redis.set(LB_KEY, data);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, displayName: data.users[username.toLowerCase()]?.displayName || displayName });
  }

  // ── GET /api/leaderboard?action=goal-history — community goal streak ──
  if (req.method === 'GET' && action === 'goal-history') {
    const gh = (await redis.get(GOAL_HISTORY_KEY)) || { days: {} };
    const streak = computeGoalStreak(gh.days || {});
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ days: gh.days || {}, streak });
  }

  // ── POST /api/leaderboard?action=record-goal — record today's community goal status ──
  // Anyone can call this; total is always computed server-side from live leaderboard data.
  if (req.method === 'POST' && action === 'record-goal') {
    const todayKey = serverItalyDayKey(0);
    const gh = (await redis.get(GOAL_HISTORY_KEY)) || { days: {} };
    gh.days = gh.days || {};

    const lbData = (await redis.get(LB_KEY)) || { users: {} };
    const users   = lbData.users || {};
    const todayDDMM = (() => {
      const d = new Date(serverItalyDayKey(0) + 'T00:00:00Z');
      return `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}`;
    })();
    const secondaryKeys = new Set();
    for (const [k, d] of Object.entries(users)) {
      if (Array.isArray(d.linkedAccounts)) {
        for (const a of d.linkedAccounts) {
          const ak = (a.username || '').toLowerCase();
          if (ak && ak !== k) secondaryKeys.add(ak);
        }
      }
    }
    const total = Object.entries(users).reduce((sum, [k, d]) => {
      if (secondaryKeys.has(k.toLowerCase())) return sum;
      const s = d.scores || {};
      if (s.daily_date !== todayDDMM) return sum;
      return sum + (s.daily_jump || 0) + (s.daily_shutdown || 0) + (s.daily_ddududu || 0) + (s.daily_go || 0);
    }, 0);

    const GOAL_PRIMARY   = 15000;
    const GOAL_SECONDARY = 20000;
    const primary  = total >= GOAL_PRIMARY;
    const stretch  = total >= GOAL_SECONDARY;

    if (primary) {
      gh.days[todayKey] = { total, primary, stretch, recordedAt: new Date().toISOString() };
      await redis.set(GOAL_HISTORY_KEY, gh);
    }

    const streak = computeGoalStreak(gh.days);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, date: todayKey, total, primary, stretch, streak });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

