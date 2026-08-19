// GET  /api/vma-votes            → { total, today, blinksTotal, blinksToday }
// POST /api/vma-votes  { votes, clientId }
//
// Community "votes logged" tally for the VMAs page. Self-reported, honor
// system: a device says how many votes it cast today and we add it to the
// running community total. One row per device per day (unique index), value
// capped 1..40, so a device can't stack submissions to inflate the count.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY.  Schema: supabase/vma_vote_tally.sql

import { createClient } from '@supabase/supabase-js';

function supabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, 00:00 UTC boundary
}

async function stats(sb) {
  const { data, error } = await sb.rpc('vma_vote_stats');
  if (error) throw error;
  return data || { total: 0, today: 0, blinksTotal: 0, blinksToday: 0 };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sb = supabase();
  if (!sb) return res.status(503).json({ error: 'Vote tally not configured' });

  try {
    if (req.method === 'GET') {
      return res.status(200).json(await stats(sb));
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const clientId = String(body.clientId || '').trim().slice(0, 64);
      let votes = parseInt(body.votes, 10);
      if (!clientId) return res.status(400).json({ error: 'clientId required' });
      if (!Number.isFinite(votes)) return res.status(400).json({ error: 'votes required' });
      votes = Math.max(1, Math.min(40, votes)); // clamp to a real daily ceiling

      // Overwrite this device's number for today (not additive) so re-submits
      // can only correct, never stack.
      const { error } = await sb
        .from('vma_vote_tally')
        .upsert({ client_id: clientId, day: todayUTC(), votes }, { onConflict: 'client_id,day' });
      if (error) return res.status(500).json({ error: error.message });

      return res.status(200).json(await stats(sb));
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'error' });
  }
}
