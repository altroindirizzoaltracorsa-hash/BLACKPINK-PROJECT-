import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const KEY = 'bp_current_playlist';

function extractPlaylistId(url) {
  const match = String(url || '').match(/playlist[/:]([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const data = await redis.get(KEY);
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json(data || {});
  }

  if (req.method === 'POST') {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret || req.query.key !== adminSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const id = extractPlaylistId(req.body?.url);
    if (!id) return res.status(400).json({ error: 'Could not find a playlist ID in that link' });
    const data = { id, url: req.body.url, updatedAt: Date.now() };
    await redis.set(KEY, data);
    return res.status(200).json(data);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
