// /api/girlgroups
//
//   (no params)                                   → read the stored series + derived YTD
//   ?snapshot=1  (x-admin-secret / ?key= / Bearer CRON_SECRET) → capture today's totals
//
// "Most streamed K-pop girl groups this year". No source publishes a
// year-to-date figure, so it is derived:  YTD = total today − total on 1 Jan.
// kworb publishes the running total per artist; the 1 Jan baselines below were
// seeded once from a published Sep 3 ranking (see BASELINE_2026).
//
// THE DATE IS THE SOURCE'S, NOT OURS. kworb's "Last updated: YYYY/MM/DD" label
// runs one day ahead of the streaming day it describes — a page reading
// 2026/09/04 is reporting streams from 3 September. Every point is therefore
// filed under the streaming day derived from that label, never under our fetch
// time, so the job may run at any hour, twice, or not at all and each total
// still lands on the right day. kworb also skips days; because we store the
// running TOTAL rather than accumulating daily deltas, a skipped day costs a
// day of granularity and can never corrupt the year-to-date figure.
//
// Env: UPSTASH_REDIS_REST_URL / _TOKEN, and one of ADMIN_SECRET / CRON_SECRET.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Spotify artist ids, each confirmed against the page's own <title> rather than
// trusted from a pasted list — one of the ids originally supplied for this set
// turned out to be BABYMETAL, not BABYMONSTER.
const GROUPS = [
  { id: '41MozSoPIsD1dJM0CLPjZF', name: 'BLACKPINK'   },
  { id: '7n2Ycct7Beij7Dj7meI4X0', name: 'TWICE'       },
  { id: '6HvZYsbFfjnjFrWF950C9d', name: 'NewJeans'    },
  { id: '4SpbR6yFEvexJuaBpgAU5p', name: 'LE SSERAFIM' },
  { id: '6YVMFz59CuY7ngCxTxjpxE', name: 'aespa'       },
  { id: '36cgvBn0aadzOijnjjwqMN', name: 'ILLIT'       },
  { id: '1SIocsqdEefUTE6XKGUiVS', name: 'BABYMONSTER' },
];

// Total streams as of 31 Dec 2025, so that (today − baseline) is this year's.
// Seeded from kworb's totals for the streaming day of 2026-09-03 minus a
// published ranking for that same day. The published figures were rounded to
// ~1M, so each baseline carries up to ±500k of FIXED error: it never grows, and
// it applies to every group alike, so gaps and ordering stay exact. Re-seed from
// a full-precision source and even that goes away — SEED_DAY records what these
// were derived against.
const SEED_DAY = '2026-09-03';
const BASELINE_2026 = {
  '41MozSoPIsD1dJM0CLPjZF': 16341883583, // BLACKPINK    17,743,883,583 − 1.402B
  '7n2Ycct7Beij7Dj7meI4X0': 11656636861, // TWICE        12,926,636,861 − 1.270B
  '6HvZYsbFfjnjFrWF950C9d':  7146590959, // NewJeans      8,075,860,959 − 929.27M
  '4SpbR6yFEvexJuaBpgAU5p':  5292667823, // LE SSERAFIM   6,561,667,823 − 1.269B
  '6YVMFz59CuY7ngCxTxjpxE':  4876154818, // aespa         5,810,414,818 − 934.26M
  '36cgvBn0aadzOijnjjwqMN':  1752208418, // ILLIT         2,983,208,418 − 1.231B
  '1SIocsqdEefUTE6XKGUiVS':  1596689721, // BABYMONSTER   2,374,869,721 − 778.18M
};

const key = id => `bu_gg_hist_${id}`;
const MAX_POINTS = 800;               // >2 years of daily points
const DAY_MS = 86400000;

async function upstash(cmds) {
  const r = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  return await r.json();
}

const num = s => (s == null ? null : Number(String(s).replace(/[,\s]/g, '')) || null);
const iso = d => new Date(d).toISOString().slice(0, 10);

// kworb's label minus one day — see the note at the top of this file.
function streamingDayFrom(label) {
  const m = /(\d{4})\/(\d{2})\/(\d{2})/.exec(label || '');
  if (!m) return null;
  return iso(Date.UTC(+m[1], +m[2] - 1, +m[3]) - DAY_MS);
}

// The summary block at the top of a kworb _songs.html page:
//            Total       As lead     Solo        As feature
//   Streams  3,587,974,148  …
//   Daily    1,506,883      …
//   Tracks   65             …
// "Total" is the column the published rankings count, so it is the one used.
function parseKworb(html) {
  const strip = s => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(m => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => strip(c[1])));
  const pick = label => {
    const r = rows.find(c => c.length > 1 && c[0].toLowerCase() === label);
    return r ? num(r[1]) : null;
  };
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html);
  return {
    name: title ? strip(title[1]).replace(/\s*-\s*Spotify Top Songs\s*$/i, '') : null,
    total: pick('streams'),
    daily: pick('daily'),
    tracks: pick('tracks'),
    day: streamingDayFrom((/Last updated:\s*([\d/]+)/i.exec(html) || [])[1]),
  };
}

async function fetchGroup(id) {
  const r = await fetch(`https://kworb.net/spotify/artist/${id}_songs.html`,
    { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
  if (!r.ok) throw new Error(`kworb ${r.status}`);
  return parseKworb(await r.text());
}

// Both paths are admin-only: this is an internal working view, so a reader that
// simply knows the URL is not enough. The page sends the key as a header rather
// than ?key= so the secret stays out of URLs, referrers and access logs; ?key=
// and Bearer CRON_SECRET still work for jobs.
const authed = req => {
  const cronSecret = process.env.CRON_SECRET, adminSecret = process.env.ADMIN_SECRET;
  const given = req.headers['x-admin-secret'] || req.query.key;
  return (cronSecret && req.headers.authorization === `Bearer ${cronSecret}`)
      || (adminSecret && given === adminSecret);
};

const parseList = arr => (arr || []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);

export default async function handler(req, res) {

  if (req.query.snapshot) {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });

    const written = [], held = [], errors = [];
    for (const g of GROUPS) {
      try {
        const s = await fetchGroup(g.id);
        if (!s.total || !s.day) { errors.push(`${g.name}: no total/day parsed`); continue; }
        // The name is read back from the page every time, so an id that starts
        // pointing at a different artist is caught rather than silently charted.
        if (s.name && s.name.toLowerCase() !== g.name.toLowerCase()) {
          errors.push(`${g.name}: page says "${s.name}" — id may be wrong, skipped`);
          continue;
        }
        const last = parseList((await upstash([['LRANGE', key(g.id), '-1', '-1']]))[0]?.result);
        // One point per streaming day. kworb not having advanced is a hold, not
        // a flat day — re-running the job can never double-count or overwrite.
        if (last[0] && last[0].d >= s.day) { held.push(g.name); continue; }
        const point = JSON.stringify({ d: s.day, v: s.total, dv: s.daily, t: s.tracks, ts: Date.now() });
        await upstash([['RPUSH', key(g.id), point], ['LTRIM', key(g.id), String(-MAX_POINTS), '-1']]);
        written.push(g.name);
      } catch (e) { errors.push(`${g.name}: ${e.message}`); }
    }
    return res.status(200).json({ ok: true, written, held, errors });
  }

  // ── read (admin only) ───────────────────────────────────────────────────
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const results = await upstash(GROUPS.map(g => ['LRANGE', key(g.id), '0', '-1']));
    const groups = GROUPS.map((g, i) => {
      const series = parseList(results[i]?.result);
      const last = series[series.length - 1] || null;
      const prev = series.length > 1 ? series[series.length - 2] : null;
      const base = BASELINE_2026[g.id] ?? null;
      // Gain since the previous stored day, and how many days that spans —
      // kworb skips days, so "+9.1M over 2 days" beats a wrong daily figure.
      const gain = last && prev ? last.v - prev.v : null;
      const spanDays = last && prev
        ? Math.max(1, Math.round((Date.parse(last.d) - Date.parse(prev.d)) / DAY_MS)) : null;
      return {
        id: g.id, name: g.name,
        day: last?.d ?? null,
        total: last?.v ?? null,
        ytd: last && base != null ? last.v - base : null,
        daily: last?.dv ?? null,      // kworb's own figure for that day
        gain, spanDays,               // and what our own series says it moved
        tracks: last?.t ?? null,
        baseline: base,
        series: series.map(p => ({ d: p.d, v: p.v, dv: p.dv, ytd: base != null ? p.v - base : null })),
      };
    }).sort((a, b) => (b.ytd ?? -1) - (a.ytd ?? -1));

    // Gap to the group above, so the page can show the race rather than a list.
    groups.forEach((g, i) => { g.gapToAbove = i === 0 || g.ytd == null ? null : groups[i - 1].ytd - g.ytd; });

    const days = groups.map(g => g.day).filter(Boolean).sort();
    return res.status(200).json({
      asOf: days[days.length - 1] || null,
      seedDay: SEED_DAY,
      note: 'Year-to-date is derived: kworb running total minus a 1 Jan baseline. Dates are kworb streaming days.',
      groups,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
