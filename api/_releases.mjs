// Release moments for the videos tracked on /vs.html — the single source of truth.
//
// .mjs, not .js, and that matters: package.json has no "type": "module", so Node
// loads a .js sibling as CommonJS and `export const` is a syntax error there.
// Vercel special-cases the route file itself, so youtube-history.js can use ESM,
// but an imported .js sibling is resolved by Node — which threw on every request
// and took the whole read endpoint to a 500. .mjs is always ESM.
//
// This lived as three separate copies: youtube-history.js, youtube-stats.js and
// vs.html. They drifted the moment the MVs were registered, twice over. vs.html
// lost its countdowns and 24h lines (fixed by serving `releases` on the read
// response), and youtube-stats.js — which stamps a milestone the instant it is
// crossed — silently wrote `since: null` for anything it hadn't heard of. Those
// records are written with HSETNX, so a null stamped by the live path could
// never be corrected by the history path afterwards.
//
// Same clock times as the /countdowns cards: LISA 02:00 Rome (00:00 UTC),
// JISOO 06:00 Rome (04:00 UTC).
export const RELEASE = {
  'LzgE8ift2Uw': '2026-09-02T04:00:00Z', // JISOO teaser — 06:00 Rome Sep 2 → 24h mark Sep 3, 06:00
  'h-7_04c_hVc': '2026-09-02T00:00:00Z', // LISA teaser  — 02:00 Rome Sep 2 → 24h mark Sep 3, 02:00
  'FyS5dAywkEo': '2026-09-04T00:00:00Z', // LISA MV      — 02:00 Rome Sep 4 → 24h mark Sep 5, 02:00
  'sf02ugzPFE4': '2026-09-04T04:00:00Z', // JISOO MV     — 06:00 Rome Sep 4 → 24h mark Sep 5, 06:00
};

export const DAY_MS = 24 * 60 * 60 * 1000;
export const releaseMs = id => (RELEASE[id] ? Date.parse(RELEASE[id]) : null);
export const markOf = id => (RELEASE[id] ? Date.parse(RELEASE[id]) + DAY_MS : null);
