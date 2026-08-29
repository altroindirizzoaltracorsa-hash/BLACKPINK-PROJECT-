/*
 * One-off: count extension_scrobbles for the Fallen Angel EP in its first 24h.
 *
 * Window (Rome = CEST, UTC+2 in August): 6:00 AM 28 Aug → 5:59 AM 29 Aug, i.e.
 *   [2026-08-28T04:00:00Z, 2026-08-29T04:00:00Z)
 * Also reports the cumulative at the 2 AM Rome Spotify reset (2026-08-29T00:00:00Z).
 *
 * Counts by TITLE, not track_id: for most of this window the per-song ingest fix
 * wasn't live yet, so Fallen Angel / Heaven plays were stored under the generic
 * `solo_jennie` bucket — but the `title` column is always the real song name.
 *
 * NOTE: this is the EXTENSION-recorded portion only (extension_scrobbles). Last.fm /
 * ListenBrainz / Stats.fm plays are read from those services as aggregates and are
 * NOT timestamped in our DB, so they can't be sliced to this window.
 */
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL || !KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }

const RELEASE = '2026-08-28T04:00:00Z'; // 6 AM Rome, 28 Aug — EP drop
const RESET   = '2026-08-29T00:00:00Z'; // 2 AM Rome, 29 Aug — Spotify daily reset
const H24     = '2026-08-29T04:00:00Z'; // 6 AM Rome, 29 Aug — 24h mark

async function count(filters) {
  const qs = ['select=id', ...filters].join('&');
  const r = await fetch(`${URL}/rest/v1/extension_scrobbles?${qs}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'count=exact', Range: '0-0' },
  });
  if (!r.ok && r.status !== 206) { console.error(`HTTP ${r.status}: ${await r.text()}`); process.exit(1); }
  const cr = r.headers.get('content-range') || '';
  return Number(cr.split('/')[1] || 0);
}

// title=ilike.*<t>* (contains, case-insensitive) so title variants still match.
const byTitle = (t, from, to) => count([
  `title=ilike.*${encodeURIComponent(t)}*`,
  `listened_at=gte.${from}`,
  `listened_at=lt.${to}`,
]);

async function windowReport(label, from, to) {
  const fa = await byTitle('fallen angel', from, to);
  const heaven = await byTitle('heaven', from, to);
  const ltal = await byTitle('less than a lover', from, to);
  const newDrop = fa + heaven;
  const epAll = fa + heaven + ltal;
  console.log(`\n=== ${label}  [${from} → ${to}) ===`);
  console.log(`  Fallen Angel        : ${fa.toLocaleString()}`);
  console.log(`  Heaven              : ${heaven.toLocaleString()}`);
  console.log(`  New drop (FA+Heaven): ${newDrop.toLocaleString()}`);
  console.log(`  Less Than a Lover   : ${ltal.toLocaleString()}`);
  console.log(`  EP total (all 3)    : ${epAll.toLocaleString()}`);
  return { fa, heaven, newDrop, ltal, epAll };
}

(async () => {
  console.log('Extension-recorded EP scrobbles — Fallen Angel EP first 24h');
  await windowReport('AT SPOTIFY RESET (2 AM Rome, 29 Aug)', RELEASE, RESET);
  await windowReport('AT 24H (6 AM Rome, 29 Aug) — full first-24h window', RELEASE, H24);
})();
