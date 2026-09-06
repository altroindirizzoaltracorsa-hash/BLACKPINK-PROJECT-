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

// The published rankings this page is anchored to, kept verbatim and keyed by
// the STREAMING DAY each list describes — not the day it was posted, and not the
// day we happened to read it. Storing the source rather than a derived constant
// means a baseline can always be recomputed, audited, or corrected later.
//
// Add a day here as you get one. Nothing else needs changing: baselineFor()
// picks it up on the next read.
const REFERENCE_YTD = {
  // BLACKPINK only, from our own "Streams gained in 2026" board
  // (/api/proxy-image?year_gained=list), which reports to the exact stream rather
  // than rounded to a million — so once a 2026-09-04 point is stored this seeds
  // BLACKPINK with no error budget at all, superseding the Sep 3 entry below.
  //
  // Usable because it is the same quantity kworb reports, which was checked
  // rather than assumed: the board's total of 17,748,512,294 on 2026-09-04 minus
  // its own daily of 4,628,711 is 17,743,883,583 — kworb's 2026-09-03 total to
  // the digit. Had the two scopes differed, seeding a kworb-derived series from
  // this would have baked the difference in permanently.
  '2026-09-04': {
    '41MozSoPIsD1dJM0CLPjZF': 1406786129, // BLACKPINK
  },
  // "Most Streamed K-pop Girl Groups in 2026 on Spotify so far (as of Sep. 3)".
  // Figures rounded to ~1M in the source, which is the whole error budget.
  '2026-09-03': {
    '41MozSoPIsD1dJM0CLPjZF': 1402000000, // BLACKPINK
    '7n2Ycct7Beij7Dj7meI4X0': 1270000000, // TWICE
    '4SpbR6yFEvexJuaBpgAU5p': 1269000000, // LE SSERAFIM
    '36cgvBn0aadzOijnjjwqMN': 1231000000, // ILLIT
    '6YVMFz59CuY7ngCxTxjpxE':  934260000, // aespa
    '6HvZYsbFfjnjFrWF950C9d':  929270000, // NewJeans
    '1SIocsqdEefUTE6XKGUiVS':  778180000, // BABYMONSTER
  },
};

// Fallback only, and deliberately labelled as approximate. These were seeded by
// pairing each group's kworb total with the Sep 3 list WITHOUT checking that the
// group's page was actually reporting Sep 3 — NewJeans was a day behind, so its
// constant is one day of streams too low and its YTD reads ~3.7M high. A group
// keeps using its constant only until a stored point lines up with a reference
// day, at which point baselineFor() computes the exact figure and this is
// ignored. Nothing here is ever silently trusted: `exact` says which was used.
const BASELINE_2026 = {
  '41MozSoPIsD1dJM0CLPjZF': 16341883583, // BLACKPINK
  '7n2Ycct7Beij7Dj7meI4X0': 11656636861, // TWICE
  '6HvZYsbFfjnjFrWF950C9d':  7146590959, // NewJeans   ← approximate, see above
  '4SpbR6yFEvexJuaBpgAU5p':  5292667823, // LE SSERAFIM
  '6YVMFz59CuY7ngCxTxjpxE':  4876154818, // aespa
  '36cgvBn0aadzOijnjjwqMN':  1752208418, // ILLIT
  '1SIocsqdEefUTE6XKGUiVS':  1596689721, // BABYMONSTER
};

// A baseline is only exact when a stored total and a published figure describe
// the SAME streaming day. Pair them that way and the arithmetic is airtight;
// pair them across days and the gap is silently baked in forever. So this looks
// for a day we have both for, newest first, and falls back to the approximate
// constant otherwise — self-correcting, because a lagging group seeds itself the
// moment its page catches up to a day we hold a reference for.
function baselineFor(id, series) {
  for (const day of Object.keys(REFERENCE_YTD).sort().reverse()) {
    const ytd = REFERENCE_YTD[day][id];
    const point = series.find(p => p.d === day);
    if (ytd != null && point) return { baseline: point.v - ytd, seededOn: day, exact: true };
  }
  const b = BASELINE_2026[id];
  return { baseline: b ?? null, seededOn: null, exact: false };
}

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
      const { baseline: base, seededOn, exact } = baselineFor(g.id, series);
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
        baseline: base, seededOn, exact,
        series: series.map(p => ({ d: p.d, v: p.v, dv: p.dv, ytd: base != null ? p.v - base : null })),
      };
    }).sort((a, b) => (b.ytd ?? -1) - (a.ytd ?? -1));

    // Gap to the group above, so the page can show the race rather than a list.
    groups.forEach((g, i) => { g.gapToAbove = i === 0 || g.ytd == null ? null : groups[i - 1].ytd - g.ytd; });

    const days = groups.map(g => g.day).filter(Boolean).sort();
    return res.status(200).json({
      asOf: days[days.length - 1] || null,
      note: 'Year-to-date is derived: kworb running total minus a 1 Jan baseline, seeded per group against a published list for the same streaming day. Dates are kworb streaming days.',
      groups,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
