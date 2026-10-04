// Exercise api/youtube-milestones.js against a stubbed Supabase.
//
// Run: node .github/scripts/test_youtube_milestones.mjs
//
// The artist rule carries the most risk here: it is the only thing standing
// between "JENNIE - 'SOLO' M/V" and a solo single appearing under the group,
// and it has to work from the title because all five members' older MVs sit on
// the BLACKPINK channel. So it is tested against the real titles the live
// catalogue returned, not invented ones.
process.env.SUPABASE_URL = 'https://stub';
process.env.SUPABASE_SERVICE_KEY = 'k';

// ── the fixture: real titles, real channels, plausible counts ──────────────
const V = [
  [1, 'go',  "BLACKPINK - ‘GO’ M/V",                              'BLACKPINK',      'mv'],
  [2, 'sol', "JENNIE - 'SOLO' M/V",                               'BLACKPINK',      'mv'],
  [3, 'otg', "ROSÉ - 'On The Ground' M/V",                        'BLACKPINK',      'mv'],
  [4, 'lal', "LISA - 'LALISA' M/V",                               'BLACKPINK',      'mv'],
  [5, 'flo', "JISOO - ‘꽃(FLOWER)’ M/V",                           'BLACKPINK',      'mv'],
  [6, 'apt', "ROSÉ & Bruno Mars - APT. (Official Music Video)",    'ROSÉ',           'mv'],
  [7, 'ext', "JENNIE, Doechii - ExtraL (Official Video)",          'JENNIE',         'mv'],
  [8, 'eye', "JISOO X ZAYN - EYES CLOSED (OFFICIAL MV)",           'JISOO',          'mv'],
  [9, 'rfl', "BLACKPINK X PUBG MOBILE - ‘Ready For Love’ M/V",     'BLACKPINK',      'mv'],
  [10,'ice', "BLACKPINK X Selena Gomez - 'Ice Cream' DANCE PERFORMANCE VIDEO", 'BLACKPINK', 'performance'],
  [11,'swd', "LISA - SaWaDiKa (Official Music Video)",             'LLOUD Official', 'mv'],
  [12,'sho', "🌹 and 🌷 #JISOO_FLOWER #지수꽃",                      'BLACKPINK',      'short'],
];
const VIDEOS = V.map(([id, vid, title, channel, kind]) =>
  ({ id, video_id: vid, title, channel, kind }));

// One reading each; two for GO and APT so they have rates.
const STATS = [
  { video_ref: 1,  date: '2026-10-05', views:  96_900_000, captured_at: '2026-10-05T04:41:00Z' },
  { video_ref: 1,  date: '2026-10-04', views:  96_819_143, captured_at: '2026-10-04T20:34:00Z' },
  { video_ref: 6,  date: '2026-10-05', views: 2_703_900_000, captured_at: '2026-10-05T04:41:00Z' },
  { video_ref: 6,  date: '2026-10-04', views: 2_701_266_104, captured_at: '2026-10-04T20:34:00Z' },
  { video_ref: 2,  date: '2026-10-04', views: 1_090_872_402, captured_at: '2026-10-04T20:34:00Z' },
  { video_ref: 3,  date: '2026-10-04', views:   394_299_743, captured_at: '2026-10-04T20:34:00Z' },
  { video_ref: 4,  date: '2026-10-04', views:   784_156_970, captured_at: '2026-10-04T20:34:00Z' },
  { video_ref: 5,  date: '2026-10-04', views:   661_677_117, captured_at: '2026-10-04T20:34:00Z' },
  { video_ref: 7,  date: '2026-10-04', views:   138_037_025, captured_at: '2026-10-04T20:34:00Z' },
  { video_ref: 8,  date: '2026-10-04', views:   111_570_380, captured_at: '2026-10-04T20:34:00Z' },
  { video_ref: 9,  date: '2026-10-04', views:   191_407_999, captured_at: '2026-10-04T20:34:00Z' },
  { video_ref: 10, date: '2026-10-04', views:   148_778_278, captured_at: '2026-10-04T20:34:00Z' },
  { video_ref: 11, date: '2026-10-04', views:   196_556_674, captured_at: '2026-10-04T20:34:00Z' },
  { video_ref: 12, date: '2026-10-04', views:    98_605_553, captured_at: '2026-10-04T20:34:00Z' },
];
// GO: +80,857 over 8.12h → ~239k/day.  APT: +2,633,896 over 8.12h → ~7.8M/day.
let RATES = [
  { video_ref: 1, views_per_day: 239_000, readings: 2, span_days: 0.338 },
  { video_ref: 6, views_per_day: 7_785_000, readings: 2, span_days: 0.338 },
];

globalThis.fetch = async (url) => {
  const u = new URL(url);
  const path = u.pathname.replace('/rest/v1', '');
  const body = path === '/youtube_videos' ? VIDEOS
             : path === '/youtube_video_daily_stats' ? STATS
             : path === '/youtube_video_rates' ? RATES
             : null;
  if (!body) return { ok: false, status: 404, text: async () => 'nope' };
  return { ok: true, json: async () => body };
};

const { default: handler, } = await import(new URL('../../api/youtube-milestones.js', import.meta.url).href);

const call = async (query = {}) => {
  let out;
  await handler({ method: 'GET', query },
    { setHeader() {}, status(c) { this._c = c; return this; },
      json(b) { out = { code: this._c, body: b }; return this; }, end() { out = { code: this._c }; } });
  return out;
};

let fails = [];
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails.push(m); };

console.log('--- the artist rule (the risky part)');
let r = await call({ kinds: 'all' });
const byId = Object.fromEntries([...r.body.blackpink, ...r.body.members].map(x => [x.videoId, x]));
const expect = {
  go: 'BLACKPINK', sol: 'JENNIE', otg: 'ROSÉ', lal: 'LISA', flo: 'JISOO',
  apt: 'ROSÉ', ext: 'JENNIE', eye: 'JISOO', rfl: 'BLACKPINK', ice: 'BLACKPINK',
  swd: 'LISA', sho: 'BLACKPINK',
};
for (const [vid, want] of Object.entries(expect)) {
  check(byId[vid]?.artist === want,
        `${want.padEnd(9)} ← ${byId[vid]?.title.slice(0, 48)}`);
}
check(byId.sol.channel === 'BLACKPINK' && byId.sol.artist === 'JENNIE',
      "SOLO is on the BLACKPINK channel and still files under JENNIE — "
      + 'the whole reason the split is by artist and not channel');
check(byId.ice.artist === 'BLACKPINK',
      '"BLACKPINK X Selena Gomez" is the group\'s, not Selena\'s');

console.log('\n--- the split');
r = await call();
check(r.body.blackpink.every(x => x.artist === 'BLACKPINK'), 'blackpink[] is group only');
check(r.body.members.every(x => x.artist !== 'BLACKPINK'), 'members[] has no group songs');
check(r.body.members.some(x => x.videoId === 'sol'), 'and SOLO is in it');

console.log('\n--- kinds');
check(!byId.sho || [...r.body.blackpink, ...r.body.members].every(x => x.videoId !== 'sho'),
      'the Short is excluded by default');
const withAll = await call({ kinds: 'all' });
check([...withAll.body.blackpink, ...withAll.body.members].some(x => x.videoId === 'sho'),
      'kinds=all includes it — the row was recorded, it is only hidden');

console.log('\n--- milestones');
const go = byId.go;
check(go.next === 100_000_000, `GO targets 100M (got ${go.next / 1e6}M)`);
r = await call();
const goNow = [...r.body.blackpink].find(x => x.videoId === 'go');
check(goNow.views === 96_900_000,
      `uses the NEWEST reading, not the first one seen (${goNow.views.toLocaleString()})`);
check(goNow.gap === 3_100_000, `gap is 3,100,000 (got ${goNow.gap.toLocaleString()})`);
check(Math.abs(goNow.pct - 96.9) < 0.01, `pct is through the 0→100M band, 96.9 (got ${goNow.pct.toFixed(2)})`);

console.log('\n--- rates and ETA');
check(goNow.rate === 239_000 && Math.abs(goNow.days - 12.97) < 0.05,
      `GO: 239,000/day → ${goNow.days.toFixed(1)} days`);
check(goNow.eta && /^\d{4}-\d{2}-\d{2}$/.test(goNow.eta), `and an eta date (${goNow.eta})`);
const sol = r.body.members.find(x => x.videoId === 'sol');
check(sol.rate === null && sol.days === null && sol.eta === null,
      'a video with one reading gets null, never a guessed rate');

console.log('\n--- sort order');
check(r.body.sortedBy === 'soonest', `sortedBy reports "soonest" (${r.body.sortedBy})`);
const bp = r.body.blackpink.map(x => x.videoId);
check(bp[0] === 'go', `GO leads the group list on time, not distance (${bp.slice(0, 3).join(', ')})`);
const bpDays = r.body.blackpink.map(x => x.days ?? Infinity);
check(bpDays.every((d, i) => i === 0 || bpDays[i - 1] <= d),
      'and the rest of the list really is soonest-first, rate-less entries last');
const mem = r.body.members.map(x => x.videoId);
check(mem[0] === 'apt', `APT leads the members list (${mem.slice(0, 3).join(', ')})`);

RATES = [];
const noRates = await call();
check(noRates.body.sortedBy === 'gap' && noRates.body.hasRates === false,
      'with no rates at all it falls back to gap and says so');
// Each list is ordered on its own. Concatenating them is NOT ordered and must
// not be expected to be — the response is already split, and the page renders
// the two blocks independently.
for (const [name, rows] of [['blackpink', noRates.body.blackpink], ['members', noRates.body.members]]) {
  const g = rows.map(x => x.gap);
  check(g.every((x, i) => i === 0 || g[i - 1] <= x), `${name}[] is gap-ordered (${g.length} rows)`);
}

console.log('\n--- near / limit');
RATES = [{ video_ref: 1, views_per_day: 239_000, readings: 2, span_days: 0.338 },
         { video_ref: 6, views_per_day: 7_785_000, readings: 2, span_days: 0.338 }];
const nearR = await call({ near: '13' });
const nearIds = [...nearR.body.blackpink, ...nearR.body.members].map(x => x.videoId);
check(nearIds.includes('go') && !nearIds.includes('sol'),
      `near=13 keeps only what arrives in time (${nearIds.join(', ')})`);
const lim = await call({ limit: '2' });
check(lim.body.counts.shown === 2 && lim.body.counts.total > 2,
      `limit caps the list but counts.total still reports everything (${lim.body.counts.shown}/${lim.body.counts.total})`);

console.log('\n--- asOf');
check(r.body.asOf === '2026-10-05', `asOf is the newest reading's date (${r.body.asOf})`);

console.log(`\nFAILURES: ${fails.length}`);
fails.forEach(f => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
