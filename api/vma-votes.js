// VMA voting leaderboard — account-gated, self-reported vote counts.
//
//   GET  /api/vma-votes              → community totals { total, today, lisaTotal, bpTotal, lisaToday, bpToday, blinksTotal, blinksToday }
//   GET  /api/vma-votes?board=1      → { board: [{ name, total/today/week/month, lisa_*, bp_*, streams }, ...] }
//   GET  /api/vma-votes?me=1         → caller's status (Authorization: Bearer <token>)
//   GET  /api/vma-votes?live=1       → { liveVoters } — distinct accounts that logged a
//                                       vote in the last 90s (the "blinks voting now" pulse)
//   GET  /api/vma-votes?sync=1       → { bp, lisa, total, accounts } — this account's
//                                       cross-device merged view (X-Ext-Token header; opt-in)
//   POST /api/vma-votes { accessToken, bp, lisa } → add the LISA/BP split to today
//        (votes total = bp + lisa). Legacy { accessToken, votes } still accepted (unattributed).
//        extra (extension, sync mode): { extToken, votes, sync, breakdown:{BLACKPINK,LISA}, account:{id,method} }
//
// Three awards share this endpoint, each with its own table and its own RPCs,
// selected with ?award= on a GET or {award} on a POST. Omitted = the VMAs.
//
//   (none)      → vma_user_votes        · midnight ET  · BLACKPINK/LISA split
//   breaktudo   → breaktudo_user_votes  · midnight KST · per-category `cats`
//   kca         → kca_user_votes        · midnight KST · per-category `cats`
//
// They are deliberately separate dimensions rather than one table with an award
// column: these tables carry site-visible meaning, and widening them is how a
// wrong row ends up on a page.
//
// To submit you must be signed in. A linked scrobbler is OPTIONAL: streaming
// blinks get ranked on the board; vote-only blinks stay unranked and earn a
// "Voter" badge at 1000 votes/day (no stream = no rank).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY.  Schema: supabase/vma_user_votes.sql,
// supabase/migrations/kca_vote_board.sql + kca_vote_board_ranked.sql

import { createClient } from '@supabase/supabase-js';

function supabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// MTV's VMA voting day resets at MIDNIGHT ET, so we bucket votes by the US
// Eastern calendar date (not UTC). Intl handles EDT/EST automatically.
// en-CA formats as YYYY-MM-DD.
const etDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);

// ── VMA voting is over ──────────────────────────────────────────────────────
// MTV closed the ballot on 2026-09-25 at 6PM ET. The leaderboard stays up so
// blinks can look back at what they cast, but it stops TAKING votes at the end
// of the VMA voting day — midnight ET, the same boundary the day buckets roll
// on — so the last day finishes normally instead of being cut off mid-way.
//
// After this instant the board and every "my votes" read keep working; only the
// writes are refused. The vote counter extension will keep trying (it is
// installed on people's machines and cannot be recalled), which is exactly why
// this is enforced here and not only in the page.
//
// The page has the same constant — search VMA_CLOSES_AT in index.html. Change
// both together.
const VMA_CLOSES_AT = Date.parse('2026-09-26T04:00:00Z');
const vmaClosed = () => Date.now() >= VMA_CLOSES_AT;

// BreakTudo has no vote cap and no daily reset, so nothing on the award's side
// marks the end of a day. Its "today" bucket therefore rolls at MIDNIGHT KST —
// the clock this fandom counts days on — rather than at Brasília, which was the
// original choice and bought no alignment with anything. Display only: `votes`,
// all-time totals and the board's ranking are sums over every day and so do not
// depend on where the boundary falls.
//
// Must stay in lockstep with breaktudo_vote_totals() / breaktudo_vote_board() in
// Postgres (supabase/migrations/breaktudo_day_boundary_kst.sql) and with kstDay()
// in vote-extension/background.js. If these drift, the community bar and the
// ranked table disagree for the twelve hours a day the two clocks differ, and
// each number still looks plausible on its own.
//
// Asia/Seoul is a fixed UTC+9 with no DST, unlike the ET boundary on the VMA path.
// Kept fully separate from that path.
const kstDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);

// BreakTudo serves one category under several slug spellings, and this endpoint
// stores whatever slug the vote arrived under — so without folding, one category
// becomes two keys in `cats` and the board draws it as two chips. Canonical is the
// spelling the SITE serves ('clipe-internacional-do-ano'); probe-breaktudo.yml run
// 36260347844 found 'clipe-*' across every edition and never a 'videoclipe-*' URL.
//
// Normalising on WRITE stops the split growing; the page folds on read as well, so
// rows already stored under an alias still render correctly.
//
// Must stay in step with BT_CAT_ALIASES in index.html and with the spellings
// BT_CATS tolerates in vote-extension/background.js.
const BT_CAT_ALIASES = {
  'videoclipe-internacional-do-ano': 'clipe-internacional-do-ano',
  'videoclipe-internacional':        'clipe-internacional-do-ano',
  'clipe-internacional':             'clipe-internacional-do-ano',
  'serie-internacional-do-ano':      'serie-internacional',
};
const btCanonCat = (slug) => BT_CAT_ALIASES[slug] || slug;

// Where a blink's day-by-day history is allowed to start.
//
// The BreakTudo day bucket moved from Brasília to midnight KST when
// breaktudo_day_boundary_kst.sql was applied and this file deployed, at
// 2026-09-29 04:47–04:48 UTC. Rows older than that carry Brasília dates, and the
// two clocks differ by a day whenever UTC sits outside 03:00–15:00. Aggregated
// over a week or all time that is invisible; listed day by day it is a visible
// seam, and one that cannot be corrected — a row is votes MERGED across a day, so
// it has no per-vote timestamps to re-date from.
//
// A KST day runs 15:00→15:00 UTC, so the day containing the deploy (2026-09-29)
// is itself mixed: votes cast before 04:48 that day were stamped Brasília. The
// first day written entirely under the new rule is the one that began at
// 2026-09-29 15:00 UTC — 2026-09-30. So the history starts there and says so,
// rather than showing days whose boundary we cannot vouch for.
const BT_DAY_HISTORY_FROM = '2026-09-30';
const BT_DAY_HISTORY_MAX = 120;   // enough to page a calendar back through the campaign

// ── Kids' Choice Awards 2026 ────────────────────────────────────────────────
// A third award dimension: its own table (kca_user_votes) and its own two RPCs,
// for the same reason the BreakTudo tables are separate from the VMA ones — a
// KCA vote shares nothing with the others but its shape, and widening a table
// that carries site-visible meaning is how a wrong row ends up on a page.
//
// WHAT A VOTE IS HERE. The KCA ballot does not submit per category: one round
// carries up to one pick per category and is sent at the end. So `votes` counts
// per-category picks for OUR nominees — a round in which a blink picked
// BLACKPINK, ROSÉ and Dracula is 3, not 1 — and `cats` breaks that down by
// category slug, exactly as on the BreakTudo side. See the header of
// supabase/migrations/kca_vote_board.sql.
//
// DAY BOUNDARY: midnight KST, from the first row. KCA's own rules say closing
// times "may differ by region", so there is no externally-imposed instant to
// align to, and this is the clock the fandom counts days on. The table's `day`
// default and both RPCs are on Asia/Seoul too, so kstDay() is shared with the
// BreakTudo path deliberately rather than copied.
//
// NO SERVER-SIDE CLOSE GATE, unlike the VMA path. The VMAs had a published
// closing instant (6PM ET, Sep 25) and refusing writes after it was the only way
// to stop installed extensions logging into a finished ballot. KCA publishes a
// closing DAY (Nov 13) and says outright that times vary by region, so any
// instant picked here would be a guess — and of the two ways to be wrong,
// refusing a vote a blink really cast is the one that costs something. The card
// on /voting carries the date; this endpoint keeps taking what it is given.
const KCA_DAY_HISTORY_FROM = '2026-10-08';   // the first day of the voting period
const KCA_DAY_HISTORY_MAX = 120;

// The three categories BLACKPINK / members are nominated in, keyed by the
// /vote/<slug> the live site serves (confirmed in probe-kca.yml). Only used to
// LABEL and to sanity-check; an unknown slug is still stored and still counts,
// because Nickelodeon runs extra "Bonus" and "Live" categories during the show
// and a whitelist here would silently drop their attribution.
//
// Must stay in step with KCA_CATEGORIES in index.html and KCA_NOMINEES in
// vote-extension/background.js.
const KCA_CATS = {
  'favorite-music-group-or-duo':  'BLACKPINK',
  'favorite-female-artist':       'ROSÉ',
  'favorite-music-collaboration': 'Dracula (with JENNIE)',
};

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

async function isLinked(sb, uid) {
  const { data } = await sb.from('linked_accounts').select('app_user_id').eq('app_user_id', uid).limit(1);
  return !!(data && data.length);
}

// Sum a user's rows into today / week (Mon-start) / month / all-time, in US
// Eastern (midnight-ET day boundary — matches the /vmas countdown).
async function myTotals(sb, uid) {
  const { data } = await sb.from('vma_user_votes').select('day, votes, bp, lisa').eq('app_user_id', uid);
  const rows = data || [];
  const t = etDay();                              // 'YYYY-MM-DD' — today in ET
  const [y, m, dd] = t.split('-').map(Number);
  // Treat the ET wall-clock date as a UTC date purely for weekday arithmetic.
  const base = new Date(Date.UTC(y, m - 1, dd));
  const dow = (base.getUTCDay() + 6) % 7;         // 0 = Monday
  const monday = new Date(Date.UTC(y, m - 1, dd - dow)).toISOString().slice(0, 10);
  const first = `${t.slice(0, 7)}-01`;
  let today = 0, week = 0, month = 0, total = 0;
  const bp = { today: 0, week: 0, month: 0, total: 0 };
  const lisa = { today: 0, week: 0, month: 0, total: 0 };
  for (const r of rows) {
    const v = r.votes || 0, b = r.bp || 0, l = r.lisa || 0;
    total += v; bp.total += b; lisa.total += l;
    if (r.day === t)     { today += v; bp.today += b; lisa.today += l; }
    if (r.day >= monday) { week  += v; bp.week  += b; lisa.week  += l; }
    if (r.day >= first)  { month += v; bp.month += b; lisa.month += l; }
  }
  return { today, week, month, total, bp, lisa };
}

// BreakTudo sibling of myTotals — single vote tally, midnight-KST day boundaries.
async function myBtTotals(sb, uid) {
  const { data } = await sb.from('breaktudo_user_votes').select('day, votes, cats').eq('app_user_id', uid);
  const rows = data || [];
  const t = kstDay();
  const [y, m, dd] = t.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, dd));
  const dow = (base.getUTCDay() + 6) % 7;           // 0 = Monday
  const monday = new Date(Date.UTC(y, m - 1, dd - dow)).toISOString().slice(0, 10);
  const first = `${t.slice(0, 7)}-01`;
  let today = 0, week = 0, month = 0, total = 0;
  // Per-category, all-time and today. `votes` stays authoritative for ranking —
  // these maps only ever explain PART of it, because rows written before the
  // category migration carry a total with cats = {}. Anything rendering them must
  // not present their sum as the whole.
  const cats = {}, catsToday = {};
  const add = (into, m) => {
    for (const k in (m || {})) {
      const n = Number(m[k]) || 0;
      // Fold aliases here too: rows written before the canonicalisation above
      // still carry the old spelling.
      if (n > 0) { const c = btCanonCat(k); into[c] = (into[c] || 0) + n; }
    }
  };
  for (const r of rows) {
    const v = r.votes || 0;
    total += v;
    add(cats, r.cats);
    if (r.day === t)     { today += v; add(catsToday, r.cats); }
    if (r.day >= monday) week  += v;
    if (r.day >= first)  month += v;
  }
  // Day by day, newest first — the same rows, just not collapsed. Only days on
  // the KST boundary (see BT_DAY_HISTORY_FROM); anything older is a different
  // clock and would read as a seam nobody can explain.
  const days = rows
    .filter(r => r.day >= BT_DAY_HISTORY_FROM && (r.votes || 0) > 0)
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    .slice(0, BT_DAY_HISTORY_MAX)
    .map(r => {
      const c = {};
      add(c, r.cats);
      return { day: r.day, votes: r.votes || 0, cats: c };
    });

  return { today, week, month, total, cats, catsToday, days, daysFrom: BT_DAY_HISTORY_FROM, todayKey: t };
}

// KCA sibling of myBtTotals. Same shape, same midnight-KST buckets, its own
// table — so the panel that renders one renders the other.
//
// No alias folding here, and none needed: BreakTudo serves one category under
// several slug spellings (which is why btCanonCat exists), while the KCA slugs
// come from a single site in a single spelling and were read off the live pages.
// If that ever stops being true the fix is a KCA_CAT_ALIASES map here and in
// index.html, not a loosening of the writes.
async function myKcaTotals(sb, uid) {
  const { data } = await sb.from('kca_user_votes').select('day, votes, cats').eq('app_user_id', uid);
  const rows = data || [];
  const t = kstDay();
  const [y, m, dd] = t.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, dd));
  const dow = (base.getUTCDay() + 6) % 7;           // 0 = Monday
  const monday = new Date(Date.UTC(y, m - 1, dd - dow)).toISOString().slice(0, 10);
  const first = `${t.slice(0, 7)}-01`;
  let today = 0, week = 0, month = 0, total = 0;
  const cats = {}, catsToday = {};
  const add = (into, src) => {
    for (const k in (src || {})) {
      const n = Number(src[k]) || 0;
      if (n > 0) into[k] = (into[k] || 0) + n;
    }
  };
  for (const r of rows) {
    const v = r.votes || 0;
    total += v;
    add(cats, r.cats);
    if (r.day === t)     { today += v; add(catsToday, r.cats); }
    if (r.day >= monday) week  += v;
    if (r.day >= first)  month += v;
  }
  // Day by day, newest first — the calendar the four period tabs cannot answer
  // ("week minus today" is yesterday only on a Tuesday). The KCA table was on
  // the KST boundary from its first row, so unlike BreakTudo there is no seam to
  // start the history after; KCA_DAY_HISTORY_FROM is simply the voting period's
  // first day, and a row older than that would be a bug worth not drawing.
  const days = rows
    .filter(r => r.day >= KCA_DAY_HISTORY_FROM && (r.votes || 0) > 0)
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    .slice(0, KCA_DAY_HISTORY_MAX)
    .map(r => { const c = {}; add(c, r.cats); return { day: r.day, votes: r.votes || 0, cats: c }; });

  return { today, week, month, total, cats, catsToday, days, daysFrom: KCA_DAY_HISTORY_FROM, todayKey: t };
}

// The caller's campaign streams: today's (ET-day aligned) for display + Monster
// Blink, and whether they've EVER streamed (the silent gate for ranking/badges —
// you can register votes without streaming, but you only rank if you've streamed).
async function myStreams(sb, uid) {
  const { data } = await sb.from('user_daily_counts')
    .select('day_key, jump, shutdown, ddududu, go').eq('app_user_id', uid);
  const rows = data || [];
  const t = etDay();
  let streams = 0;
  for (const r of rows) {
    if (r.day_key === t) streams += (r.jump || 0) + (r.shutdown || 0) + (r.ddududu || 0) + (r.go || 0);
  }
  // Ranked/badged only while actually streaming TODAY — not merely having linked
  // a scrobbler or streamed on some past day.
  return { streams, ranked: streams >= 1 };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Ext-Token');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sb = supabase();
  if (!sb) return res.status(503).json({ error: 'Voting not configured' });

  try {
    // ── BreakTudo Awards — fully isolated award dimension ────────────────────
    // Everything below reads/writes breaktudo_user_votes + its own RPCs; the VMA
    // path (default) is untouched. Selected with ?award=breaktudo (GET) or
    // {award:'breaktudo'} (POST). Single vote tally, midnight-KST day boundary.
    const award = String((req.method === 'POST' ? (req.body || {}).award : req.query.award) || '').toLowerCase();
    if (award === 'breaktudo') {
      if (req.method === 'GET') {
        if (req.query.board) {
          const { data, error } = await sb.rpc('breaktudo_vote_board');
          if (error) throw error;
          return res.status(200).json({ board: data || [] });
        }
        if (req.query.sync) {
          const extToken = String(req.headers['x-ext-token'] || '').trim();
          if (!extToken) return res.status(401).json({ error: 'link required' });
          const { data: tok } = await sb.from('scrobble_tokens').select('app_user_id').eq('token', extToken).maybeSingle();
          if (!tok) return res.status(401).json({ error: 'link required' });
          const { data: v } = await sb.from('breaktudo_user_votes').select('votes').eq('app_user_id', tok.app_user_id).eq('day', kstDay()).maybeSingle();
          return res.status(200).json({ total: v?.votes || 0, accounts: [] });
        }
        if (req.query.live) {
          const cutoff = new Date(Date.now() - 90 * 1000).toISOString();
          const { data, error } = await sb.from('breaktudo_user_votes').select('app_user_id').gte('updated_at', cutoff);
          if (error) throw error;
          return res.status(200).json({ liveVoters: data ? new Set(data.map((r) => r.app_user_id)).size : 0 });
        }
        if (req.query.me) {
          const token = bearer(req);
          if (!token) return res.status(401).json({ error: 'not signed in' });
          const { data: { user } = {}, error: authErr } = await sb.auth.getUser(token);
          if (authErr || !user) return res.status(401).json({ error: 'not signed in' });
          const [totals, streams] = await Promise.all([myBtTotals(sb, user.id), myStreams(sb, user.id)]);
          const linked = await isLinked(sb, user.id);
          return res.status(200).json({ linked, ...totals, ...streams });
        }
        const { data, error } = await sb.rpc('breaktudo_vote_totals');
        if (error) throw error;
        return res.status(200).json(data || { total: 0, today: 0, blinksTotal: 0, blinksToday: 0 });
      }
      if (req.method === 'POST') {
        const body = req.body || {};
        let votes = parseInt(body.votes, 10);
        if (!Number.isFinite(votes) || votes <= 0) return res.status(400).json({ error: 'votes required' });
        votes = Math.min(votes, 10000); // sanity bound (BreakTudo has no daily cap)

        // Per-category attribution. Either `category` (one slug — what the
        // extension sends, since one vote POST is one /vote/<slug>/ page) or
        // `cats` (a map — what the manual form sends when several are entered
        // at once). Unknown/absent is fine: the vote still counts toward the
        // total, it is simply unattributed, exactly like every row written
        // before the category migration.
        const SLUG_RE = /^[a-z0-9-]{1,64}$/;
        const addCats = {};
        if (body.cats && typeof body.cats === 'object' && !Array.isArray(body.cats)) {
          for (const k of Object.keys(body.cats)) {
            const n = parseInt(body.cats[k], 10);
            // += rather than =, because two alias spellings in one payload fold
            // onto the same canonical key and the second must not replace the first.
            if (SLUG_RE.test(k) && Number.isFinite(n) && n > 0) {
              const c = btCanonCat(k);
              addCats[c] = Math.min((addCats[c] || 0) + n, 10000);
            }
          }
        } else if (typeof body.category === 'string' && SLUG_RE.test(body.category)) {
          addCats[btCanonCat(body.category)] = votes;
        }
        // Never let the attributed parts exceed the total they are explaining —
        // that would render as a breakdown bigger than the number it breaks down.
        const addSum = Object.values(addCats).reduce((a, b) => a + b, 0);
        if (addSum > votes) {
          const scale = votes / addSum;
          let left = votes;
          const keys = Object.keys(addCats);
          keys.forEach((k, i) => {
            const v = i === keys.length - 1 ? left : Math.floor(addCats[k] * scale);
            addCats[k] = v; left -= v;
          });
          Object.keys(addCats).forEach(k => { if (!addCats[k]) delete addCats[k]; });
        }
        let uid = null, name = null;
        const extToken = String(body.extToken || '').trim();
        const token = String(body.accessToken || '').trim();
        if (extToken) {
          const { data: tok } = await sb.from('scrobble_tokens').select('app_user_id').eq('token', extToken).maybeSingle();
          if (!tok) return res.status(401).json({ error: 'Link your blinksunited account in the extension first.' });
          uid = tok.app_user_id;
          try { const { data: got } = await sb.auth.admin.getUserById(uid); name = (got && got.user && got.user.user_metadata && got.user.user_metadata.display_name) || null; } catch (_) { name = null; }
        } else {
          if (!token) return res.status(401).json({ error: 'Sign in to log your votes' });
          const { data: { user } = {}, error: authErr } = await sb.auth.getUser(token);
          if (authErr || !user) return res.status(401).json({ error: 'Sign in to log your votes' });
          uid = user.id;
          name = (user.user_metadata && user.user_metadata.display_name) || null;
        }
        const day = kstDay();
        const { data: existing } = await sb.from('breaktudo_user_votes').select('votes, cats').eq('app_user_id', uid).eq('day', day).maybeSingle();
        const next = (existing?.votes || 0) + votes;
        // Merge rather than replace: a fan votes several categories across a day,
        // each arriving as its own POST.
        const nextCats = Object.assign({}, (existing && existing.cats) || {});
        for (const k in addCats) nextCats[k] = (Number(nextCats[k]) || 0) + addCats[k];
        const { error: upErr } = await sb.from('breaktudo_user_votes').upsert(
          { app_user_id: uid, day, votes: next, cats: nextCats, display_name: name, updated_at: new Date().toISOString() },
          { onConflict: 'app_user_id,day' },
        );
        if (upErr) return res.status(500).json({ error: upErr.message });
        let my = null, totals = {};
        try {
          const [m, t] = await Promise.all([myBtTotals(sb, uid), sb.rpc('breaktudo_vote_totals')]);
          my = m; totals = t.data || {};
        } catch { /* ignore — client refetches */ }
        return res.status(200).json({ ok: true, my, totals });
      }
    }

    // ── Kids' Choice Awards — the third award dimension ──────────────────────
    // Selected with ?award=kca (GET) or {award:'kca'} (POST). Reads and writes
    // kca_user_votes + its own RPCs; the VMA and BreakTudo paths are untouched.
    // Per-category picks for our nominees, midnight-KST day boundary.
    if (award === 'kca') {
      if (req.method === 'GET') {
        if (req.query.board) {
          const { data, error } = await sb.rpc('kca_vote_board');
          if (error) throw error;
          return res.status(200).json({ board: data || [] });
        }
        if (req.query.sync) {
          const extToken = String(req.headers['x-ext-token'] || '').trim();
          if (!extToken) return res.status(401).json({ error: 'link required' });
          const { data: tok } = await sb.from('scrobble_tokens').select('app_user_id').eq('token', extToken).maybeSingle();
          if (!tok) return res.status(401).json({ error: 'link required' });
          const { data: v } = await sb.from('kca_user_votes').select('votes, cats').eq('app_user_id', tok.app_user_id).eq('day', kstDay()).maybeSingle();
          // `cats` travels with it so the extension panel can show today's
          // per-category tally merged across the blink's devices, not just the
          // one browser it happens to be running in.
          return res.status(200).json({ total: v?.votes || 0, cats: v?.cats || {}, accounts: [] });
        }
        if (req.query.live) {
          const cutoff = new Date(Date.now() - 90 * 1000).toISOString();
          const { data, error } = await sb.from('kca_user_votes').select('app_user_id').gte('updated_at', cutoff);
          if (error) throw error;
          return res.status(200).json({ liveVoters: data ? new Set(data.map((r) => r.app_user_id)).size : 0 });
        }
        if (req.query.me) {
          const token = bearer(req);
          if (!token) return res.status(401).json({ error: 'not signed in' });
          const { data: { user } = {}, error: authErr } = await sb.auth.getUser(token);
          if (authErr || !user) return res.status(401).json({ error: 'not signed in' });
          const [totals, streams] = await Promise.all([myKcaTotals(sb, user.id), myStreams(sb, user.id)]);
          const linked = await isLinked(sb, user.id);
          // extToday hides the manual "Add votes" form once the counter has
          // logged for this account today, so an auto-counted blink cannot
          // double-count by also typing votes in. The VMA path reads this too.
          let extToday = false;
          try {
            const { data: row } = await sb.from('kca_user_votes')
              .select('ext_at').eq('app_user_id', user.id).eq('day', kstDay()).maybeSingle();
            extToday = !!(row && row.ext_at);
          } catch (_) { extToday = false; }
          return res.status(200).json({ linked, extToday, ...totals, ...streams });
        }
        const { data, error } = await sb.rpc('kca_vote_totals');
        if (error) throw error;
        return res.status(200).json(data || { total: 0, today: 0, blinksTotal: 0, blinksToday: 0 });
      }
      if (req.method === 'POST') {
        const body = req.body || {};
        let votes = parseInt(body.votes, 10);
        if (!Number.isFinite(votes) || votes <= 0) return res.status(400).json({ error: 'votes required' });
        votes = Math.min(votes, 10000);   // sanity bound (KCA publishes no cap)

        // Per-category attribution. `cats` (a map) is what BOTH clients send
        // here, and that is the KCA-specific part: one submitted round carries
        // up to one pick per category, so a single POST legitimately covers
        // several categories at once — unlike BreakTudo, where one POST is one
        // /vote/<slug>/ page. `category` (a single slug) is still accepted for
        // the one-category case.
        const SLUG_RE = /^[a-z0-9-]{1,64}$/;
        const addCats = {};
        if (body.cats && typeof body.cats === 'object' && !Array.isArray(body.cats)) {
          for (const k of Object.keys(body.cats)) {
            const n = parseInt(body.cats[k], 10);
            if (SLUG_RE.test(k) && Number.isFinite(n) && n > 0) {
              addCats[k] = Math.min((addCats[k] || 0) + n, 10000);
            }
          }
        } else if (typeof body.category === 'string' && SLUG_RE.test(body.category)) {
          addCats[body.category] = votes;
        }
        // Never let the attributed parts exceed the total they explain — that
        // renders as a breakdown bigger than the number it breaks down.
        const addSum = Object.values(addCats).reduce((a, b) => a + b, 0);
        if (addSum > votes) {
          const scale = votes / addSum;
          let left = votes;
          const keys = Object.keys(addCats);
          keys.forEach((k, i) => {
            const v = i === keys.length - 1 ? left : Math.floor(addCats[k] * scale);
            addCats[k] = v; left -= v;
          });
          Object.keys(addCats).forEach(k => { if (!addCats[k]) delete addCats[k]; });
        }

        let uid = null, name = null;
        const extToken = String(body.extToken || '').trim();
        const token = String(body.accessToken || '').trim();
        if (extToken) {
          const { data: tok } = await sb.from('scrobble_tokens').select('app_user_id').eq('token', extToken).maybeSingle();
          if (!tok) return res.status(401).json({ error: 'Link your blinksunited account in the extension first.' });
          uid = tok.app_user_id;
          try { const { data: got } = await sb.auth.admin.getUserById(uid); name = (got && got.user && got.user.user_metadata && got.user.user_metadata.display_name) || null; } catch (_) { name = null; }
        } else {
          if (!token) return res.status(401).json({ error: 'Sign in to log your votes' });
          const { data: { user } = {}, error: authErr } = await sb.auth.getUser(token);
          if (authErr || !user) return res.status(401).json({ error: 'Sign in to log your votes' });
          uid = user.id;
          name = (user.user_metadata && user.user_metadata.display_name) || null;
        }
        const day = kstDay();
        const { data: existing } = await sb.from('kca_user_votes').select('votes, cats').eq('app_user_id', uid).eq('day', day).maybeSingle();
        const next = (existing?.votes || 0) + votes;
        // Merge rather than replace: a blink votes several rounds across a day.
        const nextCats = Object.assign({}, (existing && existing.cats) || {});
        for (const k in addCats) nextCats[k] = (Number(nextCats[k]) || 0) + addCats[k];
        const row = {
          app_user_id: uid, day, votes: next, cats: nextCats,
          display_name: name, updated_at: new Date().toISOString(),
        };
        // ext_at is set in the same upsert rather than in a follow-up update:
        // kca_user_votes has carried the column since its first migration, so
        // unlike the VMA path there is nothing to be defensive about.
        if (extToken) row.ext_at = new Date().toISOString();
        const { error: upErr } = await sb.from('kca_user_votes').upsert(row, { onConflict: 'app_user_id,day' });
        if (upErr) return res.status(500).json({ error: upErr.message });

        let my = null, totals = {};
        try {
          const [m, t] = await Promise.all([myKcaTotals(sb, uid), sb.rpc('kca_vote_totals')]);
          my = m; totals = t.data || {};
        } catch { /* ignore — client refetches */ }
        return res.status(200).json({ ok: true, my, totals });
      }
    }

    if (req.method === 'GET') {
      if (req.query.board) {
        const { data, error } = await sb.rpc('vma_vote_board');
        if (error) throw error;
        // `closed` travels with the board so the page never has to decide from
        // its own clock whether the ballot is still open.
        return res.status(200).json({ board: data || [], closed: vmaClosed() });
      }
      if (req.query.sync) {
        // The extension's authoritative counts for TODAY. Auth via the link token
        // in the x-ext-token header; returns ONLY this account's own data.
        //
        // Counts come from vma_user_votes — the SAME table the leaderboard uses — so
        // the panel always matches the board and merges every vote for this account
        // across all browsers/profiles/devices (that's what "sync" means here), no
        // matter which device cast them or whether device-sync was toggled on. The
        // accounts-used-today list still comes from vma_ext_sync (opt-in, written only
        // when device sync is on) since it carries the voting emails.
        const extToken = String(req.headers['x-ext-token'] || '').trim();
        if (!extToken) return res.status(401).json({ error: 'link required' });
        const { data: tok } = await sb.from('scrobble_tokens')
          .select('app_user_id').eq('token', extToken).maybeSingle();
        if (!tok) return res.status(401).json({ error: 'link required' });
        const day = etDay();
        const { data: v } = await sb.from('vma_user_votes')
          .select('votes, bp, lisa').eq('app_user_id', tok.app_user_id).eq('day', day).maybeSingle();
        const bp = v?.bp || 0, lisa = v?.lisa || 0, total = v?.votes || 0;
        const { data: sy } = await sb.from('vma_ext_sync')
          .select('accounts').eq('app_user_id', tok.app_user_id).eq('day', day).maybeSingle();
        const accounts = Object.entries(sy?.accounts || {}).map(([id, a]) => ({
          id, method: (a && a.method) || 'email', votes: (a && a.votes) || 0,
          cats: (a && Array.isArray(a.cats)) ? a.cats : [],
          lastTs: (a && a.ts) || 0, // so the panel sorts synced accounts chronologically too
        }));
        return res.status(200).json({ bp, lisa, total, accounts });
      }
      if (req.query.live) {
        // "Blinks voting now": distinct accounts whose tally was touched in the last
        // 90s (via the site OR the extension). Community-scoped, not a global MTV count.
        const cutoff = new Date(Date.now() - 90 * 1000).toISOString();
        const { data, error } = await sb.from('vma_user_votes')
          .select('app_user_id').gte('updated_at', cutoff);
        if (error) throw error;
        const liveVoters = data ? new Set(data.map((r) => r.app_user_id)).size : 0;
        return res.status(200).json({ liveVoters });
      }
      if (req.query.me) {
        const token = bearer(req);
        if (!token) return res.status(401).json({ error: 'not signed in' });
        const { data: { user } = {}, error: authErr } = await sb.auth.getUser(token);
        if (authErr || !user) return res.status(401).json({ error: 'not signed in' });
        const linked = await isLinked(sb, user.id);
        const [totals, streams] = await Promise.all([myTotals(sb, user.id), myStreams(sb, user.id)]);
        // Has the counter (extension or Android app) logged a vote for THIS account
        // TODAY? If so, the site hides the manual "Add votes" form to avoid double
        // counting. Best-effort: if the ext_at column isn't there yet, treat as false.
        let extToday = false;
        try {
          const { data: row } = await sb.from('vma_user_votes')
            .select('ext_at').eq('app_user_id', user.id).eq('day', etDay()).maybeSingle();
          extToday = !!(row && row.ext_at);
        } catch (_) { extToday = false; }
        return res.status(200).json({ linked, extToday, closed: vmaClosed(), ...totals, ...streams });
      }
      const { data, error } = await sb.rpc('vma_vote_totals');
      if (error) throw error;
      return res.status(200).json(data || { total: 0, today: 0, blinksTotal: 0, blinksToday: 0 });
    }

    if (req.method === 'POST') {
      // Ballot closed: refuse the write, but say so plainly enough that the
      // extension's own error path shows something a blink can understand.
      // 403 (not 400) so a client can tell "not allowed any more" apart from
      // "you sent something malformed" and stop retrying.
      if (vmaClosed()) {
        return res.status(403).json({
          error: 'VMA voting has ended — the leaderboard is final. Your totals are still on the board.',
          closed: true,
        });
      }
      const body = req.body || {};
      // Per-artist split: the website sends {bp, lisa}; the extension sends
      // breakdown:{BLACKPINK, LISA}. When a split is given it is authoritative for
      // the total; otherwise fall back to a lump {votes} (unattributed, legacy).
      const bd = body.breakdown || {};
      let bp   = parseInt(body.bp, 10);
      let lisa = parseInt(body.lisa, 10);
      if (!Number.isFinite(bp)   || bp   < 0) bp   = parseInt(bd.BLACKPINK, 10) || 0;
      if (!Number.isFinite(lisa) || lisa < 0) lisa = parseInt(bd.LISA, 10) || 0;
      bp   = Math.max(0, Math.min(bp,   10000));
      lisa = Math.max(0, Math.min(lisa, 10000));
      let votes = (bp + lisa) > 0 ? bp + lisa : parseInt(body.votes, 10);
      if (!Number.isFinite(votes) || votes <= 0) return res.status(400).json({ error: 'votes required' });
      const claimed = votes;
      votes = Math.min(votes, 10000); // sanity bound only (no daily cap)
      // Scale the split down with the total. Each half is bounded on its own
      // BEFORE the total is bounded, so bp=8000 + lisa=8000 stored a 16,000
      // breakdown against a 10,000 total — the parts exceeding the whole. Enough
      // of those and the board shows 16,000 + 16,000 beside 20,000 votes.
      //
      // Only when a split was actually given: for a lump {votes} submission
      // bp and lisa are both 0 and must STAY 0, or scaling would invent a
      // breakdown for votes that never carried one.
      if (claimed > votes && (bp + lisa) > 0) {
        bp = Math.floor((bp * votes) / claimed);
        lisa = votes - bp;            // the remainder, so the two add to `votes` exactly
      }

      // Two ways to authenticate a vote submission:
      //   • accessToken — a Supabase session (the website "Add votes" button).
      //   • extToken    — a scrobble_token (the BU vote-counter browser extension,
      //     linked once via /extension-link.html). Resolve it to the same account.
      let uid = null, name = null;
      const extToken = String(body.extToken || '').trim();
      const token = String(body.accessToken || '').trim();
      if (extToken) {
        const { data: tok } = await sb
          .from('scrobble_tokens').select('app_user_id, label').eq('token', extToken).maybeSingle();
        if (!tok) return res.status(401).json({ error: 'Link your blinksunited account in the extension first.' });
        uid = tok.app_user_id;
        // Use the account's real display name (same source as the website path) so the
        // board shows it — not a linked scrobbler handle like "jumppink". Falls back to
        // null (→ board resolves handle/blinkN) only if the lookup fails or none is set.
        try {
          const { data: got } = await sb.auth.admin.getUserById(uid);
          name = (got && got.user && got.user.user_metadata && got.user.user_metadata.display_name) || null;
        } catch (_) { name = null; }
      } else {
        if (!token) return res.status(401).json({ error: 'Sign in to log your votes' });
        const { data: { user } = {}, error: authErr } = await sb.auth.getUser(token);
        if (authErr || !user) return res.status(401).json({ error: 'Sign in to log your votes' });
        // Streaming is optional: anyone signed in can log votes. Non-streamers just
        // aren't ranked (no stream = no rank) — they earn a "Voter" badge at 1000/day.
        uid = user.id;
        // Store the BU display name if set, else null — the board resolves nameless
        // accounts to their handle / blinkN (see vma_vote_board).
        name = (user.user_metadata && user.user_metadata.display_name) || null;
      }
      const user = { id: uid };
      const day = etDay();

      // Additive: add to today's tally (self-reported, uncapped). `votes` is the
      // ranking total; `bp`/`lisa` accumulate the attributed split alongside it.
      const { data: existing } = await sb
        .from('vma_user_votes').select('votes, bp, lisa').eq('app_user_id', user.id).eq('day', day).maybeSingle();
      const next     = (existing?.votes || 0) + votes;
      const nextBp   = (existing?.bp    || 0) + bp;
      const nextLisa = (existing?.lisa  || 0) + lisa;

      const { error: upErr } = await sb.from('vma_user_votes').upsert(
        { app_user_id: user.id, day, votes: next, bp: nextBp, lisa: nextLisa, display_name: name, updated_at: new Date().toISOString() },
        { onConflict: 'app_user_id,day' },
      );
      if (upErr) return res.status(500).json({ error: upErr.message });

      // Mark this day's row as counter-logged when the vote came via a link token
      // (the browser extension or the Android app). The site reads this (?me=1 →
      // extToday) to hide the manual "Add votes" form, so an auto-counted account
      // can't double-count by also typing votes in. Best-effort: silently no-ops if
      // the ext_at column hasn't been added yet (supabase/migrations).
      if (extToken) {
        try {
          await sb.from('vma_user_votes')
            .update({ ext_at: new Date().toISOString() })
            .eq('app_user_id', user.id).eq('day', day);
        } catch (_) { /* column not present yet — feature just stays dormant */ }
      }

      // Opt-in cross-device sync: when the extension is in sync mode it sends the
      // per-member breakdown + the voting account, and we record them under this BU
      // account so the user's other devices see a merged view. Best-effort — never
      // fail the vote if the sync write hiccups. Only via extToken (the extension).
      if (extToken && body.sync) {
        try {
          const bd = body.breakdown || {};
          const acct = body.account || {};
          await sb.rpc('vma_ext_sync_add', {
            p_uid: user.id, p_day: day,
            p_bp: parseInt(bd.BLACKPINK, 10) || 0,
            p_lisa: parseInt(bd.LISA, 10) || 0,
            p_email: (acct.id ? String(acct.id).slice(0, 320) : null),
            p_method: (acct.method ? String(acct.method).slice(0, 32) : null),
            p_cat: (acct.cat ? String(acct.cat).slice(0, 16) : null),
            p_n: votes,
          });
        } catch { /* ignore — sync is a convenience, the vote already saved */ }
      }

      // The vote is saved. Compute fresh totals for the response, but never fail
      // the request if that read hiccups — the write already succeeded, so a 500
      // here would wrongly tell the client to "try again" (and double-count).
      let my = null, totals = {};
      try {
        const [m, t] = await Promise.all([myTotals(sb, user.id), sb.rpc('vma_vote_totals')]);
        my = m; totals = t.data || {};
      } catch { /* ignore — client will refetch */ }
      return res.status(200).json({ ok: true, my, totals });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'error' });
  }
}
