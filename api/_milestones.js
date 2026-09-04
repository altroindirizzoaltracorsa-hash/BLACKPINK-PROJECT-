// View thresholds we timestamp, and how crossings are stored.
//
// A threshold can be crossed more than ONCE. YouTube recounts continuously and
// can take the total back below a milestone, after which it is crossed again.
// Every crossing is kept: a later one never replaces an earlier one, they sit
// side by side, so the record shows both when it was first reached and when it
// settled back above. Nothing here overwrites anything.
//
// Storage is one hash per video, bu_yt_ms_<id>:
//   "1000000"          the first crossing — also the shape older records used,
//                      so history written before this still reads correctly
//   "1000000@<hour>"   one field per crossing, bucketed by the hour it fell in
//
// Every write is HSETNX, so a crossing is written once and re-deriving it on a
// later read can neither duplicate nor restate it. The hour bucket is what makes
// that idempotent: the interpolated crossing time can shift slightly when the
// fine live series is trimmed and a coarser pair of samples takes over, and
// bucketing absorbs that instead of inventing a second crossing from it.
export const VIEW_MILESTONES = [
  1e6, 2e6, 3e6, 4e6, 5e6, 10e6, 20e6, 25e6, 30e6, 40e6, 50e6, 75e6,
  100e6, 150e6, 200e6, 250e6, 300e6, 400e6, 500e6, 750e6, 1e9,
];

const HOUR = 3600000;
export const bucketOf = t => Math.floor(t / HOUR);
export const crossingField = (th, t) => `${th}@${bucketOf(t)}`;

// { field: record } → { threshold: [record, …] }, oldest crossing first.
// Two records in the same hour bucket are the same crossing, so the later write
// simply lands on the same slot rather than appearing twice.
export function groupCrossings(hash) {
  const byTh = {};
  for (const [field, rec] of Object.entries(hash || {})) {
    if (!rec || rec.t == null) continue;
    const th = String(field).split('@')[0];
    (byTh[th] = byTh[th] || new Map()).set(bucketOf(rec.t), rec);
  }
  const out = {};
  for (const th of Object.keys(byTh)) out[th] = [...byTh[th].values()].sort((a, b) => a.t - b.t);
  return out;
}

// Union of what's frozen and what we just recomputed. Frozen wins its bucket —
// a stored crossing is never restated — but it no longer hides the others.
export function mergeCrossings(stored, derived) {
  const out = {};
  for (const th of new Set([...Object.keys(stored || {}), ...Object.keys(derived || {})])) {
    const m = new Map();
    for (const c of (derived?.[th] || [])) m.set(bucketOf(c.t), c);
    for (const c of (stored?.[th] || [])) m.set(bucketOf(c.t), c);
    out[th] = [...m.values()].sort((a, b) => a.t - b.t);
  }
  return out;
}
