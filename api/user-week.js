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

  try {
    let q = sb
      .from('user_daily_counts')
      .select('day_key,jump,shutdown,ddududu,ltal,go')
      .eq('app_user_id', appUserId);
    // day_key is a zero-padded YYYY-MM-DD string, so lexical >= is chronological >=.
    if (from) q = q.gte('day_key', from);
    const { data, error } = await q.order('day_key', { ascending: true }).limit(31);
    if (error) return res.status(200).json({ days: {} });

    const days = {};
    for (const r of (data || [])) {
      days[r.day_key] = {
        jump:     r.jump     || 0,
        shutdown: r.shutdown || 0,
        ddududu:  r.ddududu  || 0,
        ltal:     r.ltal     || 0,
        go:       r.go       || 0,
      };
    }
    return res.status(200).json({ days });
  } catch (e) {
    return res.status(200).json({ days: {} });
  }
}
