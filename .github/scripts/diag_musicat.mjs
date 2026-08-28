/**
 * Diagnoses why Musicat scrobbles aren't being recorded.
 * Runs in GitHub Actions (can reach blinksunited.com + api.musicat.fm).
 * Pass MC_USER (default: souralis, a Musicat user seen on the board).
 *
 * Prints:
 *   1. our proxy /api/proxy-image?musicat_user=... (what the site gets),
 *   2. raw Musicat /users lookup (status + shape),
 *   3. raw Musicat /history/stats POST for BLACKPINK all-time (status + body),
 * so we can see whether Musicat's API changed (auth/endpoint/shape/ids).
 */

const BASE = process.env.VERCEL_URL || 'https://blinksunited.com';
const USER = process.env.MC_USER || 'souralis';
const MC = 'https://api.musicat.fm/v1';
const MC_HEADERS = { 'Authorization': 'Bearer empty', 'Content-Type': 'application/json' };
const BLACKPINK_ARTIST = 'b88d8d75-b62c-489b-80a5-4e455157edb1';
const JUMP_TRACK = '502a16cf-fa8a-4fd3-a184-dbd49c10ce5f';

async function get(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = null; }
  return { status: r.status, ok: r.ok, text: t, j };
}

async function main() {
  console.log(`Musicat user: ${USER}\nBase: ${BASE}\n`);

  // 1. Our proxy
  const proxy = await get(`${BASE}/api/proxy-image?musicat_user=${encodeURIComponent(USER)}&_cb=${Date.now()}`);
  console.log('── our proxy /api/proxy-image?musicat_user ──');
  console.log('status', proxy.status, '| body:', proxy.text.slice(0, 500));
  console.log('');

  // 2. Raw Musicat user lookup
  const ur = await get(`${MC}/users?user=${encodeURIComponent(USER)}`, { headers: MC_HEADERS });
  console.log('── raw musicat /users?user ──');
  console.log('status', ur.status, '| keys:', ur.j ? Object.keys(ur.j) : '(non-json)', '| body:', ur.text.slice(0, 400));
  const publicId = ur.j?.publicId ?? ur.j?.id ?? ur.j?.uuid;
  console.log('resolved publicId:', publicId);
  console.log('');

  // 3. Test whether BOUNDED date-range queries work at all (JUMP track = 247 all-time).
  if (publicId) {
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const nowIso = now.toISOString();
    const wideStart = '2026-01-01T00:00:00.000Z';
    const wideEnd   = '2027-01-01T00:00:00.000Z';
    const post = async (label, range, extra = { publicTrackId: JUMP_TRACK }) => {
      const r = await get(`${MC}/history/stats`, {
        method: 'POST', headers: MC_HEADERS,
        body: JSON.stringify({ range, publicUserId: publicId, ...extra, metrics: ['total_streams'], withDeltas: false }),
      });
      console.log(`  [${label.padEnd(28)}] status ${r.status} | body: ${r.text.slice(0, 200)}`);
    };
    console.log('── JUMP track (247 all-time) across range variants ──');
    await post('all-time null/null', { start: null, end: null });
    await post('wide start/end ISO', { start: wideStart, end: wideEnd });
    await post('today start / null', { start: todayStart, end: null });
    await post('today start / now ISO', { start: todayStart, end: nowIso });
    await post('from/to keys ISO', { from: wideStart, to: wideEnd });
    // Some APIs want epoch ms/sec instead of ISO
    await post('wide start/end ms', { start: Date.parse(wideStart), end: Date.parse(wideEnd) });
    await post('startDate/endDate ISO', { startDate: wideStart, endDate: wideEnd });
    // THE FIX candidate: both bounds as zero-time exact dates.
    const tomorrowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
    const sevenAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 7)).toISOString();
    console.log('── FIX candidate: start + exact-date end ──');
    await post('today->tomorrow (JUMP)',  { start: todayStart, end: tomorrowStart });
    await post('7d->tomorrow (JUMP)',      { start: sevenAgo,   end: tomorrowStart });
    await post('today->tomorrow BLACKPINK',{ start: todayStart, end: tomorrowStart }, { publicArtistId: BLACKPINK_ARTIST });
    await post('7d->tomorrow BLACKPINK',   { start: sevenAgo,   end: tomorrowStart }, { publicArtistId: BLACKPINK_ARTIST });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
