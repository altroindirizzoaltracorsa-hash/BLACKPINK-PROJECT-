/**
 * One-time cleanup: removes leaderboard entries whose stored username is
 * garbage (a pasted URL, an email address, or an account that no longer
 * resolves on Last.fm) — identified from the "failed" list of a
 * refresh-scrobbles.yml run (each of these got a Last.fm HTTP 404 on every
 * refresh attempt).
 *
 * Looks up each target's *actual* Redis key via GET /api/leaderboard first
 * instead of assuming key === username.toLowerCase() -- after a successful
 * refresh, entries get re-keyed by displayName (see cron-scrobbles.js
 * refreshUser), so the dictionary key can differ from the raw username.
 * Deleting by the wrong key would silently no-op.
 *
 * Safe to remove once it's been run.
 */

const VERCEL_URL = process.env.VERCEL_URL || 'https://blinksunited.com';
const ADMIN_KEY  = process.env.ADMIN_KEY;

const TARGETS = [
  'tincns',
  'sadiya',
  'Vay',
  'rubyyyy',
  'kat',
  'Jana',
  'AlessiaZ',
  'https://www.last.fm/es/user/AngelesSO/library/tracks?date_preset=LAST_365_DAYS',
  'jaduenasducv',
];

async function main() {
  if (!ADMIN_KEY) { console.error('ADMIN_KEY secret not set'); process.exit(1); }

  const r = await fetch(`${VERCEL_URL}/api/leaderboard`);
  if (!r.ok) { console.error(`GET /api/leaderboard failed: HTTP ${r.status}`); process.exit(1); }
  const data = await r.json();
  const users = data.users || {};

  const targetSet = new Set(TARGETS.map(t => t.toLowerCase()));
  const matches = Object.entries(users).filter(([key, u]) =>
    targetSet.has(key.toLowerCase()) || targetSet.has((u.username || '').toLowerCase())
  );

  console.log(`Found ${matches.length} matching entries out of ${TARGETS.length} targets.`);
  for (const t of TARGETS) {
    const found = matches.some(([key, u]) =>
      key.toLowerCase() === t.toLowerCase() || (u.username || '').toLowerCase() === t.toLowerCase()
    );
    if (!found) console.log(`  NOT FOUND (already gone?): ${t}`);
  }

  let failures = 0;
  for (const [key, u] of matches) {
    const delRes = await fetch(`${VERCEL_URL}/api/leaderboard?action=delete-entry&key=${encodeURIComponent(ADMIN_KEY)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: key }),
    });
    const body = await delRes.json().catch(() => ({}));
    console.log(`Deleted key="${key}" (username="${u.username}") -> HTTP ${delRes.status} ${JSON.stringify(body)}`);
    if (!delRes.ok) failures++;
  }

  if (failures > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
