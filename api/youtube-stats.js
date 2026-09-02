// GET /api/youtube-stats?ids=<id1>,<id2>,...
//
// Live view/like counts for YouTube videos via the Data API v3. Cached ~20s in
// Upstash so many polling visitors share ONE upstream call (protects the daily
// quota — a videos.list call is 1 unit, free quota is 10k/day).
//
// Returns: { ts, videos: [{ id, title, channel, thumb, views, likes, publishedAt }] }
// likes is null when the channel hides its like count.
//
// Env: YOUTUBE_API_KEY (required); UPSTASH_REDIS_REST_URL / _TOKEN (optional cache).

const YT_API = 'https://www.googleapis.com/youtube/v3/videos';
const CACHE_TTL = 20; // seconds

async function upstashGet(k) {
  if (!process.env.UPSTASH_REDIS_REST_URL) return null;
  try {
    const r = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(k)}`, {
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
    });
    const d = await r.json();
    if (d.result == null) return null;
    try { return JSON.parse(d.result); } catch { return null; }
  } catch { return null; }
}
async function upstashSetEx(k, v, ttl) {
  if (!process.env.UPSTASH_REDIS_REST_URL) return;
  try {
    await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', k, JSON.stringify(v), 'EX', String(ttl)]]),
    });
  } catch {}
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  if (!ids.every(id => /^[A-Za-z0-9_-]{11}$/.test(id))) return res.status(400).json({ error: 'invalid video id' });

  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(200).json({ error: 'not-configured', videos: [] });

  const cacheKey = 'bu_yt_stats_' + ids.join('_');
  const cached = await upstashGet(cacheKey);
  if (cached) { res.setHeader('X-Cache', 'HIT'); return res.status(200).json(cached); }

  try {
    const url = `${YT_API}?part=statistics,snippet&id=${encodeURIComponent(ids.join(','))}&key=${encodeURIComponent(key)}`;
    const r = await fetch(url);
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: j?.error?.message || `YouTube API ${r.status}` });

    const byId = {};
    for (const it of (j.items || [])) {
      byId[it.id] = {
        id: it.id,
        title: it.snippet?.title || '',
        channel: it.snippet?.channelTitle || '',
        thumb: it.snippet?.thumbnails?.medium?.url || it.snippet?.thumbnails?.default?.url || '',
        views: Number(it.statistics?.viewCount ?? 0),
        likes: it.statistics?.likeCount != null ? Number(it.statistics.likeCount) : null,
        publishedAt: it.snippet?.publishedAt || null,
      };
    }
    const videos = ids.map(id => byId[id]).filter(Boolean); // preserve request order
    const payload = { ts: Date.now(), videos };
    await upstashSetEx(cacheKey, payload, CACHE_TTL);
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
