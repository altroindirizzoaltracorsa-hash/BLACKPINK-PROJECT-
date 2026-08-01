import { Redis } from '@upstash/redis';
import { createClient } from '@supabase/supabase-js';

const redis = Redis.fromEnv();
const BATTLE_KEY = 'bu_battle_v1';
const LB_KEY     = 'bu_leaderboard_v1';

const TEAMS = ['rose', 'jennie', 'lisa', 'jisoo', 'bp'];

// Maps team → the score key used in the existing leaderboard
const TEAM_SCORE_KEY = {
  rose:   'overall_rose',
  jennie: 'overall_jennie',
  lisa:   'overall_lisa',
  jisoo:  'overall_jisoo',
  bp:     'overall_bp_group',
};

function isAdmin(req) {
  return !!process.env.ADMIN_SECRET && req.query.key === process.env.ADMIN_SECRET;
}

function supabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// Cross-reference battle participants against the live leaderboard to compute
// how many scrobbles each has added since they joined (current − baseline).
function computeStandings(battle, lb) {
  const lbUsers      = lb?.users || {};
  const participants = battle?.participants || {};

  const teamTotals = Object.fromEntries(TEAMS.map(t => [t, 0]));
  const teamCounts = Object.fromEntries(TEAMS.map(t => [t, 0]));
  const individuals = [];

  for (const [pKey, p] of Object.entries(participants)) {
    // Find this participant's live leaderboard entry via key or linkedAccounts
    let lbEntry = lbUsers[pKey];
    if (!lbEntry) {
      lbEntry = Object.values(lbUsers).find(u =>
        Array.isArray(u.linkedAccounts) &&
        u.linkedAccounts.some(a => (a.username || '').toLowerCase() === pKey)
      );
    }

    const scores = lbEntry?.scores || {};
    let totalContribution = 0;
    const teamContributions = {};

    for (const team of (p.teams || [])) {
      const scoreKey = TEAM_SCORE_KEY[team];
      if (!scoreKey) continue;
      const baseline = p.baselines?.[team] ?? 0;
      const current  = scores[scoreKey] ?? 0;
      const delta    = Math.max(0, current - baseline);
      teamTotals[team]  += delta;
      teamCounts[team]  += 1;
      teamContributions[team] = delta;
      totalContribution += delta;
    }

    individuals.push({
      username:      p.displayName || pKey,
      avatar:        p.avatar || null,
      teams:         p.teams || [],
      score:         totalContribution,
      teamScores:    teamContributions,
      lastScrobbleAt: lbEntry?.lastScrobbleAt || null,
    });
  }

  individuals.sort((a, b) => b.score - a.score || a.username.localeCompare(b.username));

  return { teamTotals, teamCounts, individuals };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  // ── GET: public standings ─────────────────────────────────────────────────
  if (req.method === 'GET' && !action) {
    const [battle, lb] = await Promise.all([redis.get(BATTLE_KEY), redis.get(LB_KEY)]);
    const { teamTotals, teamCounts, individuals } = computeStandings(battle || {}, lb || {});
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      config:           battle?.config || { status: 'pending' },
      teamTotals,
      teamCounts,
      individuals:      individuals.slice(0, 50),
      participantCount: Object.keys(battle?.participants || {}).length,
    });
  }

  // ── POST ?action=battle-join — register + pick teams (auth required) ──────
  if (req.method === 'POST' && action === 'battle-join') {
    const { accessToken, teams: rawTeams } = req.body || {};
    if (!accessToken) return res.status(401).json({ error: 'Sign in required' });

    const sb = supabase();
    if (!sb) return res.status(503).json({ error: 'Server not configured' });

    const { data: { user }, error: authErr } = await sb.auth.getUser(accessToken);
    if (authErr || !user) return res.status(401).json({ error: 'Session expired — please sign in again' });

    const teams = (Array.isArray(rawTeams) ? rawTeams : []).filter(t => TEAMS.includes(t));
    if (!teams.length) return res.status(400).json({ error: 'Pick at least one team' });

    const { data: linked } = await sb.from('linked_accounts').select('source_username').eq('app_user_id', user.id);
    if (!linked?.length) return res.status(403).json({ error: 'Link your scrobbling account in settings before joining' });

    const linkedKeys = linked.map(a => a.source_username.toLowerCase());

    // Find leaderboard entry
    const lb = (await redis.get(LB_KEY)) || { users: {} };
    let lbKey   = null;
    let lbEntry = null;
    for (const k of linkedKeys) {
      if (lb.users[k]) { lbKey = k; lbEntry = lb.users[k]; break; }
    }
    if (!lbEntry) {
      for (const [k, u] of Object.entries(lb.users || {})) {
        if (Array.isArray(u.linkedAccounts) && u.linkedAccounts.some(a => linkedKeys.includes((a.username || '').toLowerCase()))) {
          lbKey = k; lbEntry = u; break;
        }
      }
    }
    if (!lbEntry) return res.status(400).json({ error: 'No leaderboard entry found — sync your scrobbles first then try again' });

    // Snapshot current scores as baselines at the moment of joining
    const scores = lbEntry.scores || {};
    const baselines = Object.fromEntries(TEAMS.map(t => [t, scores[TEAM_SCORE_KEY[t]] ?? 0]));

    const battle = (await redis.get(BATTLE_KEY)) || { config: { status: 'pending' }, participants: {} };
    battle.participants = battle.participants || {};

    const existing = battle.participants[lbKey];
    battle.participants[lbKey] = {
      displayName: lbEntry.displayName || lbKey,
      avatar:      lbEntry.avatar || null,
      teams,
      // Preserve original baselines so re-picking teams doesn't reset the clock
      baselines: existing?.baselines || baselines,
      joinedAt:  existing?.joinedAt  || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await redis.set(BATTLE_KEY, battle);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, teams });
  }

  // ── POST ?action=battle-config&key=ADMIN — create / update battle ─────────
  if (req.method === 'POST' && action === 'battle-config') {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { status, name, startAt, endAt, reset } = req.body || {};

    const battle = (await redis.get(BATTLE_KEY)) || { config: {}, participants: {} };
    battle.config = battle.config || {};

    if (status  !== undefined) battle.config.status  = status;
    if (name    !== undefined) battle.config.name    = name;
    if (startAt !== undefined) battle.config.startAt = startAt;
    if (endAt   !== undefined) battle.config.endAt   = endAt;

    // reset=true wipes all participant baselines and re-snapshots from current LB
    if (reset) {
      const lb = (await redis.get(LB_KEY)) || { users: {} };
      for (const [pKey, p] of Object.entries(battle.participants || {})) {
        const lbEntry = lb.users[pKey] || Object.values(lb.users).find(u =>
          Array.isArray(u.linkedAccounts) &&
          u.linkedAccounts.some(a => (a.username || '').toLowerCase() === pKey)
        );
        const scores = lbEntry?.scores || {};
        p.baselines = Object.fromEntries(TEAMS.map(t => [t, scores[TEAM_SCORE_KEY[t]] ?? 0]));
        p.joinedAt  = new Date().toISOString();
      }
    }

    await redis.set(BATTLE_KEY, battle);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, config: battle.config });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
