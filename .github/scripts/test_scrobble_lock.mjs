// Two scrobble refreshes must never run at once.
//
// Run: node .github/scripts/test_scrobble_lock.mjs
//
// WHY THIS EXISTS NOW. The refresh reads the WHOLE leaderboard, updates the
// slice of it this run has time for, and writes the whole thing back. Two
// overlapping runs therefore each start from the same board and the one that
// finishes second discards everything the first did — its users keep
// yesterday's numbers, and both runs report "refreshed" to a log nobody reads.
// There was no guard at all, which was survivable only while a single
// scheduler fired it. It is now reachable from two: an hourly Vercel cron and
// a GitHub backstop, after the hourly GitHub schedule turned out to be
// dropping most of its runs.
//
// WHAT IS PINNED, and why each one is a way this goes wrong quietly:
//   · a second caller is turned away, and does not touch the board
//   · the lock is taken with an EXPIRY — a run killed by a function timeout
//     never reaches its own cleanup, and a lock with no TTL would then wedge
//     every future refresh, which is a worse outage than the collision it is
//     preventing
//   · it is RELEASED on the way out, so the next scheduled run is not made to
//     sit out the TTL after a run that finished in four minutes
//   · a Redis that cannot answer does not stop the refresh. The lock is a
//     safety net, not the job.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
let fails = 0;
const check = (c, m, d) => {
  console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : ''));
  if (!c) fails++;
};

// Same build trick as test_scrobble_rate: the real module, with its two npm
// imports replaced, so this cannot pass against a rewritten copy of the logic.
const src = readFileSync(root + 'api/cron-scrobbles.js', 'utf8');
const IMPORTS = [
  "import { Redis } from '@upstash/redis';",
  "import { createClient } from '@supabase/supabase-js';",
];
for (const line of IMPORTS) {
  if (!src.includes(line)) {
    console.log(`  FAIL harness: expected import line not found: ${line}`);
    console.log('         api/cron-scrobbles.js changed its imports — fix this harness,');
    console.log('         do not let it pass by testing nothing.');
    process.exit(1);
  }
}

// An in-memory Redis that HONOURS nx and records the options it was given.
// A stub that ignored them would hand out the lock every time and this whole
// file would pass against no lock at all.
const prelude = `
const Redis = { fromEnv: () => ({
  get:  async k => (globalThis.__store.has(k) ? JSON.parse(JSON.stringify(globalThis.__store.get(k))) : null),
  set:  async (k, v, opts) => {
    globalThis.__sets.push({ k, opts: opts || null });
    // Only the LOCK write fails. Breaking every call instead would also break
    // the board read further down, and the test would be measuring that
    // instead of the thing it is named after.
    if (globalThis.__boom && opts && opts.nx) throw new Error('redis down');
    if (opts && opts.nx && globalThis.__store.has(k)) return null;
    globalThis.__store.set(k, JSON.parse(JSON.stringify(v)));
    return 'OK';
  },
  del:  async k => { globalThis.__dels.push(k); globalThis.__store.delete(k); return 1; },
}) };
const createClient = () => null;
`;
let built = src;
for (const line of IMPORTS) built = built.replace(line, '');
built = prelude + built + '\nexport { CRON_LOCK_KEY, CRON_LOCK_TTL_S };\n';
const dir = mkdtempSync(join(tmpdir(), 'bu-lock-'));
const modPath = join(dir, 'cron-scrobbles.mjs');
writeFileSync(modPath, built);

delete process.env.CRON_SECRET;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
globalThis.__store = new Map();
globalThis.__sets = [];
globalThis.__dels = [];
globalThis.__boom = false;

const mod = await import('file://' + modPath);
const LOCK = mod.CRON_LOCK_KEY;
check(typeof mod.default === 'function', 'harness built the real module', 'handler present');
check(!!LOCK, 'and the lock has a key', LOCK);

const run = async () => {
  let status = 0, body = null;
  const res = {
    setHeader() {},
    status(c) { status = c; return this; },
    json(b) { body = b; return this; },
  };
  await mod.default({ headers: {}, query: {} }, res);
  return { status, body };
};

console.log('--- a second caller is turned away');
{
  globalThis.__store.set(LOCK, 'held by someone else');
  globalThis.__dels.length = 0;
  const r = await run();
  check(r.status === 200 && /already running/i.test(String(r.body && r.body.skipped)),
        'it declines instead of running', JSON.stringify(r.body));
  // And leaves the lock alone. Deleting a lock it never took is how a guard
  // turns into the thing that lets two runs through.
  check(globalThis.__store.has(LOCK) && !globalThis.__dels.includes(LOCK),
        '  and does not release a lock it never took');
}

console.log('\n--- the lock it takes can expire');
{
  globalThis.__store.delete(LOCK);
  globalThis.__sets.length = 0;
  await run();
  const taken = globalThis.__sets.filter(s => s.k === LOCK);
  check(taken.length === 1, 'it is taken once', `${taken.length} set(s)`);
  const o = taken[0] && taken[0].opts;
  check(!!o && o.nx === true, '  with nx, or it is not a lock at all', JSON.stringify(o));
  check(!!o && Number(o.ex) > 0, '  and an expiry, so a killed run cannot wedge the refresh forever',
        o ? `ex=${o.ex}s` : 'none');
  // Long enough to outlast a run (~4 min observed), short enough to be well
  // inside the hourly cadence — a TTL over an hour would cost a whole slot.
  check(!!o && Number(o.ex) >= 300 && Number(o.ex) <= 1800,
        '  of a length that covers a run without costing an hour', `ex=${o && o.ex}s`);
}

console.log('\n--- and it is released on the way out');
{
  // A REAL RUN, not the "no users" early exit. Without a board seeded here
  // every run bailed at the top, which releases the lock by its own separate
  // line — so deleting the release at the END of the handler changed nothing
  // and this section stayed green. A zero budget makes the run reach the exit
  // without walking anybody or touching Last.fm.
  globalThis.__store.set('bu_leaderboard_v1', { users: { someone: { username: 'someone' } } });
  process.env.SCROBBLE_RUN_BUDGET_MS = '0';
  globalThis.__store.delete(LOCK);
  globalThis.__dels.length = 0;
  const r1 = await run();
  check(!!r1.body && r1.body.ok === true && !r1.body.skipped,
        'the run reaches its normal exit', JSON.stringify(r1.body && r1.body.skipped || 'full run'));
  check(!globalThis.__store.has(LOCK), 'and the lock is gone when it ends');
  // Proven by the next run getting in, not only by the key being absent.
  const r2 = await run();
  check(!/already running/i.test(String(r2.body && r2.body.skipped)),
        '  so the next run is not turned away', JSON.stringify(r2.body && r2.body.skipped || 'ran'));
  globalThis.__store.delete('bu_leaderboard_v1');
  delete process.env.SCROBBLE_RUN_BUDGET_MS;
}

console.log('\n--- a lock Redis cannot write does not stop the refresh');
{
  globalThis.__store.delete(LOCK);
  globalThis.__boom = true;
  let threw = null;
  let r = null;
  try { r = await run(); } catch (e) { threw = e.message; }
  globalThis.__boom = false;
  // It must get PAST the lock. What it does next (here: no board to read) is
  // the normal path; what it must not do is refuse to run or throw.
  check(!threw, 'it does not throw when the lock cannot be taken', threw || '');
  check(!!r && r.status === 200 && !/already running/i.test(String(r.body && r.body.skipped)),
        '  and does not mistake an unreachable Redis for a run in progress',
        r ? JSON.stringify(r.body) : 'no response');
}

console.log(fails ? `\nFAILURES: ${fails}` : '\nOne run at a time.');
process.exit(fails ? 1 : 0);
