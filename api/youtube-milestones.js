// GET /api/youtube-milestones   — the board the homepage toggle and /youtube read.
//
// PUBLIC, unlike /api/youtube-catalog. The catalog endpoint walks YouTube and
// is admin-gated because it spends quota; this one only reads rows we already
// have, so every visitor can call it. It never touches the YouTube API.
//
// Params (all optional):
//   ?kinds=mv,performance   what counts (default), or 'all'
//   ?near=<days>            only videos arriving within this many days
//   ?limit=<n>              cap the list
//
// Returns { asOf, capturedAt, floor, step, hasRates, counts, blackpink[], members[] }
// — already split, already sorted, so the page renders it without deciding
// anything. Each entry: { videoId, title, channel, artist, kind, views, next,
// gap, pct, rate, days, eta }.

const STEP = 100e6;                     // the public milestone ladder, per video
const nextMilestone = v => Math.ceil((v + 1) / STEP) * STEP;
const prevMilestone = v => Math.floor(v / STEP) * STEP;
const DEFAULT_KINDS = ['mv', 'performance'];

const sbRest = async (path, params) => {
  const url = `${process.env.SUPABASE_URL}/rest/v1${path}?${new URLSearchParams(params)}`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      apikey: process.env.SUPABASE_SERVICE_KEY,
    },
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

// ── who the video belongs to ───────────────────────────────────────────────
// The board groups by ARTIST, not by channel, because a solo MV hosted on the
// BLACKPINK channel — SOLO, LALISA, On The Ground, FLOWER, MONEY — is still a
// solo song and filing it under the group reads as a bug.
//
// The channel cannot answer this (all five of those sit on BLACKPINK's) and
// the YouTube API does not say who an artist is, so it comes from the title,
// which on these channels is rigidly formatted: everything before the first
// dash is the credit. "JENNIE, Doechii - ExtraL", "ROSÉ & Bruno Mars - APT.",
// "JISOO X ZAYN - EYES CLOSED", "BLACKPINK X PUBG MOBILE - Ready For Love".
//
// Derived at read time rather than stored, so correcting the rule is a deploy
// and not a migration plus a backfill.
const MEMBERS = ['JISOO', 'JENNIE', 'ROSE', 'LISA'];
const strip = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

function artistOf(title, channel) {
  const credit = strip(String(title).split(/\s[-–—]\s/)[0]);
  // BLACKPINK first: "BLACKPINK X Selena Gomez" is the group's, not Selena's.
  if (credit.startsWith('BLACKPINK')) return 'BLACKPINK';
  for (const m of MEMBERS) {
    // startsWith, not includes: "JENNIE, Doechii" is Jennie's, while a title
    // that merely mentions a member later is not hers.
    if (credit.startsWith(m)) return m === 'ROSE' ? 'ROSÉ' : m;
  }
  // No usable credit (a Short's chatty title, say) → fall back to the channel.
  const ch = strip(channel);
  if (ch.includes('LLOUD') || ch.includes('LISA')) return 'LISA';
  for (const m of MEMBERS) if (ch.startsWith(m)) return m === 'ROSE' ? 'ROSÉ' : m;
  return 'BLACKPINK';
}

// Newest row per video. PostgREST has no DISTINCT ON, so this takes the rows
// newest-first and keeps the first sighting of each — the same shape roadTo1B()
// uses in api/girlgroups.js, and the table is small enough that one read is
// cheaper than a query per video.
function latestPerVideo(rows) {
  const out = new Map();
  for (const r of rows) if (!out.has(r.video_ref)) out.set(r.video_ref, r);
  return out;
}

export default async function handler(req, res) {
  // A visitor-facing board that moves once a day. A minute of shared cache
  // absorbs a rush without anyone seeing a stale milestone.
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(200).json({ error: 'not-configured', blackpink: [], members: [] });
  }

  const kindsParam = String(req.query.kinds || '').trim();
  const keepAll = kindsParam === 'all';
  const kinds = kindsParam && !keepAll
    ? kindsParam.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_KINDS;
  const near = req.query.near ? Number(req.query.near) : null;
  const limit = req.query.limit ? Math.max(1, parseInt(req.query.limit, 10)) : null;

  try {
    const [videos, stats, rates] = await Promise.all([
      sbRest('/youtube_videos', {
        select: 'id,video_id,title,channel,kind',
        limit: '2000',
      }),
      sbRest('/youtube_video_daily_stats', {
        select: 'video_ref,date,views,captured_at',
        order: 'captured_at.desc',
        limit: '20000',
      }),
      sbRest('/youtube_video_rates', {
        select: 'video_ref,views_per_day,readings,span_days',
        limit: '2000',
      }),
    ]);

    if (!videos.length || !stats.length) {
      return res.status(200).json({
        asOf: null, blackpink: [], members: [],
        note: 'No readings yet — the daily snapshot has not run.',
      });
    }

    const latest = latestPerVideo(stats);
    const rateOf = new Map(rates.map(r => [r.video_ref, r]));

    let asOf = null, capturedAt = null;
    const all = [];
    for (const v of videos) {
      const s = latest.get(v.id);
      if (!s) continue;                                   // never read yet
      if (!keepAll && !kinds.includes(v.kind)) continue;
      if (!asOf || s.date > asOf) { asOf = s.date; capturedAt = s.captured_at; }

      const views = Number(s.views);
      const next = nextMilestone(views), prev = prevMilestone(views);
      const r = rateOf.get(v.id);
      // A rate needs two readings; one reading yields null, never a guess.
      const rate = r && r.views_per_day != null && Number(r.views_per_day) > 0
        ? Number(r.views_per_day) : null;
      const gap = next - views;
      const days = rate ? gap / rate : null;

      all.push({
        videoId: v.video_id,
        title: v.title,
        channel: v.channel,
        artist: artistOf(v.title, v.channel),
        kind: v.kind,
        views, next, gap,
        pct: ((views - prev) / (next - prev)) * 100,
        rate,
        days,
        eta: days == null ? null
          : new Date(Date.now() + days * 86400000).toISOString().slice(0, 10),
        readings: r ? r.readings : 1,
      });
    }

    // Soonest first once rates exist, smallest gap until then. The two disagree
    // — a 16M gap at 130k/day is four months out while a 12.7M gap at 620k/day
    // lands in three weeks — so the board says which one it is using, rather
    // than letting the order quietly change meaning when the rates arrive.
    const hasRates = all.some(x => x.days != null);
    const sortedBy = hasRates ? 'soonest' : 'gap';
    all.sort(hasRates
      // Videos without a rate yet go last, ordered among themselves by gap.
      ? (a, b) => (a.days ?? Infinity) - (b.days ?? Infinity) || a.gap - b.gap
      : (a, b) => a.gap - b.gap);

    let list = all;
    if (near != null) list = list.filter(x => x.days != null && x.days <= near);
    if (limit != null) list = list.slice(0, limit);

    return res.status(200).json({
      asOf, capturedAt, step: STEP,
      kinds: keepAll ? 'all' : kinds,
      sortedBy, hasRates,
      counts: { total: all.length, shown: list.length },
      blackpink: list.filter(x => x.artist === 'BLACKPINK'),
      members: list.filter(x => x.artist !== 'BLACKPINK'),
    });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
