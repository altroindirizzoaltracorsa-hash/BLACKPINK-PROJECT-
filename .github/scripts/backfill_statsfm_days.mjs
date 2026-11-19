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
 * /api/statsfm?day= now exposes. That is why those days are recoverable at
 * all, and this script is the recovery.
 *
 * ── THE ONE THING THAT MUST NOT HAPPEN ─────────────────────────────────────
 * Adding a day that was already counted. The stored row is a COMBINED total
 * across every scrobbler a fan has (Last.fm + extension + Musicat + Stats.fm),
 * so "did this row already include Stats.fm?" cannot be answered by looking at
 * the numbers. It is answered by `by_source`, the per-scrobbler split the cron
 * writes alongside them: a `Stats.fm · <handle>` entry for that day means the
 * day already has it.
 *
 * That marker is safe to trust in BOTH directions, which is worth spelling out
 * because the whole script rests on it:
 *   · marker present  → the old provider path counted Stats.fm that day. Skip.
 *   · marker absent   → the old path contributed ZERO for that fan that day.
 *     Either the submit was from an earlier day (provTodayFresh false, nothing
 *     added), or it was from that day and every campaign count in it was 0 —
 *     in which case 0 is what was added. Adding the real figures is correct in
 *     both cases.
 * The one genuinely ambiguous case is a row whose `by_source` is NULL: the
 * breakdown was not being recorded at all, so the marker could not have been
 * written even if the day was counted. Those days are REPORTED AND SKIPPED
 * rather than guessed at — a double count is worse than a missing one, because
 * an inflated leaderboard is noticed and cannot be explained afterwards.
 *
 * Writing the marker as part of the update is what makes this idempotent: run
 * it twice and the second run skips everything the first one wrote.
 *
 * Dry by default. WRITE=1 applies.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const HOST         = process.env.SITE_HOST || 'www.blinksunited.com';
const DAYS         = Math.max(1, Math.min(90, Number(process.env.DAYS || 14)));
const WRITE        = process.env.WRITE === '1';
const ONLY         = (process.env.ONLY || '').trim().toLowerCase();
// Stats.fm throttles bursts, which is the real reason this provider was left
// alone in the first place. One request at a time, spaced. A past day is cached
// by /api/statsfm for a week once fetched, so a re-run costs almost nothing.
const PACE_MS      = Math.max(200, Number(process.env.PACE_MS || 900));

const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function dayKeyOf(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, { headers, ...opts });
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path} → HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json();
}

async function statsfmDay(handle, day) {
  const url = `https://${HOST}/api/statsfm?user=${encodeURIComponent(handle)}&day=${day}`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || d.error || !d.today) return null;
    // The endpoint echoes the window it answered for. Without this check, an
    // endpoint that quietly fell back to today would have every backfilled date
    // written with the same figures — and it would look like it worked.
    if (d.day !== day) return null;
    return d;
  } catch { return null; }
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set'); process.exit(1); }

  const accounts = await sb('/linked_accounts?select=app_user_id,source_username&source=eq.statsfm');
  const fans = accounts.filter(a => a.app_user_id && a.source_username
    && (!ONLY || a.source_username.toLowerCase() === ONLY));
  console.log(`${WRITE ? 'WRITE' : 'DRY RUN'} · ${fans.length} Stats.fm account(s) · last ${DAYS} day(s) · host ${HOST}`);
  if (!fans.length) { console.log('Nothing to do.'); return; }

  const today = new Date();
  const days = [];
  // Yesterday backwards. TODAY IS DELIBERATELY EXCLUDED: it is still moving and
  // the hourly cron already owns it, so writing it here would race that.
  for (let i = 1; i <= DAYS; i++) days.push(dayKeyOf(new Date(Date.UTC(
    today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i))));

  let fetched = 0, skippedCounted = 0, skippedAmbiguous = 0, skippedEmpty = 0, noAnswer = 0;
  let updated = 0, inserted = 0;
  const recovered = {};   // track id → plays recovered
  const perFan = {};

  for (const fan of fans) {
    const handle = fan.source_username;
    const marker = `Stats.fm · ${handle}`;
    const rows = await sb(`/user_daily_counts?select=*&app_user_id=eq.${fan.app_user_id}`
      + `&day_key=in.(${days.join(',')})`);
    const byDay = new Map(rows.map(r => [r.day_key, r]));

    for (const day of days) {
      const row = byDay.get(day);
      if (row && row.by_source == null) { skippedAmbiguous++; continue; }
      if (row && row.by_source && Object.keys(row.by_source).includes(marker)) { skippedCounted++; continue; }

      await sleep(PACE_MS);
      const sfm = await statsfmDay(handle, day);
      fetched++;
      if (!sfm) { noAnswer++; continue; }

      const plays = sfm.today || {};
      const nonZero = Object.entries(plays).filter(([, v]) => (v || 0) > 0);
      if (!nonZero.length) { skippedEmpty++; continue; }

      // Only columns that actually exist on the row are written. Reading them
      // off `select=*` means a release whose column has not been migrated yet
      // is skipped instead of failing the whole update — the same guarded shape
      // the cron's own per-day upsert uses.
      const cols = row ? new Set(Object.keys(row)) : new Set(['jump','shutdown','ddududu','ltal','go']);
      const patch = {};
      for (const [id, n] of nonZero) {
        if (!cols.has(id)) continue;
        patch[id] = (row?.[id] || 0) + n;
        recovered[id] = (recovered[id] || 0) + n;
        perFan[handle] = (perFan[handle] || 0) + n;
      }
      if (!Object.keys(patch).length) { skippedEmpty++; continue; }

      // The marker goes in with the numbers, in the same write. That is what
      // makes a second run a no-op instead of a second addition.
      const five = ['jump','shutdown','ddududu','ltal','go'];
      patch.by_source = { ...(row?.by_source || {}),
        [marker]: Object.fromEntries(five.map(k => [k, plays[k] || 0])) };
      patch.updated_at = new Date().toISOString();

      const label = Object.entries(patch)
        .filter(([k]) => k !== 'by_source' && k !== 'updated_at')
        .map(([k, v]) => `${k} ${row?.[k] || 0}→${v}`).join(', ');
      console.log(`  ${day}  ${handle.padEnd(20)} ${row ? 'update' : 'insert'}  ${label}`);

      if (WRITE) {
        await sb('/user_daily_counts', {
          method: 'POST',
          headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify([{ app_user_id: fan.app_user_id, day_key: day, ...patch }]),
        });
      }
      row ? updated++ : inserted++;
    }
  }

  console.log('\n── summary ──');
  console.log(`fetched from Stats.fm : ${fetched}`);
  console.log(`already counted       : ${skippedCounted}  (by_source already names this handle)`);
  console.log(`no plays that day     : ${skippedEmpty}`);
  console.log(`Stats.fm no answer    : ${noAnswer}  (left alone, not zeroed)`);
  console.log(`AMBIGUOUS, skipped    : ${skippedAmbiguous}  (row exists but by_source is NULL — cannot tell if it was already counted)`);
  console.log(`${WRITE ? 'rows written' : 'rows that WOULD be written'} : ${updated} updated, ${inserted} inserted`);
  const total = Object.values(recovered).reduce((s, v) => s + v, 0);
  console.log(`plays recovered       : ${total}`);
  for (const [id, n] of Object.entries(recovered).sort((a, b) => b[1] - a[1])) console.log(`    ${id.padEnd(14)} ${n}`);
  for (const [h, n] of Object.entries(perFan).sort((a, b) => b[1] - a[1])) console.log(`    ${h.padEnd(20)} ${n}`);
  if (!WRITE) console.log('\nDry run — nothing was written. Re-run with write: 1 to apply.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
