/**
 * Diagnoses the Stats.fm "today" per-track counts against the live edge function.
 * Runs in GitHub Actions (can reach both blinksunited.com and stats.fm).
 *
 * Pass the Stats.fm username via env SFM_USER (default: demibandwout).
 * Prints:
 *   1. our edge function's debug=2 (the recent-streams window it computed),
 *   2. the full payload (tracks + today),
 *   3. a raw sample of stats.fm's own streams/recent item shape, so we can see
 *      the real timestamp field + whether "today" filtering is working.
 */

const BASE = process.env.VERCEL_URL || 'https://blinksunited.com';
const USER = process.env.SFM_USER || 'demibandwout';
const SFM  = 'https://api.stats.fm/api/v1';
const SFM_H = {
  'Accept': 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Origin': 'https://stats.fm', 'Referer': 'https://stats.fm/', 'Accept-Language': 'en-US,en;q=0.9',
};

async function getJson(url, headers) {
  const r = await fetch(url, { headers });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { _raw: t.slice(0, 300) }; }
  return { status: r.status, j };
}

async function main() {
  console.log(`Stats.fm user: ${USER}\nBase: ${BASE}\n`);

  // 1. Our edge function window (debug=2 = recent-streams window it computed)
  const dbg = await getJson(`${BASE}/api/statsfm?user=${encodeURIComponent(USER)}&debug=2`);
  console.log('── our edge debug=2 (recent window) ──');
  console.log('afterMs:', dbg.j.afterMs, '=', dbg.j.afterMs ? new Date(dbg.j.afterMs).toISOString() : '?');
  console.log('localMidnight:', dbg.j.localMidnight);
  console.log('recentItems total kept:', dbg.j.total);
  console.log('sample[0] keys:', dbg.j.samples?.[0] ? Object.keys(dbg.j.samples[0]) : dbg.j.samples);
  console.log('sample[0]:', JSON.stringify(dbg.j.samples?.[0])?.slice(0, 600));
  console.log('');

  // 2. Full payload (what the site actually uses)
  const pay = await getJson(`${BASE}/api/statsfm?user=${encodeURIComponent(USER)}&_cb=${Date.now()}`);
  console.log('── our payload.today (per-track) ──');
  console.log('today:', JSON.stringify(pay.j.today));
  console.log('tracks(all-time):', JSON.stringify(pay.j.tracks));
  console.log('');

  // 3. Raw stats.fm streams/recent — resolve customId first
  const ur = await getJson(`${SFM}/users/${encodeURIComponent(USER)}`, SFM_H);
  const customId = ur.j.item?.customId ?? ur.j.item?.id ?? ur.j.customId ?? ur.j.id ?? USER;
  // Ground truth: per-track counts for [2am-Rome boundary, now] straight from
  // top/tracks after/before (Unix MS) — the source the fixed endpoint now uses.
  const nowMs = Date.now();
  const midnightMs = new Date(dbg.j.afterMs || (new Date().toISOString().slice(0,10) + 'T00:00:00.000Z')).getTime();
  const PREFIX = [
    ['jump','jump','BLACKPINK'],['shutdown','shut down','BLACKPINK'],['ddududu','ddu-du ddu-du','BLACKPINK'],
    ['go','go','BLACKPINK'],['ltal','less than a lover','JENNIE'],['fallenangel','fallen angel','JENNIE'],['heaven','heaven','JENNIE'],
  ];
  const gt = await getJson(`${SFM}/users/${encodeURIComponent(customId)}/top/tracks?after=${midnightMs}&before=${nowMs}&limit=100`, SFM_H);
  const truth = {};
  for (const [id, pfx, art] of PREFIX) {
    truth[id] = (gt.j.items||[]).filter(i => {
      const nm = (i.track?.name ?? '').toLowerCase();
      return nm.startsWith(pfx) && (i.track?.artists||[]).some(a => a.name === art);
    }).reduce((s,i)=>s+(i.streams||0),0);
  }
  console.log('── ground-truth today (top/tracks after/before) ──');
  console.log('  ', JSON.stringify(truth));
}

main().catch(e => { console.error(e); process.exit(1); });
