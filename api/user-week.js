import { createClient } from '@supabase/supabase-js';

function supabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// Returns one signed-in user's frozen per-day campaign counts for the current
// week (or any range from `from` onward), read from the durable user_daily_counts
// archive written by api/cron-scrobbles.js. The badges page uses this for PAST
// days so they match the leaderboard/finalized board on every device — the client
// can't re-derive Musicat/Stats.fm history for past days, but the cron froze it
// here while it was still "today".
//
// Any failure (including the table not existing before its one-time migration is
// applied) degrades to an empty map so the client silently falls back to its own
// per-day computation.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const appUserId = (req.query.appUserId || '').trim();
  const from      = (req.query.from || '').trim(); // week-start day key, YYYY-MM-DD
  if (!appUserId) return res.status(400).json({ error: 'appUserId required' });

  res.setHeader('Cache-Control', 'no-store');

  const sb = supabase();
  if (!sb) return res.status(200).json({ days: {} });

  const to = (req.query.to || '').trim(); // optional upper bound day key, YYYY-MM-DD

  // day_key is a zero-padded YYYY-MM-DD string, so lexical >=/<= is chronological.
  const runQuery = async (cols) => {
    let q = sb.from('user_daily_counts').select(cols).eq('app_user_id', appUserId);
    if (from) q = q.gte('day_key', from);
    if (to)   q = q.lte('day_key', to);
    return q.order('day_key', { ascending: true }).limit(100);
  };

  try {
    const BASE = 'day_key,jump,shutdown,ddududu,ltal,go';
    // Prefer the per-scrobbler breakdown; fall back to totals-only if the by_source
    // column isn't migrated yet, so the weekly-grid floor keeps working meanwhile.
    let data, hasBySource = true;
    let r = await runQuery(BASE + ',by_source');
    if (r.error) { hasBySource = false; r = await runQuery(BASE); }
    if (r.error) return res.status(200).json({ days: {} });
    data = r.data;

    const days = {};
    for (const row of (data || [])) {
      days[row.day_key] = {
        jump:     row.jump     || 0,
        shutdown: row.shutdown || 0,
        ddududu:  row.ddududu  || 0,
        ltal:     row.ltal     || 0,
        go:       row.go       || 0,
        by_source: hasBySource ? (row.by_source || null) : null,
      };
    }
    return res.status(200).json({ days });
  } catch (e) {
    return res.status(200).json({ days: {} });
  }
}
