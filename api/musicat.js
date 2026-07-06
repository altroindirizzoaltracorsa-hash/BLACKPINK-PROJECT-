const MUSICAT_BASE      = 'https://api.musicat.fm/v1';
const BLACKPINK_ARTIST  = 'b88d8d75-b62c-489b-80a5-4e455157edb1';
const TRACK_IDS = {
  jump:     '502a16cf-fa8a-4fd3-a184-dbd49c10ce5f',
  shutdown: '3420a915-4654-4251-9c5b-43039ca74b66',
  ddududu:  '736f62c7-066c-4dd1-853c-c5cf5934b642',
};

const AUTH_HEADERS = {
  'Authorization': 'Bearer empty',
  'Content-Type':  'application/json',
};

async function resolveUser(user) {
  const r = await fetch(`${MUSICAT_BASE}/users?user=${encodeURIComponent(user)}`, {
    headers: AUTH_HEADERS,
  });
  if (!r.ok) throw new Error(`User "${user}" not found (${r.status})`);
  const d = await r.json();
  const publicId = d.publicId ?? d.id ?? d.uuid;
  if (!publicId) throw new Error('publicId missing from user response');
  return {
    publicId,
    displayName:   d.displayName ?? d.username ?? d.name ?? user,
    totalScrobbles: d.totalScrobbles ?? d.listenCount ?? null,
  };
}

async function statsPost(body) {
  const r = await fetch(`${MUSICAT_BASE}/history/stats`, {
    method:  'POST',
    headers: AUTH_HEADERS,
    body:    JSON.stringify({ ...body, metrics: ['total_streams'], withDeltas: false }),
  });
  if (!r.ok) return 0;
  const d = await r.json();
  return Number(d?.total_streams ?? d?.totalStreams ?? d?.count ?? 0);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { user } = req.query;
  if (!user) return res.status(400).json({ error: 'user required' });

  try {
    const { publicId, displayName, totalScrobbles } = await resolveUser(user);

    // Today UTC range
    const now = new Date();
    const todayStart = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()
    )).toISOString();

    const allTime = { start: null,       end: null };
    const today   = { start: todayStart, end: null };

    const [
      artistPlays,
      jumpAll, shutdownAll, ddududuAll,
      jumpToday, shutdownToday, ddududuToday,
    ] = await Promise.all([
      statsPost({ range: allTime, publicUserId: publicId, publicArtistId: BLACKPINK_ARTIST }),
      statsPost({ range: allTime, publicUserId: publicId, publicTrackId: TRACK_IDS.jump }),
      statsPost({ range: allTime, publicUserId: publicId, publicTrackId: TRACK_IDS.shutdown }),
      statsPost({ range: allTime, publicUserId: publicId, publicTrackId: TRACK_IDS.ddududu }),
      statsPost({ range: today,   publicUserId: publicId, publicTrackId: TRACK_IDS.jump }),
      statsPost({ range: today,   publicUserId: publicId, publicTrackId: TRACK_IDS.shutdown }),
      statsPost({ range: today,   publicUserId: publicId, publicTrackId: TRACK_IDS.ddududu }),
    ]);

    return res.status(200).json({
      publicId,
      displayName,
      playcount: totalScrobbles ?? artistPlays,
      artistPlays,
      tracks: { jump: jumpAll, shutdown: shutdownAll, ddududu: ddududuAll },
      today:  { jump: jumpToday, shutdown: shutdownToday, ddududu: ddududuToday },
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}
