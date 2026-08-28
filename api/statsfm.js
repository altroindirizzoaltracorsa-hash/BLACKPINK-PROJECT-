export const config = { runtime: 'edge' };

const SFM = 'https://api.stats.fm/api/v1';
const SFM_H = {
  'Accept': 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Origin': 'https://stats.fm',
  'Referer': 'https://stats.fm/',
  'Accept-Language': 'en-US,en;q=0.9',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

// ── Stale-while-error cache (Upstash REST) ────────────────────────────────────
// Stats.fm rate-limits bursts (HTTP 502) — the leaderboard cron refreshes dozens
// of Stats.fm profiles per run, so a raw pass drops ~half of them. We cache the
// last good payload for a week and:
//   • serve it directly while fresh (fast, no upstream hit),
//   • re-scrape when stale and refresh the cache on success,
//   • fall back to the last good payload when the upstream errors,
// so a throttled call never zeroes a fan's score — it just serves slightly stale
// numbers until the next successful scrape.
const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN;
const CACHE_FRESH_MS = 20 * 60 * 1000; // serve without re-scraping for 20 min
const CACHE_TTL_S    = 7 * 24 * 3600;  // keep last-good for a week as error fallback

async function cacheGet(key) {
  if (!R_URL) return null;
  try {
    const r = await fetch(`${R_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${R_TOK}` } });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch { return null; }
}
async function cacheSet(key, entry) {
  if (!R_URL) return;
  try {
    await fetch(`${R_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${R_TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', key, JSON.stringify(entry), 'EX', String(CACHE_TTL_S)]]),
    });
  } catch {}
}

// Returns the UTC ISO for the most recent occurrence of resetHour:00 in the given timezone.
// Used to align with the site's daily reset (2am Italy = midnight UTC in summer, 1am UTC in winter).
function dayBoundaryUTC(tz, resetHour) {
  try {
    const now = new Date();
    const localDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
    const utcNoon = new Date(`${localDateStr}T12:00:00Z`);
    const localNoonStr = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(utcNoon);
    const [nh, nm] = localNoonStr.split(':').map(Number);
    const offsetMinutes = (nh * 60 + nm) - 720;
    const hh = String(resetHour).padStart(2, '0');
    const todayResetUTC = new Date(new Date(`${localDateStr}T${hh}:00:00Z`).getTime() - offsetMinutes * 60 * 1000);
    if (now >= todayResetUTC) return todayResetUTC.toISOString();
    // Before today's reset — use yesterday's
    const prevNoon = new Date(utcNoon.getTime() - 86400000);
    const prevDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(prevNoon);
    return new Date(new Date(`${prevDateStr}T${hh}:00:00Z`).getTime() - offsetMinutes * 60 * 1000).toISOString();
  } catch {
    return new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
  }
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': '*' } });
  }

  const { searchParams } = new URL(request.url);
  const username = searchParams.get('user');
  const debug = searchParams.get('debug');
  if (!username) return json({ error: 'user required' }, 400);

  // v2: bumped to flush caches that hold the old inflated (streams/recent) "today".
  const cacheKey = `sfmcache:v2:${username.toLowerCase()}`;
  const cached = debug ? null : await cacheGet(cacheKey);
  if (cached?.payload && cached.at && (Date.now() - cached.at) < CACHE_FRESH_MS) {
    return json(cached.payload);
  }
  // On any upstream failure below, prefer serving the last good payload over an
  // error, so a throttled scrape never drops the fan's contribution to zero.
  const stale = (errObj, status) => (cached?.payload ? json(cached.payload) : json(errObj, status));

  try {
    const ur = await fetch(`${SFM}/users/${encodeURIComponent(username)}`, { headers: SFM_H });
    const urText = await ur.text();
    if (!ur.ok) return stale({ error: `Stats.fm user lookup failed (HTTP ${ur.status})`, raw: urText.substring(0, 300) }, 502);

    let ud;
    try { ud = JSON.parse(urText); } catch { return stale({ error: 'Stats.fm returned non-JSON', raw: urText.substring(0, 300) }, 502); }

    if (ud.status >= 400 || ud.error || ud.message === 'Forbidden') {
      return stale({ error: `Stats.fm error: ${ud.message || ud.error || ud.status}`, raw: urText.substring(0, 300) }, 502);
    }

    const user = ud.item ?? ud;
    const customId = user.customId ?? user.id ?? username;
    const displayName = user.displayName ?? customId;

    if (debug === '1') return json({ step: 'user_ok', customId, displayName, raw: ud });

    // Site day resets at 2am Italy time (same boundary as the main leaderboard)
    const localMidnight = dayBoundaryUTC('Europe/Rome', 2);
    const afterMs = new Date(localMidnight).getTime(); // Unix ms for the API

    // "today" = per-track streams since the site's 2am-Rome boundary. stats.fm's
    // streams/recent endpoint has NO working pagination — every page returns the
    // same newest 50 regardless of before/after/offset/page — so the old manual
    // pager re-counted that one page ~10x and massively inflated "today" (e.g. a
    // real 19 showed as 110). top/tracks with after/before (Unix MS) returns an
    // accurate per-track total for the exact window in a single call.
    const nowMs = Date.now();
    const [tr, ar, ttr] = await Promise.all([
      fetch(`${SFM}/users/${encodeURIComponent(customId)}/top/tracks?range=lifetime&limit=100`, { headers: SFM_H }),
      fetch(`${SFM}/users/${encodeURIComponent(customId)}/top/artists?range=lifetime&limit=50`, { headers: SFM_H }),
      fetch(`${SFM}/users/${encodeURIComponent(customId)}/top/tracks?after=${afterMs}&before=${nowMs}&limit=100`, { headers: SFM_H }),
    ]);

    if (!tr.ok) return stale({ error: `Stats.fm tracks blocked (HTTP ${tr.status}) — try visiting https://stats.fm/${username}` }, 502);
    if (!ar.ok) return stale({ error: `Stats.fm artists blocked (HTTP ${ar.status})` }, 502);

    const td = await tr.json();
    const ad = await ar.json();
    // If the today-window call is throttled, fall back to an empty window (0 today)
    // rather than failing — all-time still updates.
    const todayItems = ttr.ok ? ((await ttr.json()).items ?? []) : [];

    const items = td.items ?? [];
    const adItems = ad.items ?? [];

    if (debug === '2') return json({
      step: 'today_top_tracks', localMidnight, afterMs, nowMs,
      todayCount: todayItems.length,
      samples: todayItems.slice(0, 10).map(i => ({ name: i.track?.name, artists: (i.track?.artists || []).map(a => a.name), streams: i.streams })),
    });

    const MEMBER_MAP = { 'JISOO': 'jisoo', 'LISA': 'lisa', 'ROSÉ': 'rose', 'JENNIE': 'jennie' };
    let bpGroupPlays = 0;
    const memberPlays = { jisoo: 0, lisa: 0, rose: 0, jennie: 0 };
    for (const item of adItems) {
      const n = item.artist?.name;
      const streams = item.streams ?? item.count ?? item.playCount ?? Math.round((item.playedMs ?? item.durationMs ?? 0) / 180000);
      if (n === 'BLACKPINK') bpGroupPlays += streams;
      else if (MEMBER_MAP[n]) memberPlays[MEMBER_MAP[n]] += streams;
    }
    const artistPlays = bpGroupPlays + Object.values(memberPlays).reduce((s, v) => s + v, 0);

    const TRACKS = [
      { id: 'jump',        prefix: 'jump',              artist: 'BLACKPINK' },
      { id: 'shutdown',    prefix: 'shut down',         artist: 'BLACKPINK' },
      { id: 'ddududu',     prefix: 'ddu-du ddu-du',     artist: 'BLACKPINK' },
      { id: 'go',          prefix: 'go',                artist: 'BLACKPINK' },
      { id: 'ltal',        prefix: 'less than a lover', artist: 'JENNIE' },
      { id: 'fallenangel', prefix: 'fallen angel',      artist: 'JENNIE' },
      { id: 'heaven',      prefix: 'heaven',            artist: 'JENNIE' },
    ];

    function countTracks(list) {
      const result = {};
      for (const t of TRACKS) {
        result[t.id] = list
          .filter(i => {
            const name = (i.track?.name ?? i.name ?? '').toLowerCase();
            const artists = i.track?.artists ?? i.artists ?? [];
            return name.startsWith(t.prefix) && artists.some(a => a.name === t.artist);
          })
          .reduce((sum, i) => sum + (i.streams ?? i.count ?? Math.round((i.playedMs ?? 0) / 180000)), 0);
      }
      return result;
    }

    const tracks = countTracks(items);
    const tracksToday = countTracks(todayItems);

    const payload = {
      customId, displayName,
      playcount: artistPlays || Object.values(tracks).reduce((s, v) => s + v, 0),
      artistPlays, bpGroupPlays, memberPlays, tracks,
      today: tracksToday,
    };
    if (!debug) await cacheSet(cacheKey, { payload, at: Date.now() });
    return json(payload);
  } catch (e) {
    return stale({ error: e.message }, 500);
  }
}
