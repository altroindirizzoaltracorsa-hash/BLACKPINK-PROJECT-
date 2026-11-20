// GET /api/youtube-snapshot — one reading a day of every tracked YouTube video.
//
// A PORT OF .github/scripts/snapshot_youtube.py, MOVED HERE FOR ONE REASON:
// GITHUB'S SCHEDULER IS NOT PUNCTUAL AND VERCEL'S IS.
//
// That script does 21 seconds of work and was landing ~9 HOURS LATE, every day:
//
//     scheduled 04:41 UTC  →  ran 13:36 UTC   (8h55m late)
//     scheduled 04:41 UTC  →  ran 13:53 UTC   (9h12m late)
//
// which is the documented GitHub behaviour this repo has measured before (see
// CLAUDE.md on the fetch-catalog slots). It does not break a RATE — the row
// carries hours_since and the page divides by it — but it makes the daily gain
// a floating ~24h window instead of a day. Measured on the hourly series, the
// same drift puts a fixed 00:00 boundary off by a median of 50 minutes and up
// to 110, which is too much to call it "Tuesday's views".
//
// Run from a Vercel cron at 00:00 UTC, the reading lands within about a minute
// of the boundary, so the window IS the UTC day — the same 00:00 UTC day the
// rest of the site uses, which is the point of picking midnight rather than
// keeping 04:41.
//
// THE PYTHON SCRIPT IS NOT DELETED. It stays as the backstop, for the case
// where this endpoint is failing and nobody has noticed — a reading not taken
// is gone for good, which is the whole reason the snapshot exists. It will not
// clobber a punctual row: it now skips a date that already has rows unless
// forced. See the note there.
//
// Reads /api/youtube-catalog (which is where the YouTube API calls happen) and
// writes Supabase REST directly, exactly as the script does. Both ends were
// already HTTP services, which is what made this a port rather than a rewrite.

const BASE_DEFAULT  = 'https://blinksunited.com';
const CHUNK         = 200;
const MIN_VIEWS     = Number(process.env.YT_SNAPSHOT_MIN_VIEWS  || 50000000);
// A release is below any sensible view floor on the day it lands, which is the
// day the board is most worth reading — a new MV climbing to its first 100M is
// the fastest-moving row there will ever be. Recency is a second way past the
// floor, so the video is recorded from day one and has a rate by day two.
const FRESH_DAYS    = Number(process.env.YT_SNAPSHOT_FRESH_DAYS || 30);

const sbUrl = () => (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const sbKey = () => process.env.SUPABASE_SERVICE_KEY || '';

async function sb(method, path, { params, headers, body } = {}) {
  const qs = params ? '?' + new URLSearchParams(params) : '';
  const r = await fetch(`${sbUrl()}/rest/v1${path}${qs}`, {
    method,
    headers: {
      Authorization: `Bearer ${sbKey()}`,
      apikey: sbKey(),
      'Content-Type': 'application/json',
      ...(headers || {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`supabase ${method} ${path} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

// Every video above the floor OR published in the last FRESH_DAYS days, of
// every kind — filtering is the board's job.
async function fetchCatalog(base, adminKey) {
  const url = `${base}/api/youtube-catalog?min=${MIN_VIEWS}&kinds=all&fresh_days=${FRESH_DAYS}`;
  // redirect: 'follow' is the default, and it matters: the apex 308-redirects,
  // which is exactly how the spacing probe failed its first run.
  const r = await fetch(url, { headers: { 'x-admin-secret': adminKey } });
  if (!r.ok) throw new Error(`catalog HTTP ${r.status}`);
  const d = await r.json();
  if (d?.error) throw new Error(`catalog endpoint: ${d.error}`);
  return d;
}

// video_id -> row id. Title, kind and duration are refreshed every run, so a
// retitled or reclassified video updates in place and keeps its history.
async function upsertVideos(videos) {
  const rows = videos.map(v => ({
    video_id: v.id,
    title: v.title ?? null,
    channel: v.channel ?? null,
    channel_id: v.channelId ?? null,
    kind: v.kind ?? null,
    duration_sec: v.durationSec ?? null,
    published_at: v.publishedAt ?? null,
  }));
  const refs = {};
  for (let i = 0; i < rows.length; i += CHUNK) {
    const got = await sb('POST', '/youtube_videos', {
      params: { on_conflict: 'video_id' },
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: rows.slice(i, i + CHUNK),
    }) || [];
    for (const r of got) refs[r.video_id] = r.id;
  }
  return refs;
}

// The latest stored reading per video: { ref: [views, captured_at] }.
// ONE request, newest first, keeping the first occurrence of each ref — the
// alternative is a query per video, which is hundreds of round trips for a
// table this small.
async function previousReadings(refs) {
  if (!refs.length) return {};
  const out = {};
  const rows = await sb('GET', '/youtube_video_daily_stats', {
    params: {
      select: 'video_ref,views,captured_at',
      video_ref: `in.(${refs.join(',')})`,
      order: 'captured_at.desc',
      limit: '20000',
    },
  }) || [];
  for (const r of rows) if (!(r.video_ref in out)) out[r.video_ref] = [r.views, r.captured_at];
  return out;
}

export function buildRows(videos, refs, prev, nowMs, day) {
  const rows = [];
  let skipped = 0;
  for (const v of videos) {
    const ref = refs[v.id];
    if (ref == null) { skipped++; continue; }
    const before = prev[ref];
    let delta = null, hours = null;
    if (before) {
      const [prevViews, prevAt] = before;
      delta = v.views - prevViews;          // may be negative: YouTube recounts
      const t = Date.parse(prevAt);
      if (Number.isFinite(t)) {
        const h = Math.round(((nowMs - t) / 3600000) * 1000) / 1000;
        // Same instant or clock skew: a rate cannot be derived from it, and a
        // bogus hours_since is worse than none.
        hours = h > 0 ? h : null;
      }
    }
    rows.push({
      video_ref: ref,
      date: day,
      views: v.views,
      daily_delta: delta,
      hours_since: hours,
      // NULL IS NOT ZERO. likeCount is absent when the uploader hides it and
      // commentCount when comments are off — common on a soundtrack upload.
      // `|| null` would be wrong here: it would turn a genuine 0 into a gap.
      like_count:    v.likes    === undefined ? null : v.likes,
      comment_count: v.comments === undefined ? null : v.comments,
      captured_at: new Date(nowMs).toISOString(),
    });
  }
  return { rows, skipped };
}

async function writeRows(rows) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await sb('POST', '/youtube_video_daily_stats', {
      params: { on_conflict: 'video_ref,date' },
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: rows.slice(i, i + CHUNK),
    });
  }
}

// channel_id -> row id, for the subscriber series.
async function upsertChannels(channels) {
  const rows = channels.filter(c => c?.id).map(c => ({ channel_id: c.id, title: c.title ?? null }));
  if (!rows.length) return {};
  await sb('POST', '/youtube_channels', {
    params: { on_conflict: 'channel_id' },
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: rows,
  });
  const got = await sb('GET', '/youtube_channels', {
    params: { select: 'id,channel_id', channel_id: `in.(${rows.map(r => r.channel_id).join(',')})` },
  }) || [];
  return Object.fromEntries(got.map(r => [r.channel_id, r.id]));
}

// One subscriber reading per channel per day. NO DELTA COLUMN, deliberately —
// YouTube rounds subscriber counts to three significant figures, so on a 95.8M
// channel the step is 100,000 and a day-over-day difference reports the
// rounding rather than the fandom.
async function writeChannelStats(channels, refs, day, nowMs) {
  const rows = [];
  for (const c of channels) {
    const ref = refs[c?.id];
    if (ref == null) continue;
    rows.push({
      channel_ref: ref,
      date: day,
      subscribers: c.subscribers === undefined ? null : c.subscribers,  // null when hidden, not 0
      captured_at: new Date(nowMs).toISOString(),
    });
  }
  if (!rows.length) return 0;
  await sb('POST', '/youtube_channel_daily_stats', {
    params: { on_conflict: 'channel_ref,date' },
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: rows,
  });
  return rows.length;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Vercel cron sends Authorization: Bearer CRON_SECRET. The admin header is
  // for a manual kick. Same shape as /api/streams?cron=1 and
  // /api/youtube-history?snapshot=1.
  const cronSecret = process.env.CRON_SECRET, adminSecret = process.env.ADMIN_SECRET;
  const given = req.headers['x-admin-secret'] || req.query.key;
  const ok = (cronSecret && req.headers.authorization === `Bearer ${cronSecret}`)
          || (adminSecret && given === adminSecret);
  if (!ok) return res.status(401).json({ error: 'unauthorized' });

  if (!sbUrl() || !sbKey()) return res.status(200).json({ error: 'not-configured' });

  const base = (process.env.SNAPSHOT_BASE || BASE_DEFAULT).replace(/\/+$/, '');
  const adminKey = adminSecret || '';
  const nowMs = Date.now();
  // THE UTC DATE, like everything else on this site. Never a local one — see
  // CLAUDE.md. Fired at 00:00 UTC this labels the day that just ended... which
  // is NOT what we want: a reading taken at 00:00 on the 21st measures the
  // 20th. `date` here has always meant "the date this reading was taken", and
  // every consumer (buildDaily, bucketBy, youtube_video_rates) treats it that
  // way, so changing its meaning would silently reinterpret 80 days of stored
  // rows. It stays "when the reading was taken".
  const day = String(req.query.date || new Date(nowMs).toISOString().slice(0, 10));

  try {
    const d = await fetchCatalog(base, adminKey);
    const videos = d?.videos || [];
    if (!videos.length) {
      // Not a quiet day — the catalogue is never legitimately empty, and
      // recording an empty reading would write a day of nulls over a real one.
      return res.status(200).json({ error: 'empty-catalog', wrote: 0 });
    }

    if (req.query.dry) {
      const haveLikes    = videos.filter(v => v.likes    != null).length;
      const haveComments = videos.filter(v => v.comments != null).length;
      return res.status(200).json({
        dry: true, day, videos: videos.length,
        likesPublished: `${haveLikes}/${videos.length}`,
        commentsPublished: `${haveComments}/${videos.length}`,
        channels: (d.channels || []).length,
      });
    }

    const refs = await upsertVideos(videos);
    const prev = await previousReadings([...new Set(Object.values(refs))]);
    const { rows, skipped } = buildRows(videos, refs, prev, nowMs, day);
    await writeRows(rows);

    // Subscribers, per channel rather than per video. Guarded on its own so a
    // table that has not been migrated yet cannot take the view snapshot down
    // with it — the views are the thing this job exists for, and they are
    // already written by the line above.
    let channelRows = 0, channelError = null;
    try {
      const chans = d.channels || [];
      const chanRefs = await upsertChannels(chans);
      channelRows = await writeChannelStats(chans, chanRefs, day, nowMs);
    } catch (e) { channelError = String(e.message || e).slice(0, 200); }

    // How many videos published each figure. A soundtrack upload with comments
    // off is normal; ALL of them going null at once is the catalog endpoint
    // having stopped asking for the statistics part, which is silent otherwise.
    const noLikes    = rows.filter(r => r.like_count    == null).length;
    const noComments = rows.filter(r => r.comment_count == null).length;
    return res.status(200).json({
      ok: true, day, wrote: rows.length, skipped,
      likesPublished:    `${rows.length - noLikes}/${rows.length}`,
      commentsPublished: `${rows.length - noComments}/${rows.length}`,
      channelRows, channelError,
      tookMs: Date.now() - nowMs,
    });
  } catch (e) {
    return res.status(500).json({ error: 'failed', detail: String(e.message || e).slice(0, 300) });
  }
}
