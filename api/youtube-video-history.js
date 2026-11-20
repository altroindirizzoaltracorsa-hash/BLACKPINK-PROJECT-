// GET /api/youtube-video-history?video=<youtube id>
//
// One video's view history, bucketed the way kworb presents one: by day, by
// week, by month. Read by the history panel on /youtube.
//
// A SEPARATE FILE FROM api/youtube-history.js, which is a different thing with
// a confusingly similar name: that one serves the minute-by-minute Redis
// series behind /vs.html and is admin-gated. This reads the daily Supabase
// snapshot and is public, like /api/youtube-milestones, because it only
// returns rows we already have and never touches the YouTube API.
//
// Returns { videoId, title, channel, kind, first, last, days, daily[],
//           weekly[], monthly[], note }
// Each bucket: { key, label, views, gain, partial }.

// ── WHAT A BUCKET'S GAIN IS, AND WHY IT IS NOT A SUM OF DAILY DELTAS ───────
//
// View counts are CUMULATIVE, so the gain across any span is simply the views
// at the end minus the views before it started. That is immune to a missing
// reading inside the span, and it cannot be skewed by one reading landing late
// — the two failure modes that sink an average of per-row deltas. It is the
// same rule youtube_video_rates uses and the same one CLAUDE.md records for
// Spotify spans ("a per-track rate must come from the SPAN").
//
// A sum of daily_delta would ALSO be wrong for a second reason here: the first
// reading of a video has daily_delta null, so a month containing it would
// silently drop that day.
const bucketGain = (rows, i, buckets) => {
  const prev = i > 0 ? buckets[i - 1] : null;
  const prevViews = prev ? prev.views : null;
  // No previous bucket means no baseline — the first one in the series shows
  // its level and no gain, rather than a gain measured from zero, which would
  // report a 2.4-billion-view video as having gained 2.4 billion that week.
  return prevViews == null ? null : rows.views - prevViews;
};

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

// ISO week, because a week that starts on Sunday in one place and Monday in
// another is two different numbers for the same days. Monday-based, UTC.
export function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;            // Mon=1 … Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - day);    // Thursday decides the year
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return { year: t.getUTCFullYear(), week };
}
// The Monday that starts the ISO week a date falls in — used for the label, so
// a reader sees "Nov 16-22" rather than "2026-W47".
function isoWeekStart(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() - (day - 1));
  return t;
}
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const dayLabel = (iso) => {
  const d = new Date(iso + 'T00:00:00Z');
  return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
};
const weekLabel = (start) => {
  const end = new Date(start.getTime() + 6 * 86400000);
  return start.getUTCMonth() === end.getUTCMonth()
    ? `${MON[start.getUTCMonth()]} ${start.getUTCDate()}–${end.getUTCDate()}`
    : `${MON[start.getUTCMonth()]} ${start.getUTCDate()} – ${MON[end.getUTCMonth()]} ${end.getUTCDate()}`;
};

// Collapse the daily readings into buckets. `keyOf` decides which bucket a
// reading belongs to; the bucket takes the LAST reading inside it, because its
// level at the end is what the next bucket measures from.
export function bucketBy(series, keyOf, labelOf) {
  const order = [];
  const byKey = new Map();
  for (const r of series) {
    const k = keyOf(r);
    if (!byKey.has(k)) { byKey.set(k, { key: k, label: labelOf(r), views: null, date: null, from: r.date }); order.push(k); }
    const b = byKey.get(k);
    // series is ascending, so the last row seen in a bucket is its latest.
    b.views = Number(r.views);
    b.likes    = r.like_count    == null ? null : Number(r.like_count);
    b.comments = r.comment_count == null ? null : Number(r.comment_count);
    b.date = r.date;
  }
  const out = order.map(k => byKey.get(k));
  return out.map((b, i) => ({
    key: b.key,
    label: b.label,
    from: b.from,
    to: b.date,
    views: b.views,
    gain: bucketGain(b, i, out),
    likes: b.likes,
    comments: b.comments,
  }));
}

// The daily view, exported so it can be driven directly in a test rather than
// only through a live Supabase round trip.
//
// NORMALISED to 24h, matching the board's "Daily gain". The raw daily_delta is
// views since the PREVIOUS READING and that gap is not always a day — the
// snapshot's own hours_since column exists because these land 22-26h apart and
// occasionally much further. Where hours_since is missing, fall back to
// differencing the cumulative views, which needs no gap at all.
export function buildDaily(series) {
  return series.map((r, i) => {
    const hrs = Number(r.hours_since);
    const raw = r.daily_delta == null ? null : Number(r.daily_delta);
    const gain = raw != null && Number.isFinite(hrs) && hrs > 0
      ? Math.round((raw / hrs) * 24)
      : (i > 0 ? Number(r.views) - Number(series[i - 1].views) : null);
    return {
      key: r.date,
      label: dayLabel(r.date),
      from: r.date, to: r.date,
      views: Number(r.views),
      gain,
      hours: Number.isFinite(hrs) ? hrs : null,
      // NULL IS NOT ZERO: likes are absent when the uploader hides them and
      // comments when they are switched off, which is common on a soundtrack
      // upload. A 0 would say nobody did it.
      likes:    r.like_count    == null ? null : Number(r.like_count),
      comments: r.comment_count == null ? null : Number(r.comment_count),
    };
  });
}

// Week and month buckets off the same ascending series.
export function buildBuckets(series) {
  const weekly = bucketBy(series,
    r => { const w = isoWeek(new Date(r.date + 'T00:00:00Z')); return `${w.year}-W${String(w.week).padStart(2, '0')}`; },
    r => weekLabel(isoWeekStart(new Date(r.date + 'T00:00:00Z'))));
  const monthly = bucketBy(series,
    r => r.date.slice(0, 7),
    r => { const d = new Date(r.date + 'T00:00:00Z'); return `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; });
  return { weekly, monthly };
}

export default async function handler(req, res) {
  // Moves once a day. A few minutes of shared cache absorbs a rush on a
  // release without anyone seeing a stale figure.
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=900');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const videoId = String(req.query.video || '').trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'bad-video-id' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(200).json({ error: 'not-configured' });
  }

  try {
    const vids = await sbRest('/youtube_videos', {
      select: 'id,video_id,title,channel,channel_id,kind',
      video_id: `eq.${videoId}`,
      limit: '1',
    });
    if (!vids.length) {
      return res.status(200).json({ videoId, note: 'This video is not in the snapshot yet.', daily: [], weekly: [], monthly: [] });
    }
    const v = vids[0];

    // Ascending, so buckets build in order and "the last row in this bucket"
    // is simply the last one seen.
    const series = await sbRest('/youtube_video_daily_stats', {
      select: 'date,views,daily_delta,hours_since,like_count,comment_count,captured_at',
      video_ref: `eq.${v.id}`,
      order: 'date.asc',
      limit: '4000',
    });
    if (!series.length) {
      return res.status(200).json({ videoId, title: v.title, note: 'No readings for this video yet.', daily: [], weekly: [], monthly: [] });
    }

    // DAILY shows the per-reading gain NORMALISED to 24h, matching the board's
    // "Daily gain" figure. The raw daily_delta is views since the previous
    // reading and that gap is not always a day — the snapshot's own
    // hours_since column exists because scheduled runs here land 22-26h apart,
    // and occasionally much further.
    const daily = buildDaily(series);

    const { weekly, monthly } = buildBuckets(series);

    // The channel's subscriber level, for the page header. Its OWN query and
    // its own try/catch: these tables are newer than the video ones, so a
    // database that has not had the migration applied yet must still serve
    // the history rather than erroring on a header line.
    //
    // NO SUBSCRIBER GAIN IS COMPUTED. YouTube rounds the count to three
    // significant figures, so on a 95.8M channel the step is 100,000 and a
    // day-over-day difference reports the rounding, not the fandom: several
    // days of exactly 0 and then one jump of a whole step.
    let subscribers = null, subscribersAt = null;
    try {
      const chans = await sbRest('/youtube_channels', {
        select: 'id', channel_id: `eq.${v.channel_id || ''}`, limit: '1',
      });
      if (chans.length) {
        const rows = await sbRest('/youtube_channel_daily_stats', {
          select: 'subscribers,date', channel_ref: `eq.${chans[0].id}`,
          order: 'date.desc', limit: '1',
        });
        if (rows.length && rows[0].subscribers != null) {
          subscribers = Number(rows[0].subscribers);
          subscribersAt = rows[0].date;
        }
      }
    } catch (_) { /* not migrated yet — the history is still the point */ }

    const first = series[0].date, last = series[series.length - 1].date;
    const days = Math.round((Date.parse(last) - Date.parse(first)) / 86400000) + 1;

    // THE FIRST BUCKET OF EVERY VIEW HAS NO GAIN, and that is honest rather
    // than missing: there is no reading before it to measure from. The panel
    // renders it as a level with a dash, not as a zero.
    return res.status(200).json({
      videoId, title: v.title, channel: v.channel, kind: v.kind,
      subscribers, subscribersAt,
      first, last, days, readings: series.length,
      daily, weekly, monthly,
    });
  } catch (e) {
    return res.status(200).json({ error: 'unavailable', detail: String(e.message || e).slice(0, 200) });
  }
}
