import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const LASTFM_KEY = '666b8ef2f3cc360fbc20df275fba2981';
const LASTFM_BASE = 'https://ws.audioscrobbler.com/2.0/';
const LB_KEY = 'bu_leaderboard_v1';

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

// ── Last.fm helpers ───────────────────────────────────────────
async function lfmFetch(params) {
  const url = LASTFM_BASE + '?' + new URLSearchParams({ ...params, api_key: LASTFM_KEY, format: 'json' });
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Last.fm HTTP ${r.status}`);
  return r.json();
}

async function fetchTrackPlays(username, artist, track) {
  const d = await lfmFetch({ method: 'track.getInfo', artist, track, username });
  return parseInt(d?.track?.userplaycount || '0', 10);
}

async function fetchArtistPlays(username, artist) {
  const d = await lfmFetch({ method: 'artist.getInfo', artist, username });
  return parseInt(d?.artist?.stats?.userplaycount || '0', 10);
}

async function fetchRecentScrobbles(username, from, to) {
  const results = [];
  let page = 1;
  while (true) {
    const d = await lfmFetch({ method: 'user.getRecentTracks', user: username, from, to, limit: 200, page });
    const tracks = d?.recenttracks?.tracks || d?.recenttracks?.track || [];
    const arr = Array.isArray(tracks) ? tracks : [tracks];
    results.push(...arr.filter(t => t['@attr']?.nowplaying !== 'true'));
    const total = parseInt(d?.recenttracks?.['@attr']?.totalPages || '1');
    if (page >= total || page >= 5) break;
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

// ── Refresh one user's scores ─────────────────────────────────
async function refreshUser(entry) {
  const { username } = entry;

  const { from: dayFrom, to: dayTo }   = getDayBounds();
  const { from: weekFrom, to: weekTo } = getWeekBounds();

  // Fetch track totals + both scrobble windows in parallel
  const [artistPlays, jumpPlays, shutdownPlays, ddududuPlays, todayScrobbles, weekScrobbles] =
    await Promise.all([
      fetchArtistPlays(username, 'BLACKPINK'),
      fetchTrackPlays(username, 'BLACKPINK', 'JUMP'),
      fetchTrackPlays(username, 'BLACKPINK', 'Shut Down'),
      fetchTrackPlays(username, 'BLACKPINK', 'DDU-DU DDU-DU'),
      fetchRecentScrobbles(username, dayFrom, dayTo),
      fetchRecentScrobbles(username, weekFrom, weekTo),
    ]);

  const totalPlays  = { jump: jumpPlays, shutdown: shutdownPlays, ddududu: ddududuPlays };
  const todayCounts = countByTrack(todayScrobbles);
  const weekCounts  = countByTrack(weekScrobbles);

  const bpScrobbles = weekScrobbles.filter(s =>
    (s.artist?.['#text'] || '').toLowerCase().includes('blackpink') && s.date?.uts
  );
  bpScrobbles.sort((a, b) => parseInt(b.date.uts) - parseInt(a.date.uts));
  const lastScrobbleAt = bpScrobbles.length
    ? new Date(parseInt(bpScrobbles[0].date.uts) * 1000).toISOString()
    : entry.lastScrobbleAt || null;

  const campaignTotal  = jumpPlays + shutdownPlays + ddududuPlays;
  const todayLabel     = ddmm(new Date(dayFrom * 1000));  // Italy-aware day, not UTC now
  const weekStartLabel = ddmm(new Date(weekFrom * 1000));

  return {
    username:      entry.username,
    avatar:        entry.avatar,
    updatedAt:     new Date().toISOString(),
    lastScrobbleAt,
    scores: {
      overall_all:      campaignTotal,
      overall_jump:     jumpPlays,
      overall_shutdown: shutdownPlays,
      overall_ddududu:  ddududuPlays,
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

  const users   = Object.values(data.users);
  const ok      = [];
  const failed  = [];

  // Process 3 users at a time to stay within Last.fm rate limits
  const batchSize = 3;
  for (let i = 0; i < users.length; i += batchSize) {
    await Promise.all(users.slice(i, i + batchSize).map(async entry => {
      try {
        data.users[entry.username.toLowerCase()] = await refreshUser(entry);
        ok.push(entry.username);
      } catch (e) {
        failed.push({ username: entry.username, error: e.message });
      }
    }));
  }

  data.lastUpdated = new Date().toISOString();
  await redis.set(LB_KEY, data);

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, refreshed: ok, failed });
}
