/**
 * Fetches REAL per-country Spotify chart positions (not our own tracked-catalog
 * streams-gained ranking) for BLACKPINK + members, from kworb.net's daily AND
 * weekly Top 200 mirrors per country -- the same underlying source real chart
 * trackers like jenniecharts.com/b-cd.app ultimately rely on, just run
 * ourselves instead of depending on a third party's private backend.
 *
 * Row/rank movement (previous_position, position_change, entry_status) is
 * computed from OUR OWN stored history (scoped per chart_type), not parsed
 * from kworb's own delta column, so it stays consistent regardless of any
 * gaps in our fetch history.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const TRACKED_ARTISTS = {
  '41MozSoPIsD1dJM0CLPjZF': 'BLACKPINK',
  '6UZ0ba50XreR4TM8u322gs': 'JISOO',
  '250b0Wlc5Vk0CoUsaCY84M': 'JENNIE',
  '3eVa5w3URK5duf6eyVDbu9': 'ROSÉ',
  '5L1lO4eRHmJ7a0Q6csE5cT': 'LISA',
};

const REGIONS = ['global', 'us', 'gb', 'kr', 'fr', 'de', 'br', 'mx', 'jp', 'au', 'ca'];

// Daily pages: Pos | P+ | Artist/Title | Days | Pk | (x?) | Streams | Streams+ | 7Day | 7Day+ | Total  (11 cells)
// Weekly pages: Pos | P+ | Artist/Title | Wks  | Pk | (x?) | Streams | Streams+ | Total              (9 cells)
// "days_on_chart" holds Days for daily rows and Wks (weeks on chart) for weekly rows -- different units,
// the API/frontend should show the right label based on chart_type.
const CHART_TYPES = {
  daily: { suffix: 'daily', cellCount: 11, idx: { pos: 0, title: 2, onChart: 3, peak: 4, streams: 6, streamsChange: 7, total: 10 } },
  weekly: { suffix: 'weekly', cellCount: 9, idx: { pos: 0, title: 2, onChart: 3, peak: 4, streams: 6, streamsChange: 7, total: 8 } },
};

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status} ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

function parseNumber(text) {
  if (text == null) return null;
  const cleaned = text.replace(/[,+]/g, '').trim();
  if (cleaned === '' || cleaned === '=' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseRows(html, chartType) {
  const { cellCount, idx } = CHART_TYPES[chartType];
  const rows = [];
  const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(html))) {
    const rowHtml = m[1];
    if (rowHtml.includes('<th')) continue; // header row

    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    const cells = [];
    let cm;
    while ((cm = cellRe.exec(rowHtml))) cells.push(cm[1]);
    if (cells.length < cellCount) continue;

    const position = parseNumber(cells[idx.pos].replace(/<[^>]+>/g, ''));
    if (position == null) continue;

    const titleCell = cells[idx.title];
    const artistLinkRe = /<a href="\.\.\/artist\/([A-Za-z0-9]+)\.html">([^<]+)<\/a>/g;
    const trackLinkRe = /<a href="\.\.\/track\/([A-Za-z0-9]+)\.html">([^<]+)<\/a>/;

    const artistMatches = [...titleCell.matchAll(artistLinkRe)].map(am => ({ id: am[1], name: am[2] }));
    const trackMatch = titleCell.match(trackLinkRe);
    if (!trackMatch || !artistMatches.length) continue;

    const matchedTracked = artistMatches.find(a => TRACKED_ARTISTS[a.id]);
    if (!matchedTracked) continue;

    rows.push({
      spotify_track_id: trackMatch[1],
      track_name: trackMatch[2],
      primary_artist_id: matchedTracked.id,
      primary_artist_name: TRACKED_ARTISTS[matchedTracked.id],
      featured_artists: artistMatches.filter(a => a.id !== matchedTracked.id).map(a => a.name),
      position,
      peak_position: parseNumber(cells[idx.peak].replace(/<[^>]+>/g, '')),
      days_on_chart: parseNumber(cells[idx.onChart].replace(/<[^>]+>/g, '')),
      streams: parseNumber(cells[idx.streams].replace(/<[^>]+>/g, '')),
      streams_change: parseNumber(cells[idx.streamsChange].replace(/<[^>]+>/g, '')),
      total_streams: parseNumber(cells[idx.total].replace(/<[^>]+>/g, '')),
    });
  }
  return rows;
}

async function fetchRegion(region, chartType) {
  const url = `https://kworb.net/spotify/country/${region}_${CHART_TYPES[chartType].suffix}.html`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
  if (!r.ok) { console.log(`[${chartType}] ${region}: HTTP ${r.status}, skipping`); return []; }
  const html = await r.text();
  const rows = parseRows(html, chartType).map(row => ({ ...row, country: region.toUpperCase(), chart_type: chartType }));
  console.log(`[${chartType}] ${region}: ${rows.length} BLACKPINK/member row(s) found`);
  return rows;
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set'); process.exit(1); }

  const today = new Date().toISOString().slice(0, 10);

  let allRows = [];
  for (const chartType of Object.keys(CHART_TYPES)) {
    for (const region of REGIONS) {
      allRows = allRows.concat(await fetchRegion(region, chartType));
    }
  }
  console.log(`\nTotal matched rows across ${REGIONS.length} regions x ${Object.keys(CHART_TYPES).length} chart types: ${allRows.length}`);
  if (!allRows.length) { console.log('Nothing to upsert.'); return; }

  // Pull our FULL prior history per (track, country, chart_type) -- not just the most
  // recent row -- so we can tell a true chart debut (NEW, never seen before) apart from
  // a RE-ENTRY (charted before, absent from our most recent prior fetch, now back).
  const trackIds = [...new Set(allRows.map(r => r.spotify_track_id))];
  const countries = [...new Set(allRows.map(r => r.country))];
  const priorRows = await sb(
    `/chart_positions?spotify_track_id=in.(${trackIds.join(',')})&country=in.(${countries.join(',')})&tracking_date=lt.${today}&select=spotify_track_id,country,chart_type,position,tracking_date&order=tracking_date.desc`
  );
  const priorByKey = {};
  for (const r of priorRows) {
    const key = `${r.spotify_track_id}::${r.country}::${r.chart_type}`;
    if (!(key in priorByKey)) priorByKey[key] = r; // first (most recent) wins
  }
  // Date of our own most recent prior fetch run, per (country, chart_type) -- the
  // "was this track present last time we checked" reference point, independent of
  // whether our cron actually ran on a strictly daily/weekly cadence.
  const lastRunDateByGroup = {};
  for (const r of priorRows) {
    const groupKey = `${r.country}::${r.chart_type}`;
    if (!lastRunDateByGroup[groupKey] || r.tracking_date > lastRunDateByGroup[groupKey]) {
      lastRunDateByGroup[groupKey] = r.tracking_date;
    }
  }

  const upsertRows = allRows.map(row => {
    const key = `${row.spotify_track_id}::${row.country}::${row.chart_type}`;
    const prior = priorByKey[key];
    const lastRunDate = lastRunDateByGroup[`${row.country}::${row.chart_type}`];

    let previous_position = null;
    let position_change = null;
    let entry_status;
    if (!prior) {
      entry_status = 'NEW'; // never charted before, in our records
    } else if (prior.tracking_date === lastRunDate) {
      // Present in our most recent prior fetch too -- continuing streak, show movement.
      previous_position = prior.position;
      position_change = previous_position - row.position;
      entry_status = position_change > 0 ? 'MOVED_UP' : position_change < 0 ? 'MOVED_DOWN' : 'NO_CHANGE';
    } else {
      // Charted before, but was missing from our most recent prior fetch -- came back.
      entry_status = 'RE-ENTRY';
    }
    return { ...row, tracking_date: today, previous_position, position_change, entry_status };
  });

  await sb('/chart_positions?on_conflict=spotify_track_id,country,tracking_date,chart_type', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(upsertRows),
  });

  console.log(`\nUpserted ${upsertRows.length} rows for ${today}.`);
  for (const row of upsertRows) {
    const posMove = row.position_change ? ' ' + (row.position_change > 0 ? '+' : '') + row.position_change : '';
    const streamsMove = row.streams_change != null ? ` streams ${row.streams_change > 0 ? '+' : ''}${row.streams_change.toLocaleString()}` : '';
    console.log(`  [${row.chart_type}/${row.country}] #${row.position} (${row.entry_status}${posMove}${streamsMove}) ${row.primary_artist_name} - ${row.track_name}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
