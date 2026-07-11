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
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Content-Type' } });
  }

  const { searchParams } = new URL(request.url);
  const username = searchParams.get('user');
  if (!username) return json({ error: 'user required' }, 400);

  try {
    const ur = await fetch(`${SFM}/users/${encodeURIComponent(username)}`, { headers: SFM_H });
    if (!ur.ok) return json({ error: `Stats.fm user not found (${ur.status})` }, 400);
    const ud = await ur.json();
    const user = ud.item ?? ud;
    const customId = user.customId ?? user.id ?? username;
    const displayName = user.displayName ?? customId;

    const [tr, ar] = await Promise.all([
      fetch(`${SFM}/users/${encodeURIComponent(customId)}/top/tracks?range=lifetime&limit=100`, { headers: SFM_H }),
      fetch(`${SFM}/users/${encodeURIComponent(customId)}/top/artists?range=lifetime&limit=50`, { headers: SFM_H }),
    ]);

    const items = tr.ok ? ((await tr.json()).items ?? []) : [];
    const adData = ar.ok ? await ar.json() : null;

    const MEMBER_MAP = { 'JISOO': 'jisoo', 'LISA': 'lisa', 'ROSÉ': 'rose', 'JENNIE': 'jennie' };
    let bpGroupPlays = 0;
    const memberPlays = { jisoo: 0, lisa: 0, rose: 0, jennie: 0 };
    for (const item of (adData?.items ?? [])) {
      const n = item.artist?.name;
      const streams = item.streams ?? Math.round((item.playedMs ?? 0) / 180000);
      if (n === 'BLACKPINK') bpGroupPlays += streams;
      else if (MEMBER_MAP[n]) memberPlays[MEMBER_MAP[n]] += streams;
    }
    const artistPlays = bpGroupPlays + Object.values(memberPlays).reduce((s, v) => s + v, 0);

    const TRACK_PREFIXES = { jump: 'jump', shutdown: 'shut down', ddududu: 'ddu-du ddu-du' };
    const tracks = {};
    for (const [key, prefix] of Object.entries(TRACK_PREFIXES)) {
      tracks[key] = items
        .filter(i => {
          const name = (i.track?.name ?? i.name ?? '').toLowerCase();
          const artists = i.track?.artists ?? i.artists ?? [];
          return name.startsWith(prefix) && artists.some(a => a.name === 'BLACKPINK');
        })
        .reduce((sum, i) => sum + (i.streams ?? i.count ?? Math.round((i.playedMs ?? 0) / 180000)), 0);
    }

    return json({
      customId, displayName,
      playcount: artistPlays || Object.values(tracks).reduce((s, v) => s + v, 0),
      artistPlays, bpGroupPlays, memberPlays, tracks,
      today: { jump: 0, shutdown: 0, ddududu: 0 },
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
