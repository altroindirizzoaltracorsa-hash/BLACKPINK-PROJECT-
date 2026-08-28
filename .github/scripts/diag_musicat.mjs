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

  // 3. Raw Musicat history/stats POST (all-time, BLACKPINK artist), and a track one
  if (publicId) {
    const bodyArtist = { range: { start: null, end: null }, publicUserId: publicId, publicArtistId: BLACKPINK_ARTIST, metrics: ['total_streams'], withDeltas: false };
    const sa = await get(`${MC}/history/stats`, { method: 'POST', headers: MC_HEADERS, body: JSON.stringify(bodyArtist) });
    console.log('── raw musicat /history/stats (BLACKPINK all-time) ──');
    console.log('status', sa.status, '| body:', sa.text.slice(0, 400));

    const bodyTrack = { range: { start: null, end: null }, publicUserId: publicId, publicTrackId: JUMP_TRACK, metrics: ['total_streams'], withDeltas: false };
    const st = await get(`${MC}/history/stats`, { method: 'POST', headers: MC_HEADERS, body: JSON.stringify(bodyTrack) });
    console.log('── raw musicat /history/stats (JUMP all-time) ──');
    console.log('status', st.status, '| body:', st.text.slice(0, 400));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
