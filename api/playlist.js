import { Redis } from '@upstash/redis';

// Guarded on purpose, the way kcharts-live.js does it. Redis.fromEnv() throws
// when the two UPSTASH_* vars are missing, and at module scope that throw takes
// the whole function down before the handler is ever entered — the request gets
// an opaque FUNCTION_INVOCATION_FAILED with no hint of the cause.
// SECOND DATABASE (optional). Upstash suspended the primary on 2026-10-24 for
// exceeding its free monthly bandwidth, and a free plan can neither export nor
// browse a suspended database — the data is intact but unreachable until the
// allowance resets on the 1st. Setting UPSTASH_REDIS_REST_URL_B/_TOKEN_B points
// the endpoints whose data rebuilds itself at a fresh free database so the site
// runs, while the leaderboard keeps using the primary and simply stays down:
// bu_leaderboard_v1 is mutated in place rather than recomputed from Supabase,
// so pointing IT at an empty store would start it at zero and never self-heal.
// Leaving it be means it returns intact with nothing to merge.
// Unset both vars and everything goes back to one database.
function redisClient() {
  const url = process.env.UPSTASH_REDIS_REST_URL_B;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN_B;
  if (url && token) return new Redis({ url, token });
  return Redis.fromEnv();
}

let redis = null, redisInitError = null;
try { redis = redisClient(); } catch (e) { redisInitError = e; }
const KEY = 'bp_current_playlist';
const QUEUE_KEY = 'bp_pending_playlist_queue';

function extractPlaylistId(url) {
  const match = String(url || '').match(/playlist[/:]([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

// Day boundary = 00:00 UTC — Spotify's own rollover, and the same boundary
// index.html buckets scores against. It was computed as 2 AM Rome, which equals
// 00:00 UTC only on summer time; when DST ended on 2026-10-25 it slid to 01:00
// UTC and stopped matching. No hour or city is named here — the reset is
// formatted in the reader's local clock where it is displayed.
function currentItalyDayStart() {
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}
function nextItaly2am() {
  return currentItalyDayStart() + 86400000;
}

// Manually-saved links queue up in QUEUE_KEY instead of going live immediately,
// so the admin can load several days of playlists in advance without any of
// them replacing the currently-live one early. At most one entry is promoted
// per Italy-day, in the order it was saved — checked lazily on every read.
async function promotePendingIfDue() {
  const live = await redis.get(KEY);
  if (live?.updatedAt >= currentItalyDayStart()) return; // already refreshed this Italy-day
  const next = await redis.lpop(QUEUE_KEY);
  if (!next) return;
  await redis.set(KEY, { id: next.id, url: next.url, updatedAt: Date.now(), source: 'queue', ...(next.day ? { day: next.day } : {}) });
}

// Annotates each queued entry with an estimated go-live time, one Italy-day
// apart. The next 2am-Italy boundary is always the earliest possible slot for
// queue[0] — whether today's live entry is already "fresh" only matters to
// promotePendingIfDue() at the moment that boundary actually arrives, not now.
async function buildQueueStatus() {
  const [live, queueRaw] = await Promise.all([redis.get(KEY), redis.lrange(QUEUE_KEY, 0, -1)]);
  const nextSlot = nextItaly2am();
  const queue = (queueRaw || []).map((item, i) => ({ ...item, etaPublishAt: nextSlot + i * 86400000 }));
  return { live, queue };
}

async function handlerInner(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    await promotePendingIfDue();
    const adminSecret = process.env.ADMIN_SECRET;

    // ?key= doubles as the auth check for the "Today's Playlist" admin panel —
    // wrong key gets a 401 instead of silently falling back to the public response.
    if (req.query.key) {
      if (!adminSecret || req.query.key !== adminSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const { live, queue } = await buildQueueStatus();
      return res.status(200).json({ ...(live || {}), queue });
    }

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
    const day = req.body?.day ? Number(req.body.day) : undefined;

    if (req.body?.publishNow) {
      const data = { id, url: req.body.url, updatedAt: Date.now(), source: 'manual', ...(day ? { day } : {}) };
      await redis.set(KEY, data);
      const { queue } = await buildQueueStatus();
      return res.status(200).json({ live: data, queue });
    }

    await redis.rpush(QUEUE_KEY, { id, url: req.body.url, savedAt: Date.now(), ...(day ? { day } : {}) });
    const { queue } = await buildQueueStatus();
    return res.status(200).json({ queued: true, queue });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// Every Redis call in here can also throw at REQUEST time, which is what
// actually happened on 2026-10-24: the env vars were present and module init
// succeeded, but Upstash had suspended the database for exceeding its monthly
// bandwidth, so it answered non-2xx and the SDK threw on every command. With no
// catch, that surfaced as FUNCTION_INVOCATION_FAILED — a 96-byte page naming
// nothing — and the outage read as a Spotify scraper-quota problem for hours.
// A store that is unreachable is a 503 with a reason, not a crash.
export default async function handler(req, res) {
  if (!redis) {
    return res.status(503).json({
      error: 'store_unavailable',
      detail: redisInitError?.message || 'UPSTASH_REDIS_REST_URL / _TOKEN are not set',
    });
  }
  try {
    return await handlerInner(req, res);
  } catch (e) {
    if (res.headersSent) throw e;
    return res.status(503).json({ error: 'store_unavailable', detail: e?.message || String(e) });
  }
}
