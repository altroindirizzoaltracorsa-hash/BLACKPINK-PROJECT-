import { Redis } from '@upstash/redis';
import { createClient } from '@supabase/supabase-js';

const redis = Redis.fromEnv();
const LASTFM_KEY  = '666b8ef2f3cc360fbc20df275fba2981';
const LASTFM_BASE = 'https://ws.audioscrobbler.com/2.0/';
const LB_BASE     = 'https://api.listenbrainz.org/1/';
const LB_KEY      = 'bu_leaderboard_v1';

function supabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

const TRACKS = [
  { id: 'jump',     artist: 'BLACKPINK', track: 'JUMP' },
  { id: 'shutdown', artist: 'BLACKPINK', track: 'Shut Down' },
  { id: 'ddududu',  artist: 'BLACKPINK', track: 'DDU-DU DDU-DU' },
];

// ── Italy 2am reset (same logic as client) ────────────────────
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
function getDayBounds() {
  const offset = getItalyOffset();
  const it = new Date(Date.now() + offset * 3600 * 1000);
  const y = it.getUTCFullYear(), m = it.getUTCMonth(), d = it.getUTCDate();
  const hour = it.getUTCHours();
  let dayStart = new Date(Date.UTC(y, m, d, 2 - offset, 0, 0));
  if (hour < 2) dayStart = new Date(dayStart.getTime() - 86400000);
  return { from: Math.floor(dayStart / 1000), to: Math.floor((dayStart.getTime() + 86400000) / 1000) };
}
function getWeekBounds() {
  const { from: dayFrom } = getDayBounds();
  const dayFromDate = new Date(dayFrom * 1000);
  const dow = dayFromDate.getUTCDay();
  const daysToMon = dow === 0 ? 6 : dow - 1;
  const weekStart = new Date(dayFromDate.getTime() - daysToMon * 86400000);
  return { from: Math.floor(weekStart / 1000), to: Math.floor((weekStart.getTime() + 7 * 86400000) / 1000) };
}
function ddmm(date) {
  return `${String(date.getUTCDate()).padStart(2,'0')}/${String(date.getUTCMonth()+1).padStart(2,'0')}`;
}
function dayKey(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function fullDateLabel(date) {
  return `${String(date.getUTCDate()).padStart(2,'0')}/${String(date.getUTCMonth()+1).padStart(2,'0')}/${date.getUTCFullYear()}`;
}

// ── Past-leaderboard archive ───────────────────────────────────
async function archivePeriod(sb, period, periodKey, label, users) {
  if (!sb || !periodKey || !Object.keys(users).length) return;
  await sb.from('leaderboard_archive').upsert(
    { period, period_key: periodKey, label, users, archived_at: new Date().toISOString() },
    { onConflict: 'period,period_key' }
  );
}

// ── Daily badge tiers ─────────────────────────────────────────
const TIER_ICONS = ['🩷','💓','💗','💖','💝','⚡','🌟','👑','🔥','✨'];
function makeDailyTiers(base, shortName) {
  return TIER_ICONS.map((icon, i) => ({ min: base * (i + 1), mult: i + 1, label: `${shortName} ×${i + 1}`, icon }));
}
const DAILY_TIERS = {
  jump:     makeDailyTiers(80, 'JUMP'),
  shutdown: makeDailyTiers(36, 'SHUT DOWN'),
  ddududu:  makeDailyTiers(20, 'DDU-DU'),
};
function getDailyBadge(trackId, count) {
  const tiers = DAILY_TIERS[trackId] || [];
  let badge = null;
  for (const t of tiers) { if (count >= t.min) badge = t; }
  return badge;
}
function buildTodayStamps(todayCounts) {
  const stamps = {};
  for (const t of TRACKS) {
    const count = todayCounts[t.id] || 0;
    const badge = getDailyBadge(t.id, count);
    if (badge) stamps[t.id] = { mult: badge.mult, icon: badge.icon, label: badge.label, count };
  }
  return stamps;
}

async function persistStamp(sb, username, todayKey, stamps) {
  if (!sb || !Object.keys(stamps).length) return;
  const { data } = await sb.from('user_stamps').select('stamps')
    .eq('lfm_username', username).eq('day_key', todayKey).maybeSingle();
  const merged = data?.stamps || {};
  for (const [id, s] of Object.entries(stamps)) {
    if (!merged[id] || s.mult >= merged[id].mult) merged[id] = s;
  }
  await sb.from('user_stamps').upsert(
    { lfm_username: username, day_key: todayKey, stamps: merged, updated_at: new Date().toISOString() },
    { onConflict: 'lfm_username,day_key' }
  );
}

// ── Last.fm helpers ───────────────────────────────────────────
const LASTFM_RETRYABLE_ERRORS = new Set([8, 11, 16]);

async function lfmFetch(params, attempt = 0) {
  const url = LASTFM_BASE + '?' + new URLSearchParams({ ...params, api_key: LASTFM_KEY, format: 'json' });
  let data;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Last.fm HTTP ${r.status}`);
    data = await r.json();
  } catch (e) {
    if (attempt < 2) {
      await new Promise(res => setTimeout(res, 500 * 3 ** attempt));
      return lfmFetch(params, attempt + 1);
    }
    throw e;
  }
  if (data?.error) {
    if (LASTFM_RETRYABLE_ERRORS.has(data.error) && attempt < 2) {
      await new Promise(res => setTimeout(res, 500 * 3 ** attempt));
      return lfmFetch(params, attempt + 1);
    }
    throw new Error(`Last.fm error ${data.error}: ${data.message || ''}`);
  }
  return data;
}

async function fetchTrackPlays(username, artist, track) {
  const d = await lfmFetch({ method: 'track.getInfo', artist, track, username });
  return parseInt(d?.track?.userplaycount || '0', 10);
}

async function fetchArtistPlays(username, artist) {
  const d = await lfmFetch({ method: 'artist.getInfo', artist, username });
  return parseInt(d?.artist?.stats?.userplaycount || '0', 10);
}

async function fetchRecentScrobbles(username, from, to, maxPages = 50) {
  const results = [];
  let page = 1;
  while (true) {
    const d = await lfmFetch({ method: 'user.getRecentTracks', user: username, from, to, limit: 200, page });
    const tracks = d?.recenttracks?.tracks || d?.recenttracks?.track || [];
    const arr = Array.isArray(tracks) ? tracks : [tracks];
    results.push(...arr.filter(t => t['@attr']?.nowplaying !== 'true'));
    const total = parseInt(d?.recenttracks?.['@attr']?.totalPages || '1');
    if (page >= total || page >= maxPages) break;
    page++;
  }
  return results;
}

function countByTrack(scrobbles) {
  const counts = {};
  for (const t of TRACKS) counts[t.id] = 0;
  for (const s of scrobbles) {
    const name   = (s.name || '').toLowerCase();
    const artist = (s.artist?.['#text'] || s.artist || '').toLowerCase();
    if (artist.includes('blackpink')) {
      for (const t of TRACKS) {
        if (name === t.track.toLowerCase()) { counts[t.id]++; break; }
      }
    }
  }
  return counts;
}

// ── ListenBrainz helpers ──────────────────────────────────────
async function lbFetch(path, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const r = await fetch(LB_BASE + path + qs, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`ListenBrainz HTTP ${r.status}`);
  return r.json();
}

// Returns campaign track play counts from the user's top-100 all-time recordings.
// Tracks outside the top 100 will show 0 — acceptable for users active enough
// to appear on the leaderboard.
async function fetchLbTrackCounts(username) {
  const counts = { jump: 0, shutdown: 0, ddududu: 0 };
  const d = await lbFetch(`stats/user/${encodeURIComponent(username)}/recordings`, { count: 100, range: 'all_time' });
  for (const rec of d?.payload?.recordings || []) {
    const name   = (rec.track_name  || '').toLowerCase().trim();
    const artist = (rec.artist_name || '').toLowerCase();
    if (!artist.includes('blackpink')) continue;
    if (name === 'jump')               counts.jump     += rec.listen_count || 0;
    else if (name === 'shut down')     counts.shutdown += rec.listen_count || 0;
    else if (name === 'ddu-du ddu-du') counts.ddududu  += rec.listen_count || 0;
  }
  return counts;
}

async function fetchLbArtistPlays(username) {
  try {
    const d = await lbFetch(`stats/user/${encodeURIComponent(username)}/artists`, { count: 100, range: 'all_time' });
    const bp = (d?.payload?.artists || []).find(a => (a.artist_name || '').toLowerCase().includes('blackpink'));
    return bp?.listen_count || 0;
  } catch { return 0; }
}

async function fetchLbRecentListens(username, from, to) {
  const results = [];
  let maxTs = to;
  for (let page = 0; page < 50; page++) {
    const d = await lbFetch(`user/${encodeURIComponent(username)}/listens`, { min_ts: from, max_ts: maxTs, count: 100 });
    const listens = d?.payload?.listens || [];
    if (!listens.length) break;
    results.push(...listens);
    if (listens.length < 100) break;
    maxTs = listens[listens.length - 1].listened_at - 1;
    if (maxTs < from) break;
  }
  return results;
}

function countLbByTrack(listens) {
  const counts = { jump: 0, shutdown: 0, ddududu: 0 };
  for (const l of listens) {
    const name   = (l.track_metadata?.track_name   || '').toLowerCase().trim();
    const artist = (l.track_metadata?.artist_name  || '').toLowerCase();
    if (!artist.includes('blackpink')) continue;
    if (name === 'jump')               counts.jump++;
    else if (name === 'shut down')     counts.shutdown++;
    else if (name === 'ddu-du ddu-du') counts.ddududu++;
  }
  return counts;
}

// ── Per-account score fetchers ────────────────────────────────

async function fetchLastFmScores(username, dayFrom, dayTo, weekFrom, prevLastScrobbleAt) {
  const [artistPlays, jumpPlays, shutdownPlays, ddududuPlays, todayScrobbles] =
    await Promise.all([
      fetchArtistPlays(username, 'BLACKPINK'),
      fetchTrackPlays(username, 'BLACKPINK', 'JUMP'),
      fetchTrackPlays(username, 'BLACKPINK', 'Shut Down'),
      fetchTrackPlays(username, 'BLACKPINK', 'DDU-DU DDU-DU'),
      fetchRecentScrobbles(username, dayFrom, dayTo),
    ]);

  const totalPlays  = { jump: jumpPlays, shutdown: shutdownPlays, ddududu: ddududuPlays };
  const todayCounts = countByTrack(todayScrobbles);

  const weekCounts = { jump: 0, shutdown: 0, ddududu: 0 };
  let lastScrobbleAt = prevLastScrobbleAt || null;

  for (let i = 0; i < 7; i++) {
    const dayStart = weekFrom + i * 86400;
    const dayEnd   = dayStart + 86400;
    if (dayStart > Math.floor(Date.now() / 1000)) break;
    const daySc = await fetchRecentScrobbles(username, dayStart, dayEnd);
    const dc = countByTrack(daySc);
    weekCounts.jump     += dc.jump     || 0;
    weekCounts.shutdown += dc.shutdown || 0;
    weekCounts.ddududu  += dc.ddududu  || 0;
    const bpDay = daySc.filter(s =>
      (s.artist?.['#text'] || '').toLowerCase().includes('blackpink') && s.date?.uts
    );
    if (bpDay.length) {
      const ts = new Date(parseInt(bpDay[0].date.uts) * 1000).toISOString();
      if (!lastScrobbleAt || ts > lastScrobbleAt) lastScrobbleAt = ts;
    }
  }

  return { totalPlays, todayCounts, weekCounts, artistPlays, lastScrobbleAt };
}

async function fetchLbScores(username, dayFrom, dayTo, weekFrom) {
  const [totalPlays, artistPlays, todayListens] = await Promise.all([
    fetchLbTrackCounts(username),
    fetchLbArtistPlays(username),
    fetchLbRecentListens(username, dayFrom, dayTo),
  ]);

  const todayCounts = countLbByTrack(todayListens);
  const weekCounts  = { jump: 0, shutdown: 0, ddududu: 0 };

  for (let i = 0; i < 7; i++) {
    const dayStart = weekFrom + i * 86400;
    const dayEnd   = dayStart + 86400;
    if (dayStart > Math.floor(Date.now() / 1000)) break;
    const dayListens = await fetchLbRecentListens(username, dayStart, dayEnd);
    const dc = countLbByTrack(dayListens);
    weekCounts.jump     += dc.jump     || 0;
    weekCounts.shutdown += dc.shutdown || 0;
    weekCounts.ddududu  += dc.ddududu  || 0;
  }

  return { totalPlays, todayCounts, weekCounts, artistPlays, lastScrobbleAt: null };
}

// Same ranking + tie-break as the client's Overall · All Tracks leaderboard
// view, so the tracked leader always matches whoever is actually shown as #1.
function computeLeader(users) {
  const entries = Object.values(users || {}).map(u => ({
    username: u.displayName || u.username,
    score: u.scores?.overall_all || 0,
  }));
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

// ── Refresh one user's scores ─────────────────────────────────
// Supports both the old format (entry.username = Last.fm username, no
// linkedAccounts) and the new format (entry.linkedAccounts = [{type,username}]).
async function refreshUser(entry, sb) {
  const linkedAccounts = entry.linkedAccounts || [{ type: 'lastfm', username: entry.username }];
  const displayName    = entry.displayName    || entry.username;

  const { from: dayFrom, to: dayTo } = getDayBounds();
  const { from: weekFrom }           = getWeekBounds();

  const totalPlays  = { jump: 0, shutdown: 0, ddududu: 0 };
  const todayCounts = { jump: 0, shutdown: 0, ddududu: 0 };
  const weekCounts  = { jump: 0, shutdown: 0, ddududu: 0 };
  let artistPlays   = 0;
  let lastScrobbleAt = entry.lastScrobbleAt || null;

  for (const account of linkedAccounts) {
    try {
      let scores;
      if (account.type === 'lastfm') {
        scores = await fetchLastFmScores(account.username, dayFrom, dayTo, weekFrom, lastScrobbleAt);
        if (scores.lastScrobbleAt && (!lastScrobbleAt || scores.lastScrobbleAt > lastScrobbleAt)) {
          lastScrobbleAt = scores.lastScrobbleAt;
        }
      } else if (account.type === 'listenbrainz') {
        scores = await fetchLbScores(account.username, dayFrom, dayTo, weekFrom);
      } else {
        continue;
      }
      for (const k of ['jump', 'shutdown', 'ddududu']) {
        totalPlays[k]  += scores.totalPlays[k]  || 0;
        todayCounts[k] += scores.todayCounts[k] || 0;
        weekCounts[k]  += scores.weekCounts[k]  || 0;
      }
      artistPlays += scores.artistPlays || 0;
    } catch (e) {
      console.error(`refresh ${account.type}:${account.username}:`, e.message);
    }
  }

  // Persist stamps for the primary Last.fm account (stamps are keyed by LFM username in Supabase)
  const primaryLfm = linkedAccounts.find(a => a.type === 'lastfm');
  if (primaryLfm) {
    try {
      await persistStamp(sb, primaryLfm.username, dayKey(dayFrom), buildTodayStamps(todayCounts));
    } catch {}
  }

  const todayLabel     = ddmm(new Date(dayFrom * 1000));
  const weekStartLabel = ddmm(new Date(weekFrom * 1000));
  const campaignTotal  = totalPlays.jump + totalPlays.shutdown + totalPlays.ddududu;

  return {
    displayName,
    username:      displayName,
    linkedAccounts,
    avatar:        entry.avatar,
    updatedAt:     new Date().toISOString(),
    lastScrobbleAt,
    scores: {
      overall_all:      campaignTotal,
      overall_jump:     totalPlays.jump,
      overall_shutdown: totalPlays.shutdown,
      overall_ddududu:  totalPlays.ddududu,
      overall_artist:   artistPlays,
      daily_all:        (todayCounts.jump || 0) + (todayCounts.shutdown || 0) + (todayCounts.ddududu || 0),
      daily_jump:       todayCounts.jump     || 0,
      daily_shutdown:   todayCounts.shutdown || 0,
      daily_ddududu:    todayCounts.ddududu  || 0,
      daily_date:       todayLabel,
      weekly_all:       (weekCounts.jump || 0) + (weekCounts.shutdown || 0) + (weekCounts.ddududu || 0),
      weekly_jump:      weekCounts.jump     || 0,
      weekly_shutdown:  weekCounts.shutdown || 0,
      weekly_ddududu:   weekCounts.ddududu  || 0,
      weekly_start:     weekStartLabel,
    },
  };
}

// ── Handler ───────────────────────────────────────────────────
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['authorization'] !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const data = await redis.get(LB_KEY);
  if (!data?.users) return res.status(200).json({ ok: true, skipped: 'no users' });

  const sb = supabase();

  // Archive the closing day/week's final standings before anyone gets
  // refreshed below, since refreshUser() overwrites daily_*/weekly_* with the
  // new period's (zeroed) counts the moment the Italy day/week boundary passes.
  const { from: dayFrom }  = getDayBounds();
  const { from: weekFrom } = getWeekBounds();
  const todayKey            = dayKey(dayFrom);
  const thisWeekKey         = dayKey(weekFrom);

  if (data.currentDayKey && data.currentDayKey !== todayKey) {
    try { await archivePeriod(sb, 'daily', data.currentDayKey, data.currentDayLabel || data.currentDayKey, data.users); }
    catch (e) { console.error('archivePeriod(daily) failed:', e); }
  }
  if (data.currentWeekKey && data.currentWeekKey !== thisWeekKey) {
    try { await archivePeriod(sb, 'weekly', data.currentWeekKey, data.currentWeekLabel || data.currentWeekKey, data.users); }
    catch (e) { console.error('archivePeriod(weekly) failed:', e); }
  }
  data.currentDayKey    = todayKey;
  data.currentDayLabel  = fullDateLabel(new Date(dayFrom * 1000));
  data.currentWeekKey   = thisWeekKey;
  data.currentWeekLabel = `Week of ${fullDateLabel(new Date(weekFrom * 1000))}`;

  // Drop any banned usernames that linger in data.users
  for (const u of data.banned || []) delete data.users[u];

  const users   = Object.values(data.users);
  const ok      = [];
  const failed  = [];

  // Process 3 users at a time to stay within Last.fm rate limits
  const batchSize = 3;
  for (let i = 0; i < users.length; i += batchSize) {
    await Promise.all(users.slice(i, i + batchSize).map(async entry => {
      try {
        data.users[entry.username.toLowerCase()] = await refreshUser(entry, sb);
        ok.push(entry.username);
      } catch (e) {
        failed.push({ username: entry.username, error: e.message });
      }
    }));
  }

  data.lastUpdated = new Date().toISOString();
  updateLeaderStreak(data);
  await redis.set(LB_KEY, data);

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, refreshed: ok, failed });
}
