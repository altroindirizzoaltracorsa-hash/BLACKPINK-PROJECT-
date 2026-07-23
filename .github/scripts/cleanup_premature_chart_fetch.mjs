/**
 * One-off cleanup: deletes chart_positions rows mistakenly stamped with
 * today's date by a manual fetch run before Spotify's ~22:00 UTC daily
 * publish window -- the underlying kworb content was still yesterday's,
 * so those rows are duplicates mislabeled with the wrong date.
 */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DATE_TO_DELETE = process.argv[2];

if (!DATE_TO_DELETE || !/^\d{4}-\d{2}-\d{2}$/.test(DATE_TO_DELETE)) {
  console.error('Usage: node cleanup_premature_chart_fetch.mjs YYYY-MM-DD');
  process.exit(1);
}

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status} ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

const deleted = await sb(`/chart_positions?tracking_date=eq.${DATE_TO_DELETE}`, { method: 'DELETE' });
console.log(`Deleted ${deleted?.length ?? 0} chart_positions rows for ${DATE_TO_DELETE}.`);
