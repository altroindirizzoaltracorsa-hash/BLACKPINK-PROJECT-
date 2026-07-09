import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const TRACKS = {
  jump:     '5H1sKFMzDeMtXwND3V6hRY',
  shutdown: '6tCd8bPvYnceDG7W9M1RMk',
  ddududu:  '69BIczdH6QMnFx7dsSssN8',
};

// Spotify's public play count generally only jumps once a day, sometime
// between midday and late evening Italy time. Outside that window (or once
// today's jump has already landed) there's nothing new to find, so we poll
// far less aggressively there to protect the RapidAPI quota.
function getCacheTtlMs(needsDailyUpdate) {
  if (!needsDailyUpdate) return 4 * 60 * 60 * 1000; // today's bump already seen — recheck in ~4h
  const romeHour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: 'numeric', hour12: false }).format(new Date())
  );
  if (romeHour < 12) return Infinity; // before midday — Spotify never updates this early, don't call at all
  return 15 * 60 * 1000; // in the daily watch window — poll every ~15min
}

// Returns all configured RapidAPI keys for the given env vars, in priority order.
// Add extras as RAPIDAPI_KEYS=key1,key2,key3 in Vercel env vars.
// RAPIDAPI_KEYS_2 is a spillover slot for adding more keys to the same provider
// without touching the existing var (handy when editing env vars from a phone).
function getApiKeys(envVarNames) {
  const keys = [];
  for (const name of envVarNames) {
    const envVar = process.env[name];
    if (!envVar) continue;
    for (const k of envVar.split(',').map(k => k.trim()).filter(Boolean)) {
      if (!keys.includes(k)) keys.push(k);
    }
  }
  return keys;
}

// Two independent RapidAPI providers, each with its own subscription/quota.
// If every key on one provider is rate-limited or quota-exceeded, we move on
// to the next provider entirely before giving up.
const PROVIDERS = [
  {
    name: 'spotify-scraper',
    host: 'spotify-scraper.p.rapidapi.com',
    keyEnvVars: ['RAPIDAPI_KEYS', 'RAPIDAPI_KEYS_2', 'RAPIDAPI_KEY'],
    url: trackId => `https://spotify-scraper.p.rapidapi.com/v1/track/metadata?trackId=${trackId}`,
    // 429 = rate limit, 403 = quota exceeded, data.message = API-level error
    isQuotaError: (r, data) => r.status === 429 || r.status === 403 || !!data?.message,
    getPlayCount: data => Number(data?.playCount) || 0,
  },
  {
    name: 'spotify-scraper-api',
    host: 'spotify-scraper-api.p.rapidapi.com',
    keyEnvVars: ['RAPIDAPI_KEYS_API2'],
    url: trackId => `https://spotify-scraper-api.p.rapidapi.com/api/v1/track/info?track_id=${trackId}`,
    // 429 = rate limit, 403 = quota exceeded, anything other than status "Successful" is an error
    isQuotaError: (r, data) => r.status === 429 || r.status === 403 || data?.status !== 'Successful',
    getPlayCount: data => Number(data?.data?.playcount) || 0,
  },
];

// Tries each provider in order, and within a provider tries each key in
// order, moving on if one is rate-limited or quota-exceeded.
async function fetchTrackMetadata(trackId) {
  let lastError = 'No API keys configured';
  for (const provider of PROVIDERS) {
    const keys = getApiKeys(provider.keyEnvVars);
    for (const key of keys) {
      const r = await fetch(provider.url(trackId), {
        headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': provider.host },
      });
      const data = await r.json();
      if (provider.isQuotaError(r, data)) {
        lastError = data?.message || `HTTP ${r.status}`;
        continue;
      }
      if (!r.ok) { lastError = `HTTP ${r.status}`; continue; }
      return { playCount: provider.getPlayCount(data) };
    }
  }
  throw new Error(lastError);
}

function getDateLabel(date) {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}
function parseDateLabel(label) {
  const [dd, mm] = label.split('/').map(Number);
  return new Date(Date.UTC(new Date().getUTCFullYear(), mm - 1, dd));
}
function daysBetween(labelA, labelB) {
  return Math.round((parseDateLabel(labelB) - parseDateLabel(labelA)) / 86_400_000);
}
function addDaysToLabel(ddmm, n) {
  const [dd, mm] = ddmm.split('/').map(Number);
  const d = new Date(Date.UTC(new Date().getUTCFullYear(), mm - 1, dd + n));
  return getDateLabel(d);
}
function yesterdayLabel() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return getDateLabel(d);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const isCron = req.query.cron === '1';
  if (isCron) {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers['authorization'] !== `Bearer ${secret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // Manual escape hatch for when a RapidAPI quota outage causes a day's entry
  // to go unrecorded — lets an admin force a real (non-cached) fetch on demand
  // instead of waiting for the next watch-window poll or the midnight cron.
  const isForced = req.query.force === '1';
  if (isForced) {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret || req.query.key !== adminSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // Manual escape hatch for directly setting/correcting a single day's history
  // entry — for when the upstream play count genuinely never moved (e.g. a
  // multi-day Spotify reporting freeze), so there's no live diff to compute and
  // the normal fetch-and-diff flow has nothing to write.
  if (req.query.action === 'set-entry') {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret || req.query.key !== adminSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { track, date, streams, total } = req.query;
    if (!TRACKS[track] || !date || streams === undefined) {
      return res.status(400).json({ error: 'Requires track, date (dd/mm), and streams query params' });
    }

    // Share the same per-track lock as the regular fetch loop below — without
    // this, a manual correction can land in the middle of a cron/visitor-poll
    // fetch and get its write clobbered (or clobber that fetch's write).
    const lockKey = `bp_lock_${track}`;
    const gotLock = !!(await redis.set(lockKey, '1', { nx: true, ex: 30 }));
    if (!gotLock) {
      return res.status(409).json({ error: 'Track is busy updating, try again in a few seconds' });
    }
    try {
      const histKey = `bp_hist_${track}`;
      const history = (await redis.get(histKey)) || [];
      const entry = history.find(h => h.date === date);
      if (entry) {
        entry.streams = Number(streams);
      } else {
        history.push({ date, streams: Number(streams) });
        history.sort((a, b) => parseDateLabel(a.date) - parseDateLabel(b.date));
      }
      await redis.set(histKey, history);

      // Optional: also correct the running total/snapshot used as the baseline
      // for the next live diff, so a backfilled day doesn't get double-counted
      // once real fetches resume. The asserted date always wins here, since a
      // stale or race-written prev snapshot shouldn't override an explicit fix.
      if (total !== undefined) {
        const prevKey = `bp_prev_${track}`;
        const liveKey = `bp_live_${track}`;
        await redis.set(prevKey, { total: Number(total), date });
        await redis.set(liveKey, { total: Number(total), ts: Date.now() });
      }

      return res.status(200).json({ ok: true, track, history });
    } finally {
      await redis.del(lockKey);
    }
  }

  const todayLabel = getDateLabel(new Date());
  const results    = {};
  const errors     = {};
  let fetchedLive  = false;

  for (const [name, trackId] of Object.entries(TRACKS)) {
    const liveKey = `bp_live_${name}`;
    const prevKey = `bp_prev_${name}`;
    const histKey = `bp_hist_${name}`;
    const errKey  = `bp_err_${name}`;
    const lockKey = `bp_lock_${name}`;
    let gotLock = false;

    try {
      // Overlapping requests (cron + a concurrent visitor poll, say) can both read
      // history/prev at once and then race to write it back, silently losing
      // whichever update saves first. A short-lived per-track lock serializes the
      // read-modify-write so only one request updates a track at a time; a request
      // that loses the race just returns the current cached snapshot instead.
      gotLock = !!(await redis.set(lockKey, '1', { nx: true, ex: 30 }));
      if (!gotLock) {
        const [cachedOnly, histOnly, prevOnly] = await Promise.all([redis.get(liveKey), redis.get(histKey), redis.get(prevKey)]);
        results[name] = { total: cachedOnly?.total || 0, history: histOnly || [], prev: prevOnly ? { total: prevOnly.total, date: prevOnly.date } : null };
        continue;
      }

      const [cached, prev, hist] = await Promise.all([
        redis.get(liveKey),
        redis.get(prevKey),
        redis.get(histKey),
      ]);

      const history   = hist || [];
      // Fix mislabeled latest entry: if the gap between the last two entries
      // is more than 1 day, the last entry was likely mislabeled by a previous
      // bug. Relabel it to addDaysToLabel(secondLast, 1) which is the correct
      // first new streaming day after the gap started.
      if (history.length >= 2) {
        const last       = history[history.length - 1];
        const secondLast = history[history.length - 2];
        const expected   = addDaysToLabel(secondLast.date, 1);
        if (last.date !== expected && daysBetween(secondLast.date, last.date) > 1) {
          last.date = expected;
          await redis.set(histKey, history);
        }
      }
      const cacheAge  = cached?.ts ? Date.now() - cached.ts : Infinity;
      // Skip cache if we haven't recorded today's history entry yet, even if the
      // live total is recent — otherwise a fetch that straddles midnight stays
      // cached across the day boundary and the daily diff never gets written.
      const needsDailyUpdate = !prev || prev.date !== todayLabel;
      const cacheValid = !isCron && !isForced && cacheAge < getCacheTtlMs(needsDailyUpdate) && (cached?.total || 0) > 0;
      let total;
      let updatedAt = cached?.ts || null;
      let stale = false;

      if (cacheValid) {
        total = cached.total;
      } else {
        let data;
        try {
          data = await fetchTrackMetadata(trackId);
        } catch(e) {
          errors[name] = { message: e.message, ts: new Date().toISOString() };
          await redis.set(errKey, { message: e.message, ts: Date.now() });
          data = {};
        }
        const fetchedTotal = data?.playCount || 0;
        fetchedLive = true;
        if (fetchedTotal > 0) {
          total = fetchedTotal;
          updatedAt = Date.now();
          await redis.set(liveKey, { total, ts: updatedAt });
          await redis.del(errKey);
        } else {
          // Live fetch failed (e.g. all RapidAPI keys exhausted) — fall back to
          // the last known-good cached total instead of showing 0.
          total = cached?.total || 0;
          stale = total > 0;
        }

        const prevTotal = Number(prev?.total || 0);

        if (total > 0 && prevTotal > 0 && total > prevTotal) {
          const gap = daysBetween(prev.date, todayLabel);

          if (gap >= 1) {
            // gap=1: prev.date IS the streaming day (snapshot was yesterday, streams are for that day)
            // gap>1: Spotify skipped days, label as the day after the last snapshot
            const yLabel = gap === 1 ? prev.date : addDaysToLabel(prev.date, 1);
            const dailyStreams = total - prevTotal;
            const existing = history.find(h => h.date === yLabel);
            if (!existing) {
              const entry = { date: yLabel, streams: dailyStreams };
              if (gap > 1) entry.note = `${gap}-day gap`;
              history.push(entry);
            } else {
              existing.streams = dailyStreams;
            }
            if (history.length > 60) history.shift();
            await redis.set(histKey, history);
          }

          await redis.set(prevKey, { total, date: todayLabel });
        }

        if (total > 0 && !prev) {
          await redis.set(prevKey, { total, date: todayLabel });
        }
      }

      results[name] = {
        total,
        history,
        prev: prev ? { total: prev.total, date: prev.date } : null,
        ...(stale ? { stale: true, updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null } : {}),
      };
    } catch (e) {
      console.error(`streams: ${name}:`, e.message);
      const fallback = await redis.get(`bp_live_${name}`);
      const history  = await redis.get(`bp_hist_${name}`);
      results[name] = {
        total: fallback?.total || 0,
        history: history || [],
        ...(fallback?.total ? { stale: true, updatedAt: fallback?.ts ? new Date(fallback.ts).toISOString() : null } : {}),
      };
    } finally {
      if (gotLock) await redis.del(lockKey);
    }
  }

  const prevSnaps = {};
  for (const name of Object.keys(TRACKS)) {
    prevSnaps[name] = await redis.get(`bp_prev_${name}`);
    if (!errors[name]) {
      const lastErr = await redis.get(`bp_err_${name}`);
      if (lastErr) errors[name] = { message: lastErr.message, ts: new Date(lastErr.ts).toISOString() };
    }
  }

  const keyCounts = {};
  for (const provider of PROVIDERS) {
    keyCounts[provider.name] = getApiKeys(provider.keyEnvVars).length;
  }

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  res.status(200).json({
    ...results,
    _debug: { keyCounts, errors, live: fetchedLive, prev: prevSnaps, ts: new Date().toISOString() },
  });
}
