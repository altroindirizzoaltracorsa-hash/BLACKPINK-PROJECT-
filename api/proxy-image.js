const MUSICAT_BASE     = 'https://api.musicat.fm/v1';
const BLACKPINK_ARTIST = 'b88d8d75-b62c-489b-80a5-4e455157edb1';
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

      const [artistPlays, jumpAll, shutdownAll, ddududuAll, jumpToday, shutdownToday, ddududuToday] = await Promise.all([
        statsPost({ range: allTime, publicUserId: publicId, publicArtistId: BLACKPINK_ARTIST }),
        statsPost({ range: allTime, publicUserId: publicId, publicTrackId: TRACK_IDS.jump }),
        statsPost({ range: allTime, publicUserId: publicId, publicTrackId: TRACK_IDS.shutdown }),
        statsPost({ range: allTime, publicUserId: publicId, publicTrackId: TRACK_IDS.ddududu }),
        statsPost({ range: today,   publicUserId: publicId, publicTrackId: TRACK_IDS.jump }),
        statsPost({ range: today,   publicUserId: publicId, publicTrackId: TRACK_IDS.shutdown }),
        statsPost({ range: today,   publicUserId: publicId, publicTrackId: TRACK_IDS.ddududu }),
      ]);

      return res.status(200).json({
        publicId, displayName,
        playcount: totalScrobbles ?? artistPlays,
        artistPlays,
        tracks: { jump: jumpAll, shutdown: shutdownAll, ddududu: ddududuAll },
        today:  { jump: jumpToday, shutdown: shutdownToday, ddududu: ddududuToday },
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
