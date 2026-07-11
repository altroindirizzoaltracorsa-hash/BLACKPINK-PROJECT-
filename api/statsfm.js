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

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': '*' } });
  }

  const { searchParams } = new URL(request.url);
  const username = searchParams.get('user');
  const debug = searchParams.get('debug') === '1';
  if (!username) return json({ error: 'user required' }, 400);

  try {
    const ur = await fetch(`${SFM}/users/${encodeURIComponent(username)}`, { headers: SFM_H });
    const urText = await ur.text();
    if (!ur.ok) return json({ error: `Stats.fm user lookup failed (HTTP ${ur.status})`, raw: urText.substring(0, 300) }, 502);

    let ud;
    try { ud = JSON.parse(urText); } catch { return json({ error: 'Stats.fm returned non-JSON', raw: urText.substring(0, 300) }, 502); }

    // Detect error body even when HTTP status is 200
    if (ud.status >= 400 || ud.error || ud.message === 'Forbidden') {
      return json({ error: `Stats.fm error: ${ud.message || ud.error || ud.status}`, raw: urText.substring(0, 300) }, 502);
    }

    const user = ud.item ?? ud;
    const customId = user.customId ?? user.id ?? username;
    const displayName = user.displayName ?? customId;

    if (debug) return json({ step: 'user_ok', customId, displayName, raw: ud });

    const [tr, ar, trToday] = await Promise.all([
      fetch(`${SFM}/users/${encodeURIComponent(customId)}/top/tracks?range=lifetime&limit=100`, { headers: SFM_H }),
      fetch(`${SFM}/users/${encodeURIComponent(customId)}/top/artists?range=lifetime&limit=50`, { headers: SFM_H }),
      // range=today uses Stats.fm's own "today" bucket — same source as their web app's Top Today view
      fetch(`${SFM}/users/${encodeURIComponent(customId)}/top/tracks?range=today&limit=100&orderBy=COUNT`, { headers: SFM_H }),
    ]);

    if (!tr.ok) return json({ error: `Stats.fm tracks blocked (HTTP ${tr.status}) — try visiting https://stats.fm/${username}` }, 502);
    if (!ar.ok) return json({ error: `Stats.fm artists blocked (HTTP ${ar.status})` }, 502);

    const td = await tr.json();
    const ad = await ar.json();
    const tdToday = trToday.ok ? await trToday.json() : null;
    const items = td.items ?? [];
    const adItems = ad.items ?? [];
    const itemsToday = tdToday?.items ?? [];

    const MEMBER_MAP = { 'JISOO': 'jisoo', 'LISA': 'lisa', 'ROSÉ': 'rose', 'JENNIE': 'jennie' };
    let bpGroupPlays = 0;
    const memberPlays = { jisoo: 0, lisa: 0, rose: 0, jennie: 0 };
    for (const item of adItems) {
      const n = item.artist?.name;
      // Try all known field names for stream count
      const streams = item.streams ?? item.count ?? item.playCount ?? Math.round((item.playedMs ?? item.durationMs ?? 0) / 180000);
      if (n === 'BLACKPINK') bpGroupPlays += streams;
      else if (MEMBER_MAP[n]) memberPlays[MEMBER_MAP[n]] += streams;
    }
    const artistPlays = bpGroupPlays + Object.values(memberPlays).reduce((s, v) => s + v, 0);

    const TRACK_PREFIXES = { jump: 'jump', shutdown: 'shut down', ddududu: 'ddu-du ddu-du' };

    function countTracks(list) {
      const result = {};
      for (const [key, prefix] of Object.entries(TRACK_PREFIXES)) {
        result[key] = list
          .filter(i => {
            const name = (i.track?.name ?? i.name ?? '').toLowerCase();
            const artists = i.track?.artists ?? i.artists ?? [];
            return name.startsWith(prefix) && artists.some(a => a.name === 'BLACKPINK');
          })
          .reduce((sum, i) => sum + (i.streams ?? i.count ?? Math.round((i.playedMs ?? 0) / 180000)), 0);
      }
      return result;
    }

    const tracks = countTracks(items);

    const tracksToday = countTracks(itemsToday);

    return json({
      customId, displayName,
      playcount: artistPlays || Object.values(tracks).reduce((s, v) => s + v, 0),
      artistPlays, bpGroupPlays, memberPlays, tracks,
      today: tracksToday,
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
