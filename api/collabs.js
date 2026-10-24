// Votes cast through a fandom collab — the board behind /collabs.
//
//   GET  /api/collabs?id=<collab>   → { todayKey, from, periods:{today,week,all}, days[] }
//   POST /api/collabs { id, cats:{<ballot category>: n}, accessToken | extToken }
//
// WHY THIS IS NOT PART OF /api/vma-votes. That endpoint's three awards each
// write a table whose `votes` column ranks a BLACKPINK board and earns a
// BLACKPINK badge. A collab counts picks for a PARTNER's nominee too, and one
// of those is not a BLACKPINK vote by any reading — putting it in that column
// would raise a blink's standing on the BLACKPINK board for voting BINI. Own
// table, own endpoint, read by nothing else. See supabase/collab_votes.sql.
//
// THE API DOES NOT KNOW WHOSE NOMINEE IS WHOSE, and that is deliberate. It
// returns picks keyed by ballot category and nothing more; /collabs owns the
// list of which categories belong to which act and sums them itself. Teaching
// this file the same thing would be a second copy of it, free to drift, and
// the first symptom of drift would be a bar attributing votes to the wrong
// act — the exact failure the page is built to avoid.
//
// RANKED ON VOTES CAST, with no streaming gate. /api/vma-votes ranks nobody who
// has not streamed today, which is right for a board about streaming and wrong
// for a voting collaboration: half the people on this one have no reason to be
// streaming BLACKPINK at all.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY.  Schema: supabase/collab_votes.sql.

import { createClient } from '@supabase/supabase-js';

function supabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// Midnight KST, the same boundary kca_user_votes rolls on. en-CA formats as
// YYYY-MM-DD and Intl handles the offset.
const kstDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);

// Monday-start week containing `day`, as a YYYY-MM-DD string. Computed from the
// date parts rather than by parsing the string as a Date, which would put a
// KST calendar day through the runtime's timezone and can move it a day.
function mondayOf(day) {
  const [y, m, d] = day.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  const dow = (base.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(y, m - 1, d - dow)).toISOString().slice(0, 10);
}

const SLUG_RE = /^[\w .'’&()-]{1,80}$/;        // a ballot category, as the page writes it
// A self-declared fandom key, as /collabs defines it for that collab. Narrow
// on purpose: it is stored, counted and printed on a page, and the caller is
// an extension that anybody can edit.
const FANDOM_RE = /^[a-z][a-z0-9-]{0,23}$/;
// A fandom key is also the start of an auto display name (bloom1, pauljjak1) —
// but only if it has the shape fan_display_names.sql accepts as a prefix, which
// is narrower: no hyphens, at least two characters. A key outside it is still a
// perfectly good fandom to count people under; it just never names anybody,
// because mint_fan_name would fall back to "blink" and call a BLOOM a blink.
const NAME_PREFIX_RE = /^[a-z][a-z0-9]{1,20}$/;
const ID_RE = /^[a-z0-9-]{1,64}$/;
const MAX_PER_CAT = 10000;
const BOARD_MAX = 200;
// A collab's whole history is read to build the board. Bounded so a runaway
// writer cannot turn one page load into an unbounded scan; if a collab ever
// genuinely exceeds this the fix is an RPC that aggregates in Postgres, not a
// bigger number here.
const ROW_MAX = 20000;

const addInto = (into, src) => {
  for (const k in (src || {})) {
    const n = Number(src[k]) || 0;
    if (n > 0) into[k] = (into[k] || 0) + n;
  }
};
const sumOf = (o) => Object.values(o || {}).reduce((a, b) => a + (Number(b) || 0), 0);

// Record on the ACCOUNT which fandom somebody says they are, and bring an
// auto-assigned display name in line with it. Returns the name to store on this
// row — the new one if it was renamed, otherwise the one passed in.
//
// Only ever an AUTO name. `display_name_auto` is the flag the site writes beside
// a name it issued; the ^blink\d+$ fallback covers accounts named before that
// flag existed, a namespace that was never choosable. A name somebody chose for
// themselves is never touched, which is the whole reason this is a flag and not
// a guess from the name's shape: "bloom12" is a plausible hand-picked name.
//
// Best-effort throughout: the vote is the thing that must land, and every
// failure here costs nothing but a label.
async function syncAccountFandom(sb, uid, fandom, name) {
  const { data: got } = await sb.auth.admin.getUserById(uid);
  const md = (got && got.user && got.user.user_metadata) || null;
  if (!md) return name;

  const cur = String(md.display_name || '').trim();
  const isAuto = md.display_name_auto === true || /^blink\d+$/i.test(cur);
  const matches = cur && new RegExp('^' + fandom + '\\d+$', 'i').test(cur);
  const next = Object.assign({}, md);
  let changed = false;

  if (md.fandom !== fandom) { next.fandom = fandom; changed = true; }

  let newName = null;

  // NO NAME AT ALL is its own case, and the one that matters on a board.
  // Everybody without a display name used to render identically — "a bloom",
  // "a bloom", "a bloom" — so nobody could find their own row. An automatic
  // name is only useful if it is NUMBERED, which is the whole point of bloom1,
  // bloom2 beside blink1, blink2.
  //
  // Not for somebody whose Last.fm handle is already showing on the streaming
  // leaderboard, though: naming them would replace that handle with a number
  // they did not ask for, which is a thing this site did once before and had to
  // undo (see the revert-auto-blink cleanup in api/leaderboard.js). A linked
  // scrobbler is exactly what makes a handle visible, so its absence is the
  // test. Best-effort: if the lookup fails, leave the name alone rather than
  // risk taking a handle away.
  if (!cur && NAME_PREFIX_RE.test(fandom)) {
    let hasHandle = true;
    try {
      const { data: linked, error: lErr } = await sb.from('linked_accounts')
        .select('id').eq('app_user_id', uid).limit(1);
      hasHandle = !!lErr || !!(linked && linked.length);
    } catch (_) { hasHandle = true; }
    if (!hasHandle) {
      const { data: minted, error } = await sb.rpc('mint_fan_name', { p_prefix: fandom });
      if (!error && minted) {
        newName = minted;
        next.display_name = minted;
        next.display_name_auto = true;
        changed = true;
      }
    }
  }

  if (!newName && cur && isAuto && !matches && NAME_PREFIX_RE.test(fandom)) {
    const { data: minted, error } = await sb.rpc('mint_fan_name', { p_prefix: fandom });
    // No function yet (the migration is applied by hand) — record the fandom
    // and leave the name alone rather than failing the vote.
    if (!error && minted) {
      newName = minted;
      next.display_name = minted;
      next.display_name_auto = true;
      changed = true;
    }
  }
  if (!changed) return name;

  const { error: upErr } = await sb.auth.admin.updateUserById(uid, { user_metadata: next });
  if (upErr || !newName) return name;

  // Their earlier rows still carry the old name, and the board takes the last
  // non-null one it reads — with no ordering, that could be any of them. So the
  // rename has to reach the rows that already exist, not only the one being
  // written now. Every collab, not just this one: a display name belongs to the
  // account, so one person cannot be two names on two boards.
  try {
    await sb.from('collab_user_votes')
      .update({ display_name: newName })
      .eq('app_user_id', uid);
  } catch (_) {}
  return newName;
}

// One period's view: the category split, and the people, ordered by votes.
// `board` carries each person's own split so the page can show what they cast
// without a second request.
function periodFrom(rows, fandomOf) {
  const byCat = {};
  const per = new Map();
  for (const r of rows) {
    addInto(byCat, r.cats);
    const key = r.app_user_id;
    let e = per.get(key);
    if (!e) {
      e = { name: r.display_name || null, votes: 0, byCat: {},
            fandom: (fandomOf && fandomOf.get(key)) || null };
      per.set(key, e);
    }
    // Latest non-null name wins: a row written by the extension before the
    // profile had a display name should not blank out one that does.
    if (r.display_name) e.name = r.display_name;
    e.votes += Number(r.votes) || 0;
    addInto(e.byCat, r.cats);
  }
  const board = [...per.values()]
    .filter((e) => e.votes > 0)
    .sort((a, b) => b.votes - a.votes || String(a.name || '').localeCompare(String(b.name || '')))
    .slice(0, BOARD_MAX);

  // Who turned up, by what they say they are. PEOPLE and their logged votes —
  // never a split of the per-act totals above, which cannot be attributed to a
  // fandom at all because everyone votes the whole ballot. `people` is what
  // makes the average meaningful, and the average is what makes this readable
  // when one side simply has more accounts than the other.
  const fandoms = {};
  for (const e of per.values()) {
    if (e.votes <= 0) continue;
    const k = e.fandom || 'unsaid';
    const f = fandoms[k] || (fandoms[k] = { people: 0, votes: 0 });
    f.people += 1;
    f.votes += e.votes;
  }

  return { byCat, board, fandoms, total: sumOf(byCat) };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Ext-Token');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sb = supabase();
  if (!sb) return res.status(503).json({ error: 'Collabs not configured' });

  const id = String((req.query && req.query.id) || (req.body && req.body.id) || '').trim();
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Unknown collab' });

  try {
    if (req.method === 'GET') {
      const { data, error } = await sb
        .from('collab_user_votes')
        .select('app_user_id, day, votes, cats, display_name, fandom')
        .eq('collab_id', id)
        .limit(ROW_MAX);
      if (error) throw error;
      const rows = data || [];
      const today = kstDay();
      const monday = mondayOf(today);

      // One fandom per person, worked out ACROSS EVERY ROW and then applied to
      // each period. Reading it per period instead would count somebody who
      // declared today as "didn't say" in the all-time view, which is the same
      // person answering twice. Latest non-null wins, as with display_name.
      const fandomOf = new Map();
      for (const r of rows) if (r.fandom) fandomOf.set(r.app_user_id, r.fandom);

      // Day by day, for the grid. Pooled across everybody: the grid is the
      // collab's shape over time, not one person's.
      const dayMap = new Map();
      for (const r of rows) {
        let d = dayMap.get(r.day);
        if (!d) { d = { day: r.day, votes: 0, byCat: {} }; dayMap.set(r.day, d); }
        d.votes += Number(r.votes) || 0;
        addInto(d.byCat, r.cats);
      }
      const days = [...dayMap.values()].sort((a, b) => (a.day < b.day ? -1 : 1));

      return res.status(200).json({
        todayKey: today,
        from: days.length ? days[0].day : null,
        periods: {
          today: periodFrom(rows.filter((r) => r.day === today), fandomOf),
          week:  periodFrom(rows.filter((r) => r.day >= monday), fandomOf),
          all:   periodFrom(rows, fandomOf),
        },
        days,
      });
    }

    if (req.method === 'POST') {
      const body = req.body || {};

      // Picks, keyed by ballot category. Bounded per category and dropped if
      // they do not look like a category at all — this is the only thing a
      // caller controls, and a key from here ends up as a label on a page.
      const addCats = {};
      const raw = body.cats;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return res.status(400).json({ error: 'cats must be an object of category → count' });
      }
      for (const k of Object.keys(raw)) {
        const n = parseInt(raw[k], 10);
        if (SLUG_RE.test(k) && Number.isFinite(n) && n > 0) {
          addCats[k] = Math.min(n, MAX_PER_CAT);
        }
      }
      const add = sumOf(addCats);
      if (!add) return res.status(400).json({ error: 'nothing to record' });

      // Who. The extension carries its own token; the site sends the Supabase
      // session. Either way the identity comes from the token and never from
      // the body, which is the whole reason this is better than self-reporting.
      let uid = null, name = null;
      const extToken = String(body.extToken || req.headers['x-ext-token'] || '').trim();
      const accessToken = String(body.accessToken || '').trim();
      if (extToken) {
        const { data: tok } = await sb.from('scrobble_tokens')
          .select('app_user_id').eq('token', extToken).maybeSingle();
        if (!tok) return res.status(401).json({ error: 'Link your blinksunited account in the extension first.' });
        uid = tok.app_user_id;
        try {
          const { data: got } = await sb.auth.admin.getUserById(uid);
          name = (got && got.user && got.user.user_metadata && got.user.user_metadata.display_name) || null;
        } catch (_) { name = null; }
      } else {
        if (!accessToken) return res.status(401).json({ error: 'Sign in to log your votes' });
        const { data: { user } = {}, error: authErr } = await sb.auth.getUser(accessToken);
        if (authErr || !user) return res.status(401).json({ error: 'Sign in to log your votes' });
        uid = user.id;
        name = (user.user_metadata && user.user_metadata.display_name) || null;
      }

      const day = kstDay();
      const { data: existing } = await sb.from('collab_user_votes')
        .select('votes, cats').eq('collab_id', id).eq('app_user_id', uid).eq('day', day).maybeSingle();

      // Merge rather than replace — a person votes several rounds across a day.
      const nextCats = Object.assign({}, (existing && existing.cats) || {});
      for (const k in addCats) nextCats[k] = (Number(nextCats[k]) || 0) + addCats[k];
      // Summed from the merged map rather than added to the old total, so the
      // stored `votes` can never drift from `cats` — the table has a constraint
      // saying exactly that, and this is the side that has to honour it.
      // What they say they are. Validated, never trusted for anything but a
      // count of people: it splits no votes and gates nothing.
      const fandom = FANDOM_RE.test(String(body.fandom || '').trim().toLowerCase())
        ? String(body.fandom).trim().toLowerCase() : null;

      // The answer given in the extension belongs to the ACCOUNT, not just to
      // this collab's rows: it decides the anonymous display name the site
      // gives someone (bloom1 rather than blink41), and naming a BLOOM a blink
      // is most visible exactly here, on the board that exists to show each
      // fandom turning up. The site writes the same user_metadata.fandom, so
      // the two can never disagree about who somebody is.
      //
      // Renaming is handled here too rather than waiting for them to open the
      // site: somebody who votes through the extension may never come back to
      // blinksunited.com, and until they did their row would read "blink41".
      // mint_fan_name is the server's side door into the same counter the
      // browser reaches through assign_fan_name / reissue_fan_name.
      if (fandom) {
        try { name = await syncAccountFandom(sb, uid, fandom, name); } catch (_) {}
      }

      const row = {
        collab_id: id, app_user_id: uid, day,
        votes: sumOf(nextCats), cats: nextCats,
        display_name: name, updated_at: new Date().toISOString(),
      };
      if (extToken) row.ext_at = new Date().toISOString();
      if (fandom) row.fandom = fandom;

      const { error: upErr } = await sb.from('collab_user_votes')
        .upsert(row, { onConflict: 'collab_id,app_user_id,day' });
      if (upErr) return res.status(500).json({ error: upErr.message });

      // Carry it back over their earlier days of THIS collab. Somebody is
      // asked which fandom they are after their first round, so without this
      // the day they joined counts as "didn't say" for ever — the one day the
      // answer is most obviously known. Best-effort: the vote is already
      // recorded and a failure here costs nothing but a label.
      if (fandom) {
        try {
          await sb.from('collab_user_votes')
            .update({ fandom })
            .eq('collab_id', id).eq('app_user_id', uid).is('fandom', null);
        } catch (_) {}
      }

      return res.status(200).json({ ok: true, day, votes: row.votes, cats: row.cats, fandom });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || 'failed' });
  }
}

export const __test = { kstDay, mondayOf, periodFrom, sumOf, addInto, SLUG_RE };
