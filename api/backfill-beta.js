import { Redis } from '@upstash/redis';
import { createClient } from '@supabase/supabase-js';

const redis = Redis.fromEnv();
const LB_KEY = 'bu_leaderboard_v1';

export default async function handler(req, res) {
  // Only callable via POST to avoid accidental triggering
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const data = await redis.get(LB_KEY);
  const users = data?.users || {};
  const usernames = Object.values(users).map(u => u.username || '').filter(Boolean);

  if (!usernames.length) return res.status(200).json({ ok: true, registered: 0 });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Insert one by one, skipping duplicates (functional index on LOWER(lfm_username))
  let registered = 0;
  const skipped = [];
  const failed = [];

  for (const username of usernames) {
    const { error } = await sb.from('beta_testers').insert({ lfm_username: username.slice(0, 100) });
    if (!error) {
      registered++;
    } else if (error.code === '23505') {
      skipped.push(username); // already exists
    } else {
      failed.push({ username, error: error.message });
    }
  }

  return res.status(200).json({ ok: true, registered, skipped: skipped.length, failed });
}
