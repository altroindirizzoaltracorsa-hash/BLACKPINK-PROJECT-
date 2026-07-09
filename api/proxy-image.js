const MUSICAT_BASE     = 'https://api.musicat.fm/v1';
const BLACKPINK_ARTIST = 'b88d8d75-b62c-489b-80a5-4e455157edb1';
const MEMBER_ARTIST_IDS = {
  rose:   '1c2b9c70-2eea-4617-b1b0-d839582ef98f',
  lisa:   'b2962140-c2b8-4bdf-b108-86dedc4ba983',
  jennie: '88b78015-73ec-4427-8e83-f7b57c070706',
  jisoo:  '0a098f13-dab1-496f-b84b-de036e57791c',
};
const TRACK_IDS = {
  jump:     '502a16cf-fa8a-4fd3-a184-dbd49c10ce5f',
  shutdown: '3420a915-4654-4251-9c5b-43039ca74b66',
  ddududu:  '736f62c7-066c-4dd1-853c-c5cf5934b642',
};
const MC_HEADERS = { 'Authorization': 'Bearer empty', 'Content-Type': 'application/json' };

async function statsPost(body) {
  const r = await fetch(`${MUSICAT_BASE}/history/stats`, {
    method: 'POST', headers: MC_HEADERS,
    body: JSON.stringify({ ...body, metrics: ['total_streams'], withDeltas: false }),
  });
  if (!r.ok) return 0;
  const d = await r.json();
  return Number(d?.total_streams ?? d?.totalStreams ?? d?.count ?? 0);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Musicat stats proxy
  const mcUser = req.query.musicat_user;
  if (mcUser) {
    try {
      const ur = await fetch(`${MUSICAT_BASE}/users?user=${encodeURIComponent(mcUser)}`, { headers: MC_HEADERS });
      if (!ur.ok) return res.status(400).json({ error: `User "${mcUser}" not found (${ur.status})` });
      const ud = await ur.json();
      const publicId = ud.publicId ?? ud.id ?? ud.uuid;
      if (!publicId) return res.status(400).json({ error: 'publicId missing' });
      const displayName    = ud.displayName ?? ud.username ?? ud.name ?? mcUser;
      const totalScrobbles = ud.totalScrobbles ?? ud.listenCount ?? null;

      const now        = new Date();
      const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
      const allTime    = { start: null, end: null };
      const today      = { start: todayStart, end: null };

      const [bpGroupPlays, jisooPlays, lisaPlays, rosePlays, jenniePlays, jumpAll, shutdownAll, ddududuAll, jumpToday, shutdownToday, ddududuToday] = await Promise.all([
        statsPost({ range: allTime, publicUserId: publicId, publicArtistId: BLACKPINK_ARTIST }),
        statsPost({ range: allTime, publicUserId: publicId, publicArtistId: MEMBER_ARTIST_IDS.jisoo }),
        statsPost({ range: allTime, publicUserId: publicId, publicArtistId: MEMBER_ARTIST_IDS.lisa }),
        statsPost({ range: allTime, publicUserId: publicId, publicArtistId: MEMBER_ARTIST_IDS.rose }),
        statsPost({ range: allTime, publicUserId: publicId, publicArtistId: MEMBER_ARTIST_IDS.jennie }),
        statsPost({ range: allTime, publicUserId: publicId, publicTrackId: TRACK_IDS.jump }),
        statsPost({ range: allTime, publicUserId: publicId, publicTrackId: TRACK_IDS.shutdown }),
        statsPost({ range: allTime, publicUserId: publicId, publicTrackId: TRACK_IDS.ddududu }),
        statsPost({ range: today,   publicUserId: publicId, publicTrackId: TRACK_IDS.jump }),
        statsPost({ range: today,   publicUserId: publicId, publicTrackId: TRACK_IDS.shutdown }),
        statsPost({ range: today,   publicUserId: publicId, publicTrackId: TRACK_IDS.ddududu }),
      ]);
      const memberPlays = { jisoo: jisooPlays, lisa: lisaPlays, rose: rosePlays, jennie: jenniePlays };
      const artistPlays = bpGroupPlays + Object.values(memberPlays).reduce((s, v) => s + v, 0);

      return res.status(200).json({
        publicId, displayName,
        playcount: totalScrobbles ?? artistPlays,
        artistPlays,
        bpGroupPlays,
        memberPlays,
        tracks: { jump: jumpAll, shutdown: shutdownAll, ddududu: ddududuAll },
        today:  { jump: jumpToday, shutdown: shutdownToday, ddududu: ddududuToday },
      });
    } catch(err) {
      return res.status(400).json({ error: err.message });
    }
  }

  // Stats.fm stats proxy
  const sfmUser = req.query.statsfm_user;
  if (sfmUser) {
    try {
      const SFM_BASE = 'https://api.stats.fm/api/v1';
      const SFM_HEADERS = { 'content-type': 'application/json' };

      const ur = await fetch(`${SFM_BASE}/users/${encodeURIComponent(sfmUser)}`, { headers: SFM_HEADERS });
      if (!ur.ok) return res.status(400).json({ error: `Stats.fm user "${sfmUser}" not found (${ur.status})` });
      const ud = await ur.json();
      const user = ud.item ?? ud;
      const customId = user.customId ?? user.id ?? sfmUser;
      const displayName = user.displayName ?? customId;
      const privacy = user.privacySettings;

      // Fetch top tracks, top artists, and stream stats in parallel.
      const [tr, ar, sr] = await Promise.all([
        fetch(`${SFM_BASE}/users/${encodeURIComponent(customId)}/top/tracks?range=lifetime&limit=500`, { headers: SFM_HEADERS }),
        fetch(`${SFM_BASE}/users/${encodeURIComponent(customId)}/top/artists?range=lifetime&limit=50`, { headers: SFM_HEADERS }),
        fetch(`${SFM_BASE}/users/${encodeURIComponent(customId)}/streams/stats?range=lifetime`, { headers: SFM_HEADERS }),
      ]);
      if (!tr.ok) return res.status(400).json({ error: 'Could not fetch track stats from Stats.fm' });
      const [td, ad, sd] = await Promise.all([
        tr.json(),
        ar.ok ? ar.json() : Promise.resolve(null),
        sr.ok ? sr.json() : Promise.resolve(null),
      ]);
      const items = td.items ?? [];

      // BP plays split by group vs individual members.
      const MEMBER_MAP = { 'JISOO': 'jisoo', 'LISA': 'lisa', 'ROSÉ': 'rose', 'JENNIE': 'jennie' };
      let bpGroupPlays = 0;
      const memberPlays = { jisoo: 0, lisa: 0, rose: 0, jennie: 0 };
      for (const item of (ad?.items ?? [])) {
        const n = item.artist?.name;
        const streams = item.streams ?? 0;
        if (n === 'BLACKPINK') bpGroupPlays += streams;
        else if (MEMBER_MAP[n]) memberPlays[MEMBER_MAP[n]] += streams;
      }
      const artistPlays = bpGroupPlays + Object.values(memberPlays).reduce((s, v) => s + v, 0);

      // Match all versions of each song by name prefix + BLACKPINK artist.
      const TRACK_PREFIXES = { jump: 'jump', shutdown: 'shut down', ddududu: 'ddu-du ddu-du' };
      const tracks = {};
      for (const [key, prefix] of Object.entries(TRACK_PREFIXES)) {
        tracks[key] = items
          .filter(i => i.track?.name?.toLowerCase().startsWith(prefix) &&
                       i.track?.artists?.some(a => a.name === 'BLACKPINK'))
          .reduce((sum, i) => sum + (i.streams ?? 0), 0);
      }

      return res.status(200).json({
        customId, displayName,
        playcount: artistPlays || Object.values(tracks).reduce((s, v) => s + v, 0),
        artistPlays,
        bpGroupPlays,
        memberPlays,
        tracks,
        today: { jump: 0, shutdown: 0, ddududu: 0 },
      });
    } catch(err) {
      return res.status(400).json({ error: err.message });
    }
  }

  // Image proxy
  const { url } = req.query;
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Invalid URL' });
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return res.status(r.status).end();
    const buf = await r.arrayBuffer();
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.end(Buffer.from(buf));
  } catch(e) {
    res.status(500).json({ error: 'Proxy failed' });
  }
}
