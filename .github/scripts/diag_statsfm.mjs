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
  console.log('── stats.fm today per-track via top/tracks (target: JUMP 19, HEAVEN 16, LTAL 19, FA 15, GO 11, SD 8, DDU 7) ──');
  const nowMs = Date.now();
  const midnightMs = new Date(new Date().toISOString().slice(0,10) + 'T00:00:00.000Z').getTime(); // 00:00 UTC today
  const wanted = ['jump','heaven','less than a lover','fallen angel','go','shut down','ddu-du ddu-du'];
  const showTop = (label, items) => {
    const rows = (items||[]).map(i => {
      const nm = (i.track?.name ?? i.name ?? '').toLowerCase();
      const streams = i.streams ?? i.count ?? i.playCount ?? '?';
      return { nm, streams, raw: (i.track?.name ?? i.name) };
    }).filter(r => wanted.some(w => r.nm.startsWith(w)));
    console.log(`  ${label}: ${rows.length ? rows.map(r => `${r.raw}=${r.streams}`).join(' · ') : '(no matching tracks)'}`);
  };

  const tries = {
    'range=today':                 `top/tracks?range=today&limit=50`,
    'range=days':                  `top/tracks?range=days&limit=50`,
    'after+before(ms)':            `top/tracks?after=${midnightMs}&before=${nowMs}&limit=50`,
    'after(ms)only':               `top/tracks?after=${midnightMs}&limit=50`,
    'after+before(sec)':           `top/tracks?after=${Math.floor(midnightMs/1000)}&before=${Math.floor(nowMs/1000)}&limit=50`,
  };
  for (const [label, path] of Object.entries(tries)) {
    const r = await getJson(`${SFM}/users/${encodeURIComponent(customId)}/${path}`, SFM_H);
    console.log(`  [${label}] status ${r.status} items ${(r.j.items||[]).length}`);
    showTop(label, r.j.items);
  }
  // Also test whether streams/recent honors a bigger limit (to widen the window)
  const big = await getJson(`${SFM}/users/${encodeURIComponent(customId)}/streams/recent?limit=1000`, SFM_H);
  const bi = big.j.items ?? [];
  console.log(`  streams/recent?limit=1000 -> items ${bi.length} | newest ${bi[0]?.endTime} | oldest ${bi[bi.length-1]?.endTime}`);
}

main().catch(e => { console.error(e); process.exit(1); });
