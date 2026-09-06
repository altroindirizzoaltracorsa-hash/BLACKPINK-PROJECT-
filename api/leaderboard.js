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

const GOAL_PRIMARY   = 15000;
const GOAL_SECONDARY = 20000;

// Community daily goal total = JUMP + Shut Down + DDU-DU DDU-DU + GO (Less Than a
// Lover intentionally excluded), summed across board entries whose daily_date
// matches `dayDDMM`, de-duplicating linked-account secondary keys. Identical to the
// client's computeDailyCommunityTotal and the cron's communityGoalTotal.
function communityGoalTotalFromUsers(users, dayDDMM) {
  const secondaryKeys = new Set();
  for (const [k, d] of Object.entries(users || {})) {
    if (Array.isArray(d.linkedAccounts)) {
      for (const a of d.linkedAccounts) {
        const ak = (a.username || '').toLowerCase();
        if (ak && ak !== k) secondaryKeys.add(ak);
      }
    }
  }
  return Object.entries(users || {}).reduce((sum, [k, d]) => {
    if (secondaryKeys.has(k.toLowerCase())) return sum;
    const s = d.scores || {};
    if (s.daily_date !== dayDDMM) return sum;
    // Whole campaign incl. the Fallen Angel EP — matches computeDailyCommunityTotal
    // (client) and communityGoalTotal in cron-scrobbles.js so all three agree.
    return sum + (s.daily_jump || 0) + (s.daily_shutdown || 0) + (s.daily_ddududu || 0) + (s.daily_go || 0)
      + (s.daily_ltal || 0) + (s.daily_fallenangel || 0) + (s.daily_heaven || 0) + (s.daily_sawadika || 0) + (s.daily_click || 0);
  }, 0);
}

// Aggregate the durable per-user/per-day store (user_daily_counts) into a
// { day_key: 4-track total } map — the accurate source the goal backfill uses
// (the leaderboard_archive snapshot undercounts days near the 2am rollover).
// Lets goal-history derive hit-days directly, so a day that was hit but never
// captured by a live record can't go missing.
async function aggregateGoalDaysFromCounts(sb) {
  const perDay = {};
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: rows, error } = await sb
      .from('user_daily_counts')
      .select('day_key,jump,shutdown,ddududu,go')
      .order('day_key', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const r of (rows || [])) {
      perDay[r.day_key] = (perDay[r.day_key] || 0) + (r.jump || 0) + (r.shutdown || 0) + (r.ddududu || 0) + (r.go || 0);
    }
    if (!rows || rows.length < PAGE) break;
  }
  return perDay;
}
const TRACK_EVENTS = new Set(['pageview', 'playlist_click', 'share_click', 'vote_click']);

// The Fallen Angel EP (Less Than a Lover + Fallen Angel + Heaven) counts toward the
// *_all ranking sums along with the four group tracks, so a new release lifts the
// leaderboard. LTAL's old reset cutoff no longer drops it — it's back as part of
// the EP. (Client mirror: CAMPAIGN_TOTAL_IDS in index.html.)
const LTAL_STOP_MS = Date.UTC(2026, 7, 17, 0, 0, 0); // 2026-08-17 00:00 UTC = 2 AM Rome
const rankTids = () => ['jump', 'shutdown', 'ddududu', 'ltal', 'go', 'sawadika', 'click', 'fallenangel', 'heaven'];


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
  const empty = () => ({ jump: 0, shutdown: 0, ddududu: 0, ltal: 0, go: 0, sawadika: 0, click: 0, fallenangel: 0, heaven: 0 });
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

  // ── GET /api/leaderboard?action=revert-auto-blink&key=ADMIN_SECRET[&dry=1] ──
  // One-off cleanup: an earlier build auto-assigned "blinkN" display names on every
  // sign-in, so existing fans who never chose a display name got converted too. This
  // clears display_name from every auth profile that (a) currently holds a ^blink\d+$
  // name AND (b) was created BEFORE the feature deployed — i.e. a pre-existing user,
  // never a genuine new signup. The next cron run relabels their board row back to
  // their handle. New signups (created after the cutoff) keep their blinkN. dry=1
  // previews without writing.
  if (req.method === 'GET' && action === 'revert-auto-blink') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
    const sb = supabase();
    if (!sb) return res.status(503).json({ error: 'Supabase not configured' });
    const CUTOFF = Date.parse('2026-08-13T12:02:30Z'); // feature deploy time (commit 8a110b1)
    const dry = req.query.dry === '1';
    const reverted = [], keptNew = [];
    let scanned = 0;
    try {
      for (let page = 1; page <= 100; page++) {
        const { data: au, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) return res.status(500).json({ error: error.message });
        const users = (au && au.users) || [];
        if (!users.length) break;
        scanned += users.length;
        for (const u of users) {
          const dn = ((u.user_metadata && u.user_metadata.display_name) || '').trim();
          if (!/^blink\d+$/i.test(dn)) continue;
          if (Date.parse(u.created_at || 0) >= CUTOFF) { keptNew.push(dn); continue; }
          if (dry) { reverted.push(dn); continue; }
          const md = Object.assign({}, u.user_metadata || {}, { display_name: null });
          const { error: upErr } = await sb.auth.admin.updateUserById(u.id, { user_metadata: md });
          if (upErr) return res.status(500).json({ error: `update ${u.id}: ${upErr.message}` });
          reverted.push(dn);
        }
      }
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    const numsort = (a, b) => (parseInt(a.slice(5)) || 0) - (parseInt(b.slice(5)) || 0);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ dry, scanned, revertedCount: reverted.length, reverted: reverted.sort(numsort), keptNew: keptNew.sort(numsort) });
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
  // Default board fetch — only when no action is given, so GET handlers defined
  // AFTER this point (e.g. ?action=goal-history) aren't shadowed by this catch-all.
  if (req.method === 'GET' && !action) {
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
  // Action-less POST = a leaderboard submission. Guard on !action so this generic
  // handler doesn't swallow the action-specific POST endpoints defined below
  // (record-goal, backfill-goal-history) — without this guard it returned 400 to
  // every one of them, which is why community-goal days were never recorded.
  if (req.method === 'POST' && !action) {
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
      const TIDS = ['jump', 'shutdown', 'ddududu', 'ltal', 'go', 'sawadika', 'click', 'fallenangel', 'heaven'];
      const hasAny = TIDS.some(id => ext.total[id] || ext.week[id] || ext.today[id]);
      if (hasAny) {
        for (const id of TIDS) {
          if (ext.total[id]) scores[`overall_${id}`] = (scores[`overall_${id}`] || 0) + ext.total[id];
          if (ext.week[id])  scores[`weekly_${id}`]  = (scores[`weekly_${id}`]  || 0) + ext.week[id];
          if (ext.today[id]) scores[`daily_${id}`]   = (scores[`daily_${id}`]   || 0) + ext.today[id];
        }
        const sum = (pre) => rankTids().reduce((n, id) => n + (scores[`${pre}_${id}`] || 0), 0);
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
      const TIDS = ['jump', 'shutdown', 'ddududu', 'ltal', 'go', 'sawadika', 'click', 'fallenangel', 'heaven'];
      if (ex.daily_date === scores.daily_date) {
        for (const id of TIDS) scores[`daily_${id}`] = Math.max(scores[`daily_${id}`] || 0, ex[`daily_${id}`] || 0);
        scores.daily_all = rankTids().reduce((n, id) => n + (scores[`daily_${id}`] || 0), 0);
      }
      if (ex.weekly_start === scores.weekly_start) {
        for (const id of TIDS) scores[`weekly_${id}`] = Math.max(scores[`weekly_${id}`] || 0, ex[`weekly_${id}`] || 0);
        scores.weekly_all = rankTids().reduce((n, id) => n + (scores[`weekly_${id}`] || 0), 0);
      }
    }

    // Fallen Angel EP tracks (Fallen Angel / Heaven) are computed only by the hourly
    // cron, never by the client submit — and they're intentionally kept OUT of the
    // campaign *_all sums. A client submit replaces the whole scores object, so carry
    // the cron's EP values forward here or a badges visit would zero those boards
    // until the next cron run. Overall is cumulative (always preserved); daily/weekly
    // only when the submit is for the same day/week the cron last wrote.
    if (existingEntry?.scores && scores) {
      const ex = existingEntry.scores;
      for (const id of ['fallenangel', 'heaven', 'sawadika', 'click']) {
        if (scores[`overall_${id}`] == null && ex[`overall_${id}`] != null) scores[`overall_${id}`] = ex[`overall_${id}`];
        if (ex.daily_date === scores.daily_date && scores[`daily_${id}`] == null && ex[`daily_${id}`] != null) scores[`daily_${id}`] = ex[`daily_${id}`];
        if (ex.weekly_start === scores.weekly_start && scores[`weekly_${id}`] == null && ex[`weekly_${id}`] != null) scores[`weekly_${id}`] = ex[`weekly_${id}`];
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

    // ── Durable per-day persist (user_daily_counts) ──────────────────────────
    // The submit above only updates the Redis board (the streaming leaderboard).
    // Mirror this account's daily campaign counts into user_daily_counts too — the
    // durable store the VOTING board (vma_vote_board) and badges history read. Only
    // the server-side cron used to write it, so any account whose streams the cron
    // can't re-pull (extension / Musicat / Stats.fm / a private Last.fm profile)
    // showed real numbers on the streaming board but 0 on the voting board. Persist
    // it live here, keyed on the SAME (app_user_id, day_key) the cron uses, and
    // max-merged so a late/low submit can never lower the day.
    try {
      const dk = serverItalyDayKey(0);              // streaming-day UTC date, == cron's day_key
      const [, mm, dd] = dk.split('-');
      const todayLabel = `${dd}/${mm}`;             // DD/MM, matches scores.daily_date
      const sc = data.users[username.toLowerCase()]?.scores || scores || {};
      // Only persist counts that belong to the current streaming day (a stale
      // submit carrying yesterday's daily_* must not inflate today's row).
      if (!sc.daily_date || sc.daily_date === todayLabel) {
        const CORE = ['jump', 'shutdown', 'ddududu', 'ltal', 'go'];
        const NR   = ['sawadika', 'click', 'fallenangel', 'heaven'];
        const val  = id => Math.max(0, Number(sc[`daily_${id}`]) || 0);
        // Read only the always-present core columns here so this can't throw on a
        // deploy that predates the new-release migration.
        const { data: exRows } = await sb
          .from('user_daily_counts')
          .select('jump,shutdown,ddududu,ltal,go')
          .eq('app_user_id', user.id).eq('day_key', dk).limit(1);
        const ex = (exRows && exRows[0]) || {};
        const core = { app_user_id: user.id, day_key: dk, updated_at: new Date().toISOString() };
        for (const id of CORE) core[id] = Math.max(val(id), Number(ex[id]) || 0);
        await sb.from('user_daily_counts').upsert(core, { onConflict: 'app_user_id,day_key' });
        // New-release columns in a SEPARATE guarded upsert (same pattern as the
        // cron): a deploy before those columns are migrated just no-ops here
        // instead of failing the core write above. Reads its own existing values so
        // the max-merge can't lower a count another writer already persisted.
        try {
          const { data: nrEx } = await sb
            .from('user_daily_counts')
            .select('sawadika,click,fallenangel,heaven')
            .eq('app_user_id', user.id).eq('day_key', dk).limit(1);
          const pe = (nrEx && nrEx[0]) || {};
          const nr = { app_user_id: user.id, day_key: dk };
          for (const id of NR) nr[id] = Math.max(val(id), Number(pe[id]) || 0);
          await sb.from('user_daily_counts').upsert(nr, { onConflict: 'app_user_id,day_key' });
        } catch (_) { /* new-release columns not migrated yet */ }
      }
    } catch (e) {
      console.error('user_daily_counts live persist failed:', e?.message || e);
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, displayName: data.users[username.toLowerCase()]?.displayName || displayName });
  }

  // ── GET /api/leaderboard?action=goal-history — community goal streak ──
  // Self-healing: merges any explicitly-recorded days with days DERIVED from the
  // durable per-day store, so a goal that was hit but never captured live (no
  // visitor / cron at the right moment) still shows up. Derivation is cached
  // ~10 min since past-day rows are immutable.
  if (req.method === 'GET' && action === 'goal-history') {
    const gh = (await redis.get(GOAL_HISTORY_KEY)) || { days: {} };
    const merged = {};
    for (const [k, v] of Object.entries(gh.days || {})) merged[k] = { ...v };

    try {
      const sb = supabase();
      if (sb) {
        const CACHE_KEY = 'bu_goal_days_derived_v1';
        let derived;
        const cached = await redis.get(CACHE_KEY);
        if (cached && cached.computedAt && (Date.now() - cached.computedAt) < 10 * 60 * 1000) {
          derived = cached.days || {};
        } else {
          derived = await aggregateGoalDaysFromCounts(sb);
          await redis.set(CACHE_KEY, { days: derived, computedAt: Date.now() });
        }
        for (const [k, total] of Object.entries(derived)) {
          if (total >= GOAL_PRIMARY && total >= (merged[k]?.total || 0)) {
            merged[k] = { total, primary: true, stretch: total >= GOAL_SECONDARY, derived: true };
          }
        }
      }
    } catch (_) { /* fall back to recorded days only */ }

    const streak = computeGoalStreak(merged);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ days: merged, streak });
  }

  // ── POST /api/leaderboard?action=backfill-goal-history&key=ADMIN[&dry=1] ──
  // Recover community-goal days that were hit but never recorded (the old path
  // only wrote a day if a visitor loaded the home page while the goal showed hit).
  // Walks the finalized daily leaderboard_archive snapshots, recomputes each day's
  // 4-track community total with the shared formula, and records any day ≥ goal
  // that isn't already stored (or is stored lower). Idempotent; ?dry=1 previews.
  if (req.method === 'POST' && action === 'backfill-goal-history') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
    const dry = req.query.dry === '1';
    const sb = supabase();
    if (!sb) return res.status(503).json({ error: 'Server not configured' });

    // Aggregate the durable per-user/per-day store (user_daily_counts), NOT the
    // whole-board leaderboard_archive snapshot: the snapshot is frozen at the 2am
    // rollover and loses any user who already flipped to the new day, so it badly
    // undercounts a day's true community total. user_daily_counts is max-merged
    // per (app_user_id, day_key) and never lowered, so it's the accurate source.
    // One row per user per day, so no linked-account de-dup is needed.
    const perDay4 = {}; // goal 4 tracks (JUMP+Shut Down+DDU-DU+GO)
    const perDay5 = {}; // incl. Less Than a Lover, for reporting only
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: rows, error } = await sb
        .from('user_daily_counts')
        .select('day_key,jump,shutdown,ddududu,ltal,go')
        .order('day_key', { ascending: false })
        .range(from, from + PAGE - 1);
      if (error) return res.status(500).json({ error: error.message });
      for (const r of (rows || [])) {
        const four = (r.jump||0) + (r.shutdown||0) + (r.ddududu||0) + (r.go||0);
        perDay4[r.day_key] = (perDay4[r.day_key] || 0) + four;
        perDay5[r.day_key] = (perDay5[r.day_key] || 0) + four + (r.ltal||0);
      }
      if (!rows || rows.length < PAGE) break;
    }

    const gh = (await redis.get(GOAL_HISTORY_KEY)) || { days: {} };
    gh.days = gh.days || {};
    const recorded = [], skipped = [];
    for (const key of Object.keys(perDay4).sort().reverse()) {
      const total    = perDay4[key];
      const existing = gh.days[key]?.total || 0;
      if (total >= GOAL_PRIMARY && total > existing) {
        if (!dry) gh.days[key] = { total, primary: true, stretch: total >= GOAL_SECONDARY, recordedAt: new Date().toISOString(), backfilled: true };
        recorded.push({ day: key, total, stretch: total >= GOAL_SECONDARY, was: existing || null });
      } else {
        skipped.push({ day: key, total, withLtal: perDay5[key], alreadyHas: existing || null });
      }
    }
    if (!dry && recorded.length) await redis.set(GOAL_HISTORY_KEY, gh);
    const streak = computeGoalStreak(gh.days);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ dry, daysScanned: Object.keys(perDay4).length, recordedCount: recorded.length, recorded, skippedCount: skipped.length, skipped, streak });
  }

  // ── POST /api/leaderboard?action=sync-daily-counts&key=ADMIN[&dry=1][&name=] ──
  // Sync TODAY's Redis board (the streaming leaderboard, which updates live on every
  // client/extension submit) into the durable user_daily_counts table (which the
  // VOTING board + badges read, and which otherwise only the server-side cron pull
  // writes). Fixes the same-day gap for any account whose streams the cron can't
  // re-pull (extension / Musicat / Stats.fm / private Last.fm): they show real
  // numbers on the streaming board but 0 on the voting board until this runs.
  // Max-merged per (app_user_id, day_key) so it can only ever RAISE a count.
  // Idempotent; ?dry=1 previews; ?name= filters the report to one display name.
  if (req.method === 'POST' && action === 'sync-daily-counts') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
    const dry  = req.query.dry === '1';
    const only = (req.query.name || '').trim().toLowerCase();
    const sb = supabase();
    if (!sb) return res.status(503).json({ error: 'Server not configured' });

    const dk = serverItalyDayKey(0);
    const [, mm, dd] = dk.split('-');
    const todayLabel = `${dd}/${mm}`;
    const CORE = ['jump', 'shutdown', 'ddududu', 'ltal', 'go'];
    const NR   = ['sawadika', 'click', 'fallenangel', 'heaven'];

    const data = (await redis.get(LB_KEY)) || { users: {} };
    // One candidate row per signed-in owner (appUserId). If two linked-account
    // entries share an owner, keep the max of each daily_* so we never undercount.
    const cand = new Map(); // appUserId -> { name, vals:{id:count} }
    for (const [, u] of Object.entries(data.users || {})) {
      const uid = u?.appUserId;
      const s = u?.scores || {};
      if (!uid || s.daily_date !== todayLabel) continue;
      const name = u.displayName || u.username || '';
      const prev = cand.get(uid) || { name, vals: {} };
      for (const id of [...CORE, ...NR]) {
        prev.vals[id] = Math.max(prev.vals[id] || 0, Math.max(0, Number(s[`daily_${id}`]) || 0));
      }
      if (u.displayName) prev.name = u.displayName;
      cand.set(uid, prev);
    }

    const ids = [...cand.keys()];
    // Existing rows for today, so the upsert only ever raises a value.
    const exMap = new Map();
    for (let from = 0; from < ids.length; from += 500) {
      const slice = ids.slice(from, from + 500);
      const { data: rows, error } = await sb
        .from('user_daily_counts')
        .select('app_user_id,jump,shutdown,ddududu,ltal,go,sawadika,click,fallenangel,heaven')
        .eq('day_key', dk).in('app_user_id', slice);
      if (error) return res.status(500).json({ error: error.message });
      for (const r of (rows || [])) exMap.set(r.app_user_id, r);
    }

    const now = new Date().toISOString();
    const coreRows = [], nrRows = [], changed = [];
    for (const [uid, c] of cand) {
      const ex = exMap.get(uid) || {};
      const core = { app_user_id: uid, day_key: dk, updated_at: now };
      const nr   = { app_user_id: uid, day_key: dk };
      let raised = false;
      for (const id of CORE) { const v = Math.max(c.vals[id] || 0, Number(ex[id]) || 0); core[id] = v; if (v > (Number(ex[id]) || 0)) raised = true; }
      for (const id of NR)   { const v = Math.max(c.vals[id] || 0, Number(ex[id]) || 0); nr[id]   = v; if (v > (Number(ex[id]) || 0)) raised = true; }
      coreRows.push(core); nrRows.push(nr);
      if (raised) changed.push({ name: c.name, appUserId: uid, ...CORE.reduce((o,id)=>(o[id]=core[id],o),{}), ...NR.reduce((o,id)=>(o[id]=nr[id],o),{}) });
    }

    if (!dry && coreRows.length) {
      for (let from = 0; from < coreRows.length; from += 500) {
        const { error } = await sb.from('user_daily_counts')
          .upsert(coreRows.slice(from, from + 500), { onConflict: 'app_user_id,day_key' });
        if (error) return res.status(500).json({ error: error.message });
      }
      try {
        for (let from = 0; from < nrRows.length; from += 500) {
          const { error } = await sb.from('user_daily_counts')
            .upsert(nrRows.slice(from, from + 500), { onConflict: 'app_user_id,day_key' });
          if (error) throw error;
        }
      } catch (e) { console.error('sync-daily-counts new-release upsert failed (columns migrated yet?):', e?.message || e); }
    }

    const report = only ? changed.filter(c => (c.name || '').toLowerCase().includes(only)) : changed;
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      dry, day_key: dk, todayLabel,
      candidates: cand.size, raisedCount: changed.length,
      changed: report.slice(0, 200),
    });
  }

  // ── POST /api/leaderboard?action=repair-daily-archive&key=ADMIN&day=YYYY-MM-DD[&dry=1] ──
  // Repair a finalized daily board that froze early-bird visitors' NEXT-day counts
  // (the rollover-archive race). Overrides each user's daily_* in the archived
  // snapshot with the accurate, max-merged user_daily_counts for that day, matched
  // by appUserId. Idempotent; ?dry=1 previews.
  if (req.method === 'POST' && action === 'repair-daily-archive') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
    const day = (req.query.day || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'day=YYYY-MM-DD required' });
    const dry = req.query.dry === '1';
    const sb = supabase();
    if (!sb) return res.status(503).json({ error: 'Server not configured' });

    const { data: arch, error: aerr } = await sb
      .from('leaderboard_archive')
      .select('period_key, users')
      .eq('period', 'daily').eq('period_key', day).maybeSingle();
    if (aerr) return res.status(500).json({ error: aerr.message });
    if (!arch) return res.status(404).json({ error: 'No archive for that day' });

    const udc = {};
    for (let from = 0; ; from += 1000) {
      const { data: rows, error } = await sb
        .from('user_daily_counts')
        .select('app_user_id,jump,shutdown,ddududu,ltal,go')
        .eq('day_key', day)
        .range(from, from + 999);
      if (error) return res.status(500).json({ error: error.message });
      for (const r of (rows || [])) udc[r.app_user_id] = r;
      if (!rows || rows.length < 1000) break;
    }

    const [, M, D] = day.split('-');
    const dayDDMM = `${D}/${M}`;
    const users = arch.users || {};
    const changed = [];
    let unrecoverable = 0;
    for (const [k, u] of Object.entries(users)) {
      // Prefer the owner id; fall back to the "user_<leaderboard name>" recovery key
      // the cron writes for entries whose owner id it can't resolve. (k is the
      // archive's entry key = displayName.toLowerCase(), matching that recovery key.)
      let c = u.appUserId && udc[u.appUserId];
      if (!c) c = udc[`user_${(u.displayName || k).toLowerCase()}`];
      const s = u.scores || (u.scores = {});
      const flipped = s.daily_date && s.daily_date !== dayDDMM; // archive froze a different day
      if (c) {
        // Flipped entries hold the WRONG day's counts → replace outright with the
        // durable day counts. Same-day entries → take the max so a repair can never
        // LOWER a value the finalized board legitimately floored higher.
        const nj  = flipped ? (c.jump||0)     : Math.max(s.daily_jump||0,     c.jump||0);
        const nsd = flipped ? (c.shutdown||0) : Math.max(s.daily_shutdown||0, c.shutdown||0);
        const nd  = flipped ? (c.ddududu||0)  : Math.max(s.daily_ddududu||0,  c.ddududu||0);
        const nl  = flipped ? (c.ltal||0)     : Math.max(s.daily_ltal||0,     c.ltal||0);
        const ng  = flipped ? (c.go||0)       : Math.max(s.daily_go||0,       c.go||0);
        const newAll = nj + nsd + nd + nl + ng;
        if (newAll !== (s.daily_all || 0) || s.daily_date !== dayDDMM) {
          changed.push({ name: u.displayName || k, was: s.daily_all || 0, now: newAll, wasDate: s.daily_date, flipped });
          if (!dry) {
            s.daily_jump = nj; s.daily_shutdown = nsd; s.daily_ddududu = nd;
            s.daily_ltal = nl; s.daily_go = ng; s.daily_all = newAll; s.daily_date = dayDDMM;
          }
        }
      } else if (flipped) {
        unrecoverable++; // flipped to another day, no durable counts to recover from
      }
    }
    changed.sort((a, b) => b.now - a.now);
    if (!dry && changed.length) {
      const { error: uerr } = await sb.from('leaderboard_archive')
        .update({ users }).eq('period', 'daily').eq('period_key', day);
      if (uerr) return res.status(500).json({ error: uerr.message });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ dry, day, changedCount: changed.length, unrecoverable, changed: changed.slice(0, 60) });
  }

  // ── POST /api/leaderboard?action=purge-handle-keys&key=ADMIN[&dry=1] ──
  // One-off cleanup: delete the stray "h:<handle>" recovery rows that the
  // short-lived earlier fallback wrote to user_daily_counts, now superseded by the
  // "user_<name>" recovery rows. ?dry=1 previews the matches without deleting.
  if (req.method === 'POST' && action === 'purge-handle-keys') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
    const dry = req.query.dry === '1';
    const sb = supabase();
    if (!sb) return res.status(503).json({ error: 'Server not configured' });

    const { data: rows, error } = await sb
      .from('user_daily_counts')
      .select('app_user_id,day_key')
      .like('app_user_id', 'h:%')
      .limit(10000);
    if (error) return res.status(500).json({ error: error.message });
    const sample = (rows || []).slice(0, 60).map(r => `${r.app_user_id}@${r.day_key}`);
    if (!dry && rows && rows.length) {
      const { error: derr } = await sb.from('user_daily_counts').delete().like('app_user_id', 'h:%');
      if (derr) return res.status(500).json({ error: derr.message });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ dry, matched: (rows || []).length, sample });
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
    const total = communityGoalTotalFromUsers(users, todayDDMM);

    const primary  = total >= GOAL_PRIMARY;
    const stretch  = total >= GOAL_SECONDARY;

    if (primary) {
      // Never lower an already-recorded day (counts only climb until the 2am reset).
      const merged = Math.max(total, gh.days[todayKey]?.total || 0);
      gh.days[todayKey] = { total: merged, primary: true, stretch: merged >= GOAL_SECONDARY, recordedAt: new Date().toISOString() };
      await redis.set(GOAL_HISTORY_KEY, gh);
    }

    const streak = computeGoalStreak(gh.days);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, date: todayKey, total, primary, stretch, streak });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

