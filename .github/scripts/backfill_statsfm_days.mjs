/**
 * Recover the Stats.fm plays that were never counted.
 *
 * Usage (via the "Backfill Stats.fm days" workflow):
 *   DAYS=14 WRITE=0 node .github/scripts/backfill_statsfm_days.mjs
 *
 * ── WHAT WAS LOST ──────────────────────────────────────────────────────────
 * api/cron-scrobbles.js left Stats.fm entirely to whatever the badges page
 * last submitted, so a fan's Stats.fm plays counted for nothing on every day
 * they did not personally open /badges. The stated reason — "these providers
 * expose no per-day history to re-derive it" — was never true for Stats.fm:
 * its top/tracks endpoint takes two arbitrary Unix-ms bounds, which is what
 * /api/statsfm?day= now exposes.
 *
 * ── WHY THIS RECOMPUTES INSTEAD OF ADDING ──────────────────────────────────
 * The first version of this script ADDED the missing Stats.fm figures to the
 * stored row, and decided whether to do so from `by_source` — the
 * per-scrobbler split the cron writes beside the numbers. That was wrong, and
 * the way it was wrong is worth keeping written down, because it looked
 * airtight:
 *
 *   api/leaderboard.js ALSO writes user_daily_counts (its live submit path),
 *   and it never writes by_source. So a day can hold Stats.fm plays with no
 *   marker at all: the fan opens /badges, the client POSTs totals that already
 *   include Stats.fm, and the cron then writes no marker because every
 *   campaign-five count was zero. That is not a hypothetical shape — it is a
 *   fan streaming one song that is not in the campaign five, which described
 *   most of the plays the first dry run proposed to add.
 *
 * So the decision is not made from a marker any more. Each day is RECOMPUTED
 * from every source this script can reach, and MAX-MERGED into the row — the
 * same thing the cron's own daily archive does, and for the same reason: a max
 * can only ever raise a day, so it is safe without knowing what the stored
 * number was made of.
 *
 *   row already holds Stats.fm  → recomputed matches stored → nothing changes
 *   row is missing Stats.fm     → recomputed is higher      → raised to the truth
 *   row holds something we cannot re-fetch (Musicat) → stored is higher → left alone
 *
 * A FAILED SOURCE CAN THEREFORE ONLY UNDER-RECOVER, NEVER CORRUPT. If Stats.fm
 * throttles, the recompute comes out at the Last.fm figure, which is at or
 * below what is stored, and nothing is written. That property is why this is
 * safe to re-run.
 *
 * The summation is the SAME one api/cron-scrobbles.js uses for today —
 * Last.fm + extension added together, not deduplicated — so this cannot be
 * more wrong than the live path already is.
 *
 * KNOWN, DELIBERATE UNDER-RECOVERY: Musicat cannot be re-fetched (~41 requests
 * per fan is the burst that genuinely gets throttled) and ListenBrainz is not
 * recomputed here. For a fan using either, stored will tend to exceed the
 * recompute and their day is left alone. Reported in the summary as "stored
 * already higher" so the size of that gap is visible rather than assumed.
 *
 * Dry by default. WRITE=1 applies.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const HOST         = process.env.SITE_HOST || 'www.blinksunited.com';
const DAYS         = Math.max(1, Math.min(90, Number(process.env.DAYS || 14)));
const WRITE        = process.env.WRITE === '1';
const ONLY         = (process.env.ONLY || '').trim().toLowerCase();
const PACE_MS      = Math.max(100, Number(process.env.PACE_MS || 700));

const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const root = new URL('../..', import.meta.url).pathname;

// ── The cron's own matcher, not a copy of it ────────────────────────────────
// Built in memory with its two npm imports stubbed, the same way
// test_scrobble_rate.mjs builds it. A second copy of trackMatches/TRACKS here
// would drift from the live one on the next release, and a backfill that
// matched titles differently from the cron would write numbers the cron then
// disagrees with for ever.
function buildCronModule() {
  const src = readFileSync(root + 'api/cron-scrobbles.js', 'utf8');
  const IMPORTS = [
    "import { Redis } from '@upstash/redis';",
    "import { createClient } from '@supabase/supabase-js';",
  ];
  for (const line of IMPORTS) {
    if (!src.includes(line)) {
      console.error(`api/cron-scrobbles.js no longer has: ${line}`);
      console.error('Fix this script rather than letting it run with a matcher it did not build.');
      process.exit(1);
    }
  }
  let built = "const Redis = { fromEnv: () => ({ get: async () => null, set: async () => 'OK', del: async () => 1 }) };\n"
            + "const createClient = () => { throw new Error('not used'); };\n";
  let body = src;
  for (const line of IMPORTS) body = body.replace(line, '');
  built += body + "\nexport { TRACKS, countByTrack, fetchRecentScrobbles, lfmFetch, librefmFetch };\n";
  const dir = mkdtempSync(join(tmpdir(), 'bu-backfill-'));
  const p = join(dir, 'cron.mjs');
  writeFileSync(p, built);
  return p;
}

function dayKeyOf(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, { headers, ...opts });
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path} → HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json();
}

async function statsfmDay(handle, day) {
  try {
    const r = await fetch(`https://${HOST}/api/statsfm?user=${encodeURIComponent(handle)}&day=${day}`,
      { headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || d.error || !d.today) return null;
    // The endpoint echoes the window it answered for. Without this an endpoint
    // that quietly fell back to today would have every backfilled date written
    // with the same figures, and it would look like it worked.
    if (d.day !== day) return null;
    return d.today;
  } catch { return null; }
}

// One call, exact single day: `today` counts from day_from, `week` counts from
// day_to, so the difference is the day itself. The RPC has no upper bound by
// design (plays are never in the future), which is what makes this work.
async function extensionDay(uid, dayFromISO, dayToISO) {
  try {
    const rows = await sb('/rpc/extension_counts', {
      method: 'POST',
      body: JSON.stringify({ uid, day_from: dayFromISO, week_from: dayToISO }),
    });
    const out = {};
    for (const r of rows || []) {
      const n = (Number(r.today) || 0) - (Number(r.week) || 0);
      if (n > 0) out[r.track_id] = (out[r.track_id] || 0) + n;
    }
    return out;
  } catch { return {}; }
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set'); process.exit(1); }
  const cron = await import('file://' + buildCronModule());
  const TRACKS = cron.TRACKS;

  const all = await sb('/linked_accounts?select=app_user_id,source,source_username');
  const byUser = new Map();
  for (const a of all) {
    if (!a.app_user_id || !a.source_username) continue;
    if (!byUser.has(a.app_user_id)) byUser.set(a.app_user_id, []);
    byUser.get(a.app_user_id).push(a);
  }
  const fans = [...byUser.entries()]
    .map(([uid, accts]) => ({ uid, accts, sfm: accts.filter(a => a.source === 'statsfm') }))
    .filter(f => f.sfm.length && (!ONLY || f.sfm.some(a => a.source_username.toLowerCase() === ONLY)));

  console.log(`${WRITE ? 'WRITE' : 'DRY RUN'} · ${fans.length} fan(s) with Stats.fm · last ${DAYS} day(s) · host ${HOST}`);
  if (!fans.length) { console.log('Nothing to do.'); return; }

  const today = new Date();
  const days = [];
  // Yesterday backwards. TODAY IS DELIBERATELY EXCLUDED: it is still moving and
  // the hourly cron owns it, so writing it here would race that.
  for (let i = 1; i <= DAYS; i++) {
    const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i);
    days.push({ key: dayKeyOf(new Date(start)), startSec: start / 1000, endSec: start / 1000 + 86400,
                startISO: new Date(start).toISOString(), endISO: new Date(start + 86400000).toISOString() });
  }

  let considered = 0, raised = 0, alreadyHigher = 0, noSfm = 0, nothingAnywhere = 0;
  const recovered = {};
  const perFan = {};

  for (const fan of fans) {
    const rows = await sb(`/user_daily_counts?select=*&app_user_id=eq.${fan.uid}`
      + `&day_key=in.(${days.map(d => d.key).join(',')})`);
    const byDay = new Map(rows.map(r => [r.day_key, r]));
    const lfmAccts = fan.accts.filter(a => a.source === 'lastfm' || a.source === 'librefm');

    for (const day of days) {
      considered++;
      await sleep(PACE_MS);

      // ── recompute the day, source by source ──
      const re = Object.fromEntries(TRACKS.map(t => [t.id, 0]));
      let sfmAnswered = false;
      for (const h of fan.sfm) {
        const got = await statsfmDay(h.source_username, day.key);
        if (!got) continue;
        sfmAnswered = true;
        for (const t of TRACKS) re[t.id] += got[t.id] || 0;
      }
      // No Stats.fm answer means the recompute cannot exceed what is stored in
      // any meaningful way, so there is nothing this script could add. Skip
      // before spending Last.fm calls on it.
      if (!sfmAnswered) { noSfm++; continue; }

      for (const a of lfmAccts) {
        try {
          const sc = await cron.fetchRecentScrobbles(a.source_username, day.startSec, day.endSec, 50,
            a.source === 'librefm' ? cron.librefmFetch : cron.lfmFetch);
          const c = cron.countByTrack(sc);
          for (const t of TRACKS) re[t.id] += c[t.id] || 0;
        } catch { /* a failed source can only under-recover; see the header */ }
      }
      const ext = await extensionDay(fan.uid, day.startISO, day.endISO);
      for (const t of TRACKS) re[t.id] += ext[t.id] || 0;

      const row = byDay.get(day.key);
      const cols = row ? new Set(Object.keys(row)) : new Set(['jump','shutdown','ddududu','ltal','go']);
      const patch = {};
      let gained = 0;
      for (const t of TRACKS) {
        if (!cols.has(t.id)) continue;             // column not migrated yet — skip, never fail
        const was = Number(row?.[t.id]) || 0;
        const now = re[t.id] || 0;
        if (now > was) { patch[t.id] = now; gained += now - was; recovered[t.id] = (recovered[t.id] || 0) + (now - was); }
      }
      if (!Object.keys(patch).length) {
        if (Object.values(re).some(v => v > 0)) alreadyHigher++; else nothingAnywhere++;
        continue;
      }
      patch.updated_at = new Date().toISOString();
      const label = Object.entries(patch).filter(([k]) => k !== 'updated_at')
        .map(([k, v]) => `${k} ${row?.[k] || 0}→${v}`).join(', ');
      console.log(`  ${day.key}  ${(fan.sfm[0].source_username || '').padEnd(20)} ${row ? 'raise ' : 'insert'} ${label}`);
      perFan[fan.sfm[0].source_username] = (perFan[fan.sfm[0].source_username] || 0) + gained;
      raised++;

      if (WRITE) {
        await sb('/user_daily_counts', {
          method: 'POST',
          headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify([{ app_user_id: fan.uid, day_key: day.key, ...patch }]),
        });
      }
    }
  }

  console.log('\n── summary ──');
  console.log(`fan-days considered     : ${considered}`);
  console.log(`Stats.fm no answer      : ${noSfm}  (skipped; nothing could be added)`);
  console.log(`stored already >= truth : ${alreadyHigher}  (already counted, or holds Musicat/ListenBrainz we cannot re-fetch)`);
  console.log(`no plays from anyone    : ${nothingAnywhere}`);
  console.log(`${WRITE ? 'days raised' : 'days that WOULD be raised'} : ${raised}`);
  const total = Object.values(recovered).reduce((s, v) => s + v, 0);
  console.log(`plays recovered         : ${total}`);
  for (const [id, n] of Object.entries(recovered).sort((a, b) => b[1] - a[1])) console.log(`    ${id.padEnd(14)} ${n}`);
  for (const [h, n] of Object.entries(perFan).sort((a, b) => b[1] - a[1])) console.log(`    ${h.padEnd(20)} ${n}`);
  if (!WRITE) console.log('\nDry run — nothing was written. Re-run with write: 1 to apply.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
