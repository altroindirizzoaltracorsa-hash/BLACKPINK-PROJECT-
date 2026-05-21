import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const LASTFM_KEY = '666b8ef2f3cc360fbc20df275fba2981';
const LASTFM_BASE = 'https://ws.audioscrobbler.com/2.0/';

const SONGS = [
  { id: 'jump',     artist: 'BLACKPINK', track: 'JUMP' },
  { id: 'shutdown', artist: 'BLACKPINK', track: 'Shut Down' },
  { id: 'ddududu',  artist: 'BLACKPINK', track: 'DDU-DU DDU-DU' },
];

const DAILY_TIERS = [
  { id: 'blink',   label: 'BLINK',   min: 20,  icon: '💗' },
  { id: 'stan',    label: 'STAN',    min: 40,  icon: '🖤' },
  { id: 'soldier', label: 'SOLDIER', min: 60,  icon: '🎀' },
  { id: 'queen',   label: 'QUEEN',   min: 80,  icon: '👑' },
  { id: 'legend',  label: 'LEGEND',  min: 100, icon: '⚡' },
];

// Get UTC day boundaries (midnight UTC = 2am Italy CEST)
function getDayBounds(offsetDays = 0) {
  const now = new Date();
  const start = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + offsetDays,
    0, 0, 0
  ));
  const end = new Date(start.getTime() + 86400000 - 1);
  return {
    from: Math.floor(start.getTime() / 1000),
    to:   Math.floor(end.getTime() / 1000),
    label: start.toISOString().slice(5, 10).replace('-', '/'),
  };
}

// Get Monday of current week
function getWeekBounds() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon...
  const diffToMonday = (day === 0 ? -6 : 1 - day);
  const monday = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + diffToMonday,
    0, 0, 0
  ));
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday.getTime() + i * 86400000);
    days.push({
      from:  Math.floor(d.getTime() / 1000),
      to:    Math.floor((d.getTime() + 86400000 - 1) / 1000),
      label: d.toISOString().slice(5, 10).replace('-', '/'),
    });
  }
  return days;
}

async function getScrobblesInRange(username, artist, track, from, to) {
  let count = 0;
  let page = 1;
  while (true) {
    const url = `${LASTFM_BASE}?method=user.getRecentTracks&user=${encodeURIComponent(username)}&api_key=${LASTFM_KEY}&from=${from}&to=${to}&limit=200&page=${page}&format=json`;
    const r = await fetch(url);
    const d = await r.json();
    const tracks = d?.recenttracks?.track || [];
    // Filter to just this song
    const matches = tracks.filter(t =>
      t.artist?.['#text']?.toLowerCase() === artist.toLowerCase() &&
      t.name?.toLowerCase() === track.toLowerCase()
    );
    count += matches.length;
    const total = parseInt(d?.recenttracks?.['@attr']?.totalPages || '1', 10);
    if (page >= total || page >= 3) break; // cap at 3 pages = 600 tracks
    page++;
  }
  return count;
}

function getBadge(streams) {
  let badge = null;
  for (const tier of DAILY_TIERS) {
    if (streams >= tier.min) badge = tier;
  }
  return badge;
}

export default async function handler(req, res) {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'Username required' });

  const u = username.toLowerCase().trim();

  try {
    // ── Verify user exists on Last.fm ──
    const infoRes = await fetch(`${LASTFM_BASE}?method=user.getInfo&user=${encodeURIComponent(u)}&api_key=${LASTFM_KEY}&format=json`);
    const infoData = await infoRes.json();
    if (!infoData?.user) return res.status(404).json({ error: 'Last.fm user not found' });

    const userInfo = {
      name: infoData.user.name,
      realname: infoData.user.realname || '',
      avatar: infoData.user.image?.find(i => i.size === 'medium')?.['#text'] || '',
      totalScrobbles: parseInt(infoData.user.playcount || '0', 10),
    };

    // ── Today's scrobbles ──
    const today = getDayBounds(0);
    const todayStreams = {};
    for (const song of SONGS) {
      todayStreams[song.id] = await getScrobblesInRange(u, song.artist, song.track, today.from, today.to);
    }

    // ── This week's scrobbles (day by day) ──
    const weekDays = getWeekBounds();
    const weekData = {}; // { 'MM/DD': { jump: N, shutdown: N, ddududu: N } }
    for (const day of weekDays) {
      // Skip future days
      const nowTs = Math.floor(Date.now() / 1000);
      if (day.from > nowTs) continue;
      weekData[day.label] = {};
      for (const song of SONGS) {
        weekData[day.label][song.id] = await getScrobblesInRange(u, song.artist, song.track, day.from, day.to);
      }
    }

    // ── Calculate today's badges ──
    const todayBadges = {};
    for (const song of SONGS) {
      todayBadges[song.id] = getBadge(todayStreams[song.id]);
    }
    const allTodayMin = SONGS.every(s => todayStreams[s.id] >= 20);
    const allTodayLegend = SONGS.every(s => todayStreams[s.id] >= 100);

    // ── Calculate weekly badges ──
    const weeklyComplete = {}; // { songId: bool } — did they hit 20 every day this week?
    const daysCompleted = {};
    for (const song of SONGS) {
      const completedDays = Object.entries(weekData).filter(([, counts]) => counts[song.id] >= 20);
      daysCompleted[song.id] = completedDays.length;
      weeklyComplete[song.id] = completedDays.length === 7;
    }
    const fullWeeklyComplete = SONGS.every(s => weeklyComplete[s.id]);

    // ── Load existing profile from Redis ──
    const profileKey = `bp_profile_${u}`;
    const existing = (await redis.get(profileKey)) || {
      username: u,
      userInfo,
      joinedDate: today.label,
      streak: 0,
      longestStreak: 0,
      lastActiveDate: null,
      badgeHistory: [], // [{ date, song, badge, type }]
      dailyLog: {},     // { 'DD/MM': { jump: N, shutdown: N, ddududu: N, complete: bool } }
    };

    // ── Update streak ──
    const yesterday = getDayBounds(-1);
    let { streak, longestStreak, lastActiveDate } = existing;

    if (allTodayMin) {
      if (lastActiveDate === yesterday.label) {
        streak = (streak || 0) + 1;
      } else if (lastActiveDate !== today.label) {
        streak = 1;
      }
      longestStreak = Math.max(longestStreak || 0, streak);
      lastActiveDate = today.label;
    }

    // ── Save today's log ──
    const dailyLog = existing.dailyLog || {};
    dailyLog[today.label] = {
      ...todayStreams,
      complete: allTodayMin,
      legendComplete: allTodayLegend,
    };

    // ── Save new badges earned today ──
    const badgeHistory = existing.badgeHistory || [];
    for (const song of SONGS) {
      const badge = todayBadges[song.id];
      if (badge) {
        const alreadyLogged = badgeHistory.find(b =>
          b.date === today.label && b.song === song.id && b.type === 'daily'
        );
        if (!alreadyLogged) {
          badgeHistory.push({ date: today.label, song: song.id, badge: badge.id, icon: badge.icon, label: badge.label, type: 'daily' });
        }
      }
    }
    if (allTodayMin) {
      const alreadyLogged = badgeHistory.find(b => b.date === today.label && b.type === 'daily-complete');
      if (!alreadyLogged) {
        badgeHistory.push({ date: today.label, type: 'daily-complete', icon: allTodayLegend ? '✨' : '🌟', label: allTodayLegend ? 'DAILY LEGEND COMPLETE' : 'DAILY COMPLETE' });
      }
    }
    if (fullWeeklyComplete) {
      const weekStart = weekDays[0].label;
      const alreadyLogged = badgeHistory.find(b => b.weekStart === weekStart && b.type === 'weekly-complete');
      if (!alreadyLogged) {
        badgeHistory.push({ date: today.label, weekStart, type: 'weekly-complete', icon: '🏆', label: 'WEEKLY COMPLETE' });
      }
    }

    // Keep last 365 entries
    if (badgeHistory.length > 365) badgeHistory.splice(0, badgeHistory.length - 365);

    // ── Save updated profile ──
    const updatedProfile = {
      ...existing,
      userInfo,
      streak,
      longestStreak,
      lastActiveDate,
      dailyLog,
      badgeHistory,
    };
    await redis.set(profileKey, updatedProfile);

    // ── Return full data ──
    res.status(200).json({
      userInfo,
      today: {
        label: today.label,
        streams: todayStreams,
        badges: todayBadges,
        complete: allTodayMin,
        legendComplete: allTodayLegend,
      },
      week: {
        days: weekData,
        daysCompleted,
        weeklyComplete,
        fullWeeklyComplete,
      },
      streak,
      longestStreak,
      badgeHistory: badgeHistory.slice(-50), // last 50 for display
      dailyLog,
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong' });
  }
}

