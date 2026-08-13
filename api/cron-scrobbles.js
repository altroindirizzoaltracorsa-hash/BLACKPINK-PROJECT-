import { Redis } from '@upstash/redis';
import { createClient } from '@supabase/supabase-js';

const redis = Redis.fromEnv();
const LASTFM_KEY = '666b8ef2f3cc360fbc20df275fba2981';
const LASTFM_BASE = 'https://ws.audioscrobbler.com/2.0/';
const LIBREFM_BASE = 'https://libre.fm/2.0/';
const LB_BASE     = 'https://api.listenbrainz.org/1/';
const LB_KEY = 'bu_leaderboard_v1';

function supabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

const TRACKS = [
  { id: 'jump',     artist: 'BLACKPINK', track: 'JUMP' },
  { id: 'shutdown', artist: 'BLACKPINK', track: 'Shut Down' },
  { id: 'ddududu',  artist: 'BLACKPINK', track: 'DDU-DU DDU-DU' },
  { id: 'ltal',     artist: 'Jennie',    track: 'Less Than a Lover' },
  { id: 'go',       artist: 'BLACKPINK', track: 'GO' },
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
  ltal:     makeDailyTiers(30, 'LESS THAN A LOVER'),
  go:       makeDailyTiers(30, 'GO'),
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

// Libre.fm implements the same AudioScrobbler 2.0 API as Last.fm (no api_key).
async function librefmFetch(params) {
  const url = LIBREFM_BASE + '?' + new URLSearchParams({ ...params, format: 'json' });
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Libre.fm HTTP ${r.status}`);
  const data = await r.json();
  if (data?.error) throw new Error(`Libre.fm error ${data.error}: ${data.message || ''}`);
  return data;
}

async function fetchTrackPlays(username, artist, track, fetchFn = lfmFetch) {
  const d = await fetchFn({ method: 'track.getInfo', artist, track, username });
  return parseInt(d?.track?.userplaycount || '0', 10);
}

async function fetchArtistPlays(username, artist, fetchFn = lfmFetch) {
  const d = await fetchFn({ method: 'artist.getInfo', artist, username });
  return parseInt(d?.artist?.stats?.userplaycount || '0', 10);
}

async function fetchRecentScrobbles(username, from, to, maxPages = 50, fetchFn = lfmFetch) {
  const results = [];
  let page = 1;
  while (true) {
    const d = await fetchFn({ method: 'user.getRecentTracks', user: username, from, to, limit: 200, page });
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
    for (const t of TRACKS) {
      if (name === t.track.toLowerCase() && artist.includes(t.artist.toLowerCase())) { counts[t.id]++; break; }
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

async function fetchLbTrackCounts(username) {
  const counts = { jump: 0, shutdown: 0, ddududu: 0, ltal: 0, go: 0 };
  const d = await lbFetch(`stats/user/${encodeURIComponent(username)}/recordings`, { count: 100, range: 'all_time' });
  for (const rec of d?.payload?.recordings || []) {
    const name   = (rec.track_name  || '').toLowerCase().trim();
    const artist = (rec.artist_name || '').toLowerCase();
    if (artist.includes('blackpink')) {
      if (name === 'jump')               counts.jump     += rec.listen_count || 0;
      else if (name === 'shut down')     counts.shutdown += rec.listen_count || 0;
      else if (name === 'ddu-du ddu-du') counts.ddududu  += rec.listen_count || 0;
      else if (name === 'go')            counts.go       += rec.listen_count || 0;
    } else if (artist.includes('jennie') && name === 'less than a lover') {
      counts.ltal += rec.listen_count || 0;
    }
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
  const counts = { jump: 0, shutdown: 0, ddududu: 0, ltal: 0, go: 0 };
  for (const l of listens) {
    const name   = (l.track_metadata?.track_name  || '').toLowerCase().trim();
    const artist = (l.track_metadata?.artist_name || '').toLowerCase();
    if (artist.includes('blackpink')) {
      if (name === 'jump')               counts.jump++;
      else if (name === 'shut down')     counts.shutdown++;
      else if (name === 'ddu-du ddu-du') counts.ddududu++;
      else if (name === 'go')            counts.go++;
    } else if (artist.includes('jennie') && name === 'less than a lover') {
      counts.ltal++;
    }
  }
  return counts;
}

// ── Extension (blinksunited-direct) plays ─────────────────────
// Self-reported plays the SessionBox extension posted to /api/ingest-scrobble,
// stored in extension_scrobbles keyed by app_user_id. These are ADDED on top of
// Last.fm/Libre/ListenBrainz counts. They don't double-count in the normal
// many->one setup because those plays are sent to blinksunited precisely because
// Last.fm filters them out — they are not also on the linked Last.fm account.
async function extensionCountsForUsers(sb, appUserIds, dayFrom, dayTo, weekFrom, weekTo) {
  const empty = () => ({ jump: 0, shutdown: 0, ddududu: 0, ltal: 0, go: 0 });
  const out = { total: empty(), week: empty(), today: empty() };
  if (!sb || !appUserIds || !appUserIds.length) return out;
  // Counted in the database (see supabase/extension_counts_fn.sql) so it scales
  // to unlimited rows — no per-query 1000-row cap, no fetching every play.
  const dayISO  = new Date(dayFrom  * 1000).toISOString();
  const weekISO = new Date(weekFrom * 1000).toISOString();
  for (const uid of appUserIds) {
    const { data, error } = await sb.rpc('extension_counts', { uid, day_from: dayISO, week_from: weekISO });
    if (error || !data) continue;
    for (const r of data) {
      const id = r.track_id;
      if (!(id in out.total)) continue;
      out.total[id] += Number(r.total) || 0;
      out.week[id]  += Number(r.week)  || 0;
      out.today[id] += Number(r.today) || 0;
    }
  }
  return out;
}

// ── Refresh one user's scores ─────────────────────────────────
// linkedMap: Map(source_username.toLowerCase() -> app_user_id), used to attach
// this profile's extension_scrobbles rows to the right account.
async function refreshUser(entry, sb, linkedMap) {
  const linkedAccounts = entry.linkedAccounts || [{ type: 'lastfm', username: entry.username }];
  const displayName    = entry.displayName    || entry.username;

  const { from: dayFrom, to: dayTo }   = getDayBounds();
  const { from: weekFrom, to: weekTo } = getWeekBounds();

  const totalPlays  = { jump: 0, shutdown: 0, ddududu: 0, ltal: 0, go: 0 };
  let artistPlays   = 0;
  const todayCounts = { jump: 0, shutdown: 0, ddududu: 0, ltal: 0, go: 0 };
  const weekCounts  = { jump: 0, shutdown: 0, ddududu: 0, ltal: 0, go: 0 };
  let lastScrobbleAt = entry.lastScrobbleAt || null;

  // Primary Last.fm account (first one, for stamps)
  const lfmAccount = linkedAccounts.find(a => a.type === 'lastfm');

  for (const acct of linkedAccounts) {
    if (acct.type === 'lastfm' || acct.type === 'librefm') {
      const u = acct.username;
      const fetchFn = acct.type === 'librefm' ? librefmFetch : lfmFetch;
      // Single fetch spanning the whole week through today -- Last.fm/Libre.fm
      // return scrobbles newest-first, so today's counts, the weekly counts,
      // and the most recent BLACKPINK scrobble can all be derived from one
      // paginated range instead of re-fetching/re-paginating once per day.
      const [ap, jumpPlays, shutdownPlays, ddududuPlays, ltalPlays, goPlays, weekSc] = await Promise.all([
        fetchArtistPlays(u, 'BLACKPINK', fetchFn),
        fetchTrackPlays(u, 'BLACKPINK', 'JUMP', fetchFn),
        fetchTrackPlays(u, 'BLACKPINK', 'Shut Down', fetchFn),
        fetchTrackPlays(u, 'BLACKPINK', 'DDU-DU DDU-DU', fetchFn),
        fetchTrackPlays(u, 'Jennie', 'Less Than a Lover', fetchFn),
        fetchTrackPlays(u, 'BLACKPINK', 'GO', fetchFn),
        fetchRecentScrobbles(u, weekFrom, dayTo, 50, fetchFn),
      ]);
      artistPlays        += ap;
      totalPlays.jump    += jumpPlays;
      totalPlays.shutdown += shutdownPlays;
      totalPlays.ddududu += ddududuPlays;
      totalPlays.ltal    += ltalPlays;
      totalPlays.go      += goPlays;

      const todaySc = weekSc.filter(s => {
        const ts = parseInt(s.date?.uts || '0', 10);
        return ts >= dayFrom && ts < dayTo;
      });
      const dc = countByTrack(todaySc);
      todayCounts.jump     += dc.jump     || 0;
      todayCounts.shutdown += dc.shutdown || 0;
      todayCounts.ddududu  += dc.ddududu  || 0;
      todayCounts.ltal     += dc.ltal     || 0;
      todayCounts.go       += dc.go       || 0;

      const wdc = countByTrack(weekSc);
      weekCounts.jump     += wdc.jump     || 0;
      weekCounts.shutdown += wdc.shutdown || 0;
      weekCounts.ddududu  += wdc.ddududu  || 0;
      weekCounts.ltal     += wdc.ltal     || 0;
      weekCounts.go       += wdc.go       || 0;

      // "blackpink" alone misses activity on Jennie's solo campaign track
      // (Less Than a Lover), which would otherwise wrongly flag an actively-
      // streaming fan as inactive just because their recent plays are all solo.
      const bpEntry = weekSc.find(s => {
        const a = (s.artist?.['#text'] || '').toLowerCase();
        return (a.includes('blackpink') || a.includes('jennie')) && s.date?.uts;
      });
      if (bpEntry) {
        const ts = new Date(parseInt(bpEntry.date.uts) * 1000).toISOString();
        if (!lastScrobbleAt || ts > lastScrobbleAt) lastScrobbleAt = ts;
      }
    } else if (acct.type === 'listenbrainz') {
      const u = acct.username;
      try {
        // Same single-fetch-for-the-week approach as the Last.fm branch above.
        const [lbTotals, lbAp, weekListens] = await Promise.all([
          fetchLbTrackCounts(u),
          fetchLbArtistPlays(u),
          fetchLbRecentListens(u, weekFrom, dayTo),
        ]);
        artistPlays         += lbAp;
        totalPlays.jump     += lbTotals.jump     || 0;
        totalPlays.shutdown += lbTotals.shutdown || 0;
        totalPlays.ddududu  += lbTotals.ddududu  || 0;
        totalPlays.ltal     += lbTotals.ltal     || 0;
        totalPlays.go       += lbTotals.go       || 0;

        const todayListens = weekListens.filter(l => l.listened_at >= dayFrom && l.listened_at < dayTo);
        const lbTodayCounts = countLbByTrack(todayListens);
        todayCounts.jump     += lbTodayCounts.jump     || 0;
        todayCounts.shutdown += lbTodayCounts.shutdown || 0;
        todayCounts.ddududu  += lbTodayCounts.ddududu  || 0;
        todayCounts.ltal     += lbTodayCounts.ltal     || 0;
        todayCounts.go       += lbTodayCounts.go       || 0;

        const lbWeekCounts = countLbByTrack(weekListens);
        weekCounts.jump     += lbWeekCounts.jump     || 0;
        weekCounts.shutdown += lbWeekCounts.shutdown || 0;
        weekCounts.ddududu  += lbWeekCounts.ddududu  || 0;
        weekCounts.ltal     += lbWeekCounts.ltal     || 0;
        weekCounts.go       += lbWeekCounts.go       || 0;

        // ListenBrainz never fed lastScrobbleAt before -- a fan scrobbling only
        // through LB (e.g. after moving off Last.fm) would drift towards a
        // false "inactive" label as the Last.fm-only timestamp above went stale.
        try {
          const latest = await lbFetch(`user/${encodeURIComponent(u)}/listens`, { count: 1 });
          const la = latest?.payload?.listens?.[0]?.listened_at;
          if (la) {
            const ts = new Date(la * 1000).toISOString();
            if (!lastScrobbleAt || ts > lastScrobbleAt) lastScrobbleAt = ts;
          }
        } catch {}
      } catch (e) {
        console.warn(`LB fetch failed for ${u}:`, e.message);
      }
    }
    // Musicat / Stats.fm are NOT scraped here — see the providerScores block below.
  }

  // Add this profile's extension (blinksunited-direct) plays on top.
  if (linkedMap) {
    const appUserIds = new Set();
    for (const acct of linkedAccounts) {
      const uid = linkedMap.get((acct.username || '').toLowerCase());
      if (uid) appUserIds.add(uid);
    }
    if (appUserIds.size) {
      try {
        const ext = await extensionCountsForUsers(sb, [...appUserIds], dayFrom, dayTo, weekFrom, weekTo);
        for (const t of TRACKS) {
          totalPlays[t.id]  += ext.total[t.id]  || 0;
          weekCounts[t.id]  += ext.week[t.id]   || 0;
          todayCounts[t.id] += ext.today[t.id]  || 0;
        }
      } catch (e) { console.warn('extension counts failed:', e.message); }
    }
  }

  // Musicat / Stats.fm: reuse the breakdown the badges page submitted, rather than
  // scraping those providers here. They throttle the hourly ~40-profile burst and
  // drop the heaviest accounts (e.g. a 250k-play Stats.fm), so scraping silently
  // lost their streams. The client fetched them successfully one-at-a-time, so we
  // trust that number. Overall totals always apply; the provider "today" only
  // applies while it's still the day the client captured it — these providers
  // expose no per-day history to re-derive it, so on a later day it's simply 0
  // until the fan opens their badges again (same freshness as their own profile).
  const provScores = entry.providerScores;
  if (provScores && provScores.overall) {
    const provTodayFresh = provScores.dailyDate === ddmm(new Date(dayFrom * 1000));
    for (const t of TRACKS) {
      totalPlays[t.id] += provScores.overall[t.id] || 0;
      if (provTodayFresh) {
        const n = provScores.today?.[t.id] || 0;
        todayCounts[t.id] += n;
        weekCounts[t.id]  += n;
      }
    }
  }

  // Keep Stamp Archive fresh (keyed by primary Last.fm username)
  if (lfmAccount) {
    try {
      await persistStamp(sb, lfmAccount.username, dayKey(dayFrom), buildTodayStamps(todayCounts));
    } catch {}
  }

  const campaignTotal  = totalPlays.jump + totalPlays.shutdown + totalPlays.ddududu + totalPlays.ltal + totalPlays.go;
  const todayLabel     = ddmm(new Date(dayFrom * 1000));
  const weekStartLabel = ddmm(new Date(weekFrom * 1000));

  return {
    username:      displayName,
    displayName,
    linkedAccounts,
    avatar:        entry.avatar,
    updatedAt:     new Date().toISOString(),
    lastScrobbleAt,
    // Carry the badges-page Musicat/Stats.fm breakdown forward across refreshes so
    // it survives until the fan's next visit refreshes it.
    providerScores: entry.providerScores || null,
    scores: {
      overall_all:      campaignTotal,
      overall_jump:     totalPlays.jump,
      overall_shutdown: totalPlays.shutdown,
      overall_ddududu:  totalPlays.ddududu,
      overall_ltal:     totalPlays.ltal,
      overall_go:       totalPlays.go,
      overall_artist:   artistPlays,
      daily_all:        (todayCounts.jump || 0) + (todayCounts.shutdown || 0) + (todayCounts.ddududu || 0) + (todayCounts.ltal || 0) + (todayCounts.go || 0),
      daily_jump:       todayCounts.jump     || 0,
      daily_shutdown:   todayCounts.shutdown || 0,
      daily_ddududu:    todayCounts.ddududu  || 0,
      daily_ltal:       todayCounts.ltal     || 0,
      daily_go:         todayCounts.go       || 0,
      daily_date:       todayLabel,
      weekly_all:       (weekCounts.jump || 0) + (weekCounts.shutdown || 0) + (weekCounts.ddududu || 0) + (weekCounts.ltal || 0) + (weekCounts.go || 0),
      weekly_jump:      weekCounts.jump     || 0,
      weekly_shutdown:  weekCounts.shutdown || 0,
      weekly_ddududu:   weekCounts.ddududu  || 0,
      weekly_ltal:      weekCounts.ltal     || 0,
      weekly_go:        weekCounts.go       || 0,
      weekly_start:     weekStartLabel,
    },
  };
}

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

// ── Handler ───────────────────────────────────────────────────
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['authorization'] !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const data = await redis.get(LB_KEY);
  if (!data?.users) return res.status(200).json({ ok: true, skipped: 'no users' });

  const sb = supabase();

  // Old-method entries (guest, just typed a username, never signed up with a
  // real account) are frozen out of the leaderboard entirely per the site's
  // migration notice: they neither count new scrobbles nor burn Last.fm API
  // calls until they create an account and re-link. The client submission
  // path already enforces this (it requires a Supabase session + verified
  // linked_accounts row), but this cron runs server-to-server with no client
  // involved, so it must check independently or it'll keep an old guest
  // entry updating forever. null (couldn't determine -- e.g. Supabase
  // unreachable this run) fails OPEN so a transient outage can't freeze
  // everyone.
  let verifiedUsernames = null;
  let linkedMap = null;
  let linkedByUser = null; // app_user_id -> [{ source, source_username }]
  if (sb) {
    try {
      const { data: linked, error } = await sb.from('linked_accounts').select('source, source_username, app_user_id');
      if (!error) {
        verifiedUsernames = new Set((linked || []).map(a => a.source_username.toLowerCase()));
        linkedMap = new Map((linked || []).map(a => [a.source_username.toLowerCase(), a.app_user_id]));
        linkedByUser = new Map();
        for (const a of (linked || [])) {
          if (!a.app_user_id) continue;
          if (!linkedByUser.has(a.app_user_id)) linkedByUser.set(a.app_user_id, []);
          linkedByUser.get(a.app_user_id).push({ source: a.source, source_username: a.source_username });
        }
      }
    } catch (e) { console.error('Failed to fetch verified linked accounts:', e); }
  }
  function isVerified(entry) {
    if (!verifiedUsernames) return true;
    const accounts = Array.isArray(entry.linkedAccounts) && entry.linkedAccounts.length
      ? entry.linkedAccounts
      : [{ username: entry.username }];
    return accounts.some(a => verifiedUsernames.has((a.username || '').toLowerCase()));
  }

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

  for (const u of data.banned || []) delete data.users[u];

  // Self-heal: re-create any verified account that has fallen off the board so a
  // user who vanishes (dropped by a past bug, or whose first submit never landed)
  // reappears on the next refresh instead of staying gone until they happen to
  // reopen their badges. Only seed users with a fetchable Last.fm/Libre.fm/
  // ListenBrainz account — a Musicat/Stats.fm-only fan can't be recomputed
  // server-side, so seeding them at 0 would misrepresent them; they still self-heal
  // the moment they open their badges (which submits their provider breakdown).
  const seeded = [];
  if (linkedByUser && linkedByUser.size) {
    const bannedSet = new Set((data.banned || []).map(b => (b || '').toLowerCase()));
    const onBoardUsernames = new Set();
    const boardOwners = new Set();
    for (const e of Object.values(data.users)) {
      if (e.appUserId) boardOwners.add(e.appUserId);
      for (const a of (e.linkedAccounts || [])) {
        if ((a.type || a.source || '').toLowerCase() === 'extension') continue;
        const u = (a.username || '').toLowerCase();
        if (u) onBoardUsernames.add(u);
      }
    }
    for (const [uid, accts] of linkedByUser) {
      if (boardOwners.has(uid)) continue; // already represented by an owned entry
      // Skip if any of this user's scrobbler usernames is already on the board.
      if (accts.some(a => onBoardUsernames.has((a.source_username || '').toLowerCase()))) continue;
      const linkedAccounts = accts
        .filter(a => a.source_username)
        .map(a => ({ type: a.source, username: a.source_username }));
      const seedable = linkedAccounts.some(a => ['lastfm', 'librefm', 'listenbrainz'].includes(a.type));
      if (!seedable) continue; // provider-only: needs a client visit to be correct
      const primary = linkedAccounts.find(a => a.type === 'lastfm' || a.type === 'librefm')
        || linkedAccounts.find(a => a.type === 'listenbrainz')
        || linkedAccounts[0];
      const key = primary.username.toLowerCase();
      if (bannedSet.has(key) || data.users[key]) continue;
      data.users[key] = {
        username: primary.username,
        displayName: primary.username, // upgraded to the real display name on next visit
        linkedAccounts,
        avatar: '',
        appUserId: uid,
        scores: {},
        updatedAt: new Date(0).toISOString(),
      };
      seeded.push(primary.username);
    }
  }

  const users     = Object.values(data.users);
  const ok        = [];
  const failed    = [];
  const unverified = [];

  const batchSize = 3;
  for (let i = 0; i < users.length; i += batchSize) {
    await Promise.all(users.slice(i, i + batchSize).map(async entry => {
      if (!isVerified(entry)) { unverified.push(entry.username); return; }
      try {
        const refreshed = await refreshUser(entry, sb, linkedMap);
        // Key by displayName (lowercased) so linked-account rows consolidate
        data.users[refreshed.displayName.toLowerCase()] = refreshed;
        // Remove the old key if the display name differs from the raw username
        if (entry.username.toLowerCase() !== refreshed.displayName.toLowerCase()) {
          delete data.users[entry.username.toLowerCase()];
        }
        ok.push(refreshed.displayName);
      } catch (e) {
        failed.push({ username: entry.username, error: e.message });
      }
    }));
  }

  // Defensive merge: collapse two entries only when they are provably the SAME
  // person filed under two keys — e.g. a stale key left from before this
  // identity's "stable key" resolved differently on an earlier submission.
  // This MUST match by SOURCE+username pair, skip the extension source, and
  // never merge two different signed-in owners — the exact rules the POST
  // handler's cleanup uses. Matching by bare username (and counting the
  // extension) was catastrophic: every fan who links the Blinks United
  // extension shares that one constant username, so the cron treated them all
  // as one person and deleted all but the most-recently-refreshed — silently
  // dropping real, distinct accounts (blinksunited, blackpinkshazam, colxrzone…)
  // from the board every hour. "Same username, different scrobbler" and "two
  // different logins" are NOT duplicates.
  const src  = a => (a.type || a.source || '').toLowerCase();
  const acctPairs = entry => new Set(
    (entry.linkedAccounts || [])
      .filter(a => src(a) !== 'extension')
      .map(a => `${src(a)}:${(a.username || '').toLowerCase()}`)
      .filter(p => !p.endsWith(':')));
  const entries = Object.entries(data.users);
  const removedKeys = new Set();
  for (let i = 0; i < entries.length; i++) {
    const [keyA, entryA] = entries[i];
    if (removedKeys.has(keyA)) continue;
    const pairsA = acctPairs(entryA);
    if (!pairsA.size) continue;
    for (let j = i + 1; j < entries.length; j++) {
      const [keyB, entryB] = entries[j];
      if (removedKeys.has(keyB)) continue;
      // Two different signed-in accounts are never the same person, even if a
      // scrobbler username coincides.
      if (entryA.appUserId && entryB.appUserId && entryA.appUserId !== entryB.appUserId) continue;
      const pairsB = acctPairs(entryB);
      if (![...pairsB].some(p => pairsA.has(p))) continue;
      const aTime = new Date(entryA.updatedAt || 0).getTime();
      const bTime = new Date(entryB.updatedAt || 0).getTime();
      if (bTime >= aTime) { delete data.users[keyA]; removedKeys.add(keyA); break; }
      delete data.users[keyB]; removedKeys.add(keyB);
    }
  }

  data.lastUpdated = new Date().toISOString();
  updateLeaderStreak(data);
  await redis.set(LB_KEY, data);

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, seeded, refreshed: ok, failed, unverified, merged: [...removedKeys] });
}
