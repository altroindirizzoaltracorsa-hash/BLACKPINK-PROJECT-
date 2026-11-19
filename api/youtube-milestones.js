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
// How far behind the newest reading a video may fall before the board stops
// showing it. Not a tuning knob — it is the line between "the snapshot was
// partial today" and "this video is no longer being read".
const STALE_DAYS = 7;

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

// ── DAILY GAIN ─────────────────────────────────────────────────────────────
// Two numbers, because one of them alone would mislead.
//
// `gain` is the newest reading's delta NORMALISED to 24 hours. The raw
// daily_delta is "views since the previous reading", and that gap is not a day
// — GitHub delays scheduled runs on this repo by 2-5 hours routinely, so a run
// 29 hours after the last one shows 29 hours of views under a label saying
// "day". Dividing by hours_since and multiplying by 24 is the whole fix, and
// it is why hours_since exists on the table at all.
//
// `gain7` is a SPAN over the last week: views gained between the oldest and
// newest readings in the window, divided by the days actually elapsed. That is
// the Magnetic rule, and the table's own comment says why averaging the deltas
// instead would be wrong. It is the steadier figure and the one worth reading
// when yesterday was odd.
//
// A NEGATIVE GAIN IS REAL. YouTube recounts continuously and takes totals back
// down; the schema says anything reading daily_delta must cope with a negative
// and must not "fix" it. So nothing here clamps.
const RECENT_DAYS = 7;
function gainsPerVideo(rows) {
  const byVideo = new Map();
  for (const r of rows) {
    if (!byVideo.has(r.video_ref)) byVideo.set(r.video_ref, []);
    byVideo.get(r.video_ref).push(r);
  }
  const out = new Map();
  for (const [ref, list] of byVideo) {
    // The query already orders captured_at descending, but this does not rely
    // on that staying true.
    list.sort((a, b) => Date.parse(b.captured_at) - Date.parse(a.captured_at));
    const newest = list[0];
    let gain = null;
    const hrs = Number(newest.hours_since);
    if (newest.daily_delta != null && Number.isFinite(hrs) && hrs > 0) {
      gain = Math.round((Number(newest.daily_delta) / hrs) * 24);
    }
    // The oldest reading still inside the window, so the span is real elapsed
    // time rather than a row count.
    const cutoff = Date.parse(newest.captured_at) - RECENT_DAYS * 86400000;
    let oldest = null;
    for (const r of list) if (Date.parse(r.captured_at) >= cutoff) oldest = r;
    let gain7 = null, spanDays = null;
    if (oldest && oldest !== newest) {
      spanDays = (Date.parse(newest.captured_at) - Date.parse(oldest.captured_at)) / 86400000;
      if (spanDays > 0) gain7 = Math.round((Number(newest.views) - Number(oldest.views)) / spanDays);
    }
    out.set(ref, { gain, gain7, gainSpanDays: spanDays });
  }
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
        // daily_delta and hours_since come along for the DAILY GAIN. They are
        // already on every row this query returns, so the gain costs no extra
        // request — it was being fetched and thrown away.
        select: 'video_ref,date,views,captured_at,daily_delta,hours_since',
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
    const gainOf = gainsPerVideo(stats);
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
        // The day's gain, and the steadier week-span version beside it.
        gain:  (gainOf.get(v.id) || {}).gain  ?? null,
        gain7: (gainOf.get(v.id) || {}).gain7 ?? null,
        gainSpanDays: (gainOf.get(v.id) || {}).gainSpanDays ?? null,
        days,
        eta: days == null ? null
          : new Date(Date.now() + days * 86400000).toISOString().slice(0, 10),
        readings: r ? r.readings : 1,
        _date: s.date,
      });
    }

    // A row the snapshot has stopped reading must leave, not sit there frozen.
    // The board stamps ONE "as of" date across the whole page, so a video that
    // dropped out of the catalogue — aged past the fresh-release window still
    // under the floor, renamed, made private, moved channel — would keep its
    // last reading and wear today's date. Stale beats missing nowhere here: a
    // view count is a number people quote. STALE_DAYS of slack, because a
    // partial snapshot can legitimately leave a few videos a day behind.
    const newest = all.reduce((d, x) => (x._date > d ? x._date : d), '');
    const cutoff = new Date(Date.parse(newest) - STALE_DAYS * 86400000)
      .toISOString().slice(0, 10);
    const fresh = all.filter(x => x._date >= cutoff);
    const dropped = all.length - fresh.length;
    all.length = 0;
    all.push(...fresh);
    for (const x of all) delete x._date;

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
      counts: { total: all.length, shown: list.length, droppedStale: dropped },
      blackpink: list.filter(x => x.artist === 'BLACKPINK'),
      members: list.filter(x => x.artist !== 'BLACKPINK'),
    });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
