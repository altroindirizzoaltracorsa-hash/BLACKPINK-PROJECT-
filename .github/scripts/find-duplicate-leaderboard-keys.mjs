// One-off diagnostic: the public GET /api/leaderboard endpoint returns the
// full `users` object keyed by raw Redis key. Group entries by their
// (case-insensitive) displayName/username and print any group with more
// than one raw key -- these are duplicate entries for the same person that
// the merge/cleanup logic failed to consolidate, and can silently shadow
// each other depending on which one a background refresh writes last.
const res = await fetch('https://blinksunited.com/api/leaderboard');
if (!res.ok) throw new Error(`GET /api/leaderboard failed: ${res.status}`);
const data = await res.json();
const users = data.users || {};

const groups = new Map();
for (const [key, entry] of Object.entries(users)) {
  const name = (entry.displayName || entry.username || key).toLowerCase();
  if (!groups.has(name)) groups.set(name, []);
  groups.get(name).push({ key, entry });
}

let found = 0;
for (const [name, items] of groups) {
  if (items.length < 2) continue;
  found++;
  console.log(`\n=== Duplicate group: "${name}" (${items.length} raw keys) ===`);
  for (const { key, entry } of items) {
    console.log(`  rawKey: ${JSON.stringify(key)}`);
    console.log(`    username: ${entry.username}, displayName: ${entry.displayName}`);
    console.log(`    linkedAccounts: ${JSON.stringify(entry.linkedAccounts)}`);
    console.log(`    updatedAt: ${entry.updatedAt}, lastScrobbleAt: ${entry.lastScrobbleAt}`);
    console.log(`    scores.overall_all: ${entry.scores?.overall_all}, daily_ltal: ${entry.scores?.daily_ltal}, overall_ltal: ${entry.scores?.overall_ltal}, daily_date: ${entry.scores?.daily_date}`);
  }
}
console.log(`\nTotal duplicate groups found: ${found}`);
