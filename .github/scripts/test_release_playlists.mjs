// The playlists on the Power Trip and Sun Showers cards are the ones that were
// asked for, they are labelled honestly, and the note under each tells the
// truth on both sides of its own release.
//
// Run: node .github/scripts/test_release_playlists.mjs
//
// WHY A TEST FOR SEVEN LINKS. A playlist id is 22 base62 characters and one
// wrong character is a dead link on a card thousands of people tap — silently,
// because Spotify answers a bad id with its own "couldn't find that" page
// rather than an error anyone here would see. These were read out of the
// account by API for exactly that reason; this pins what was read.
//
// WHY ONE FILE FOR TWO CARDS. Two of the playlists are on BOTH, and that is
// deliberate: JENNIE's "Power Trip" and JISOO's "Sun Showers" land on the same
// date, so "JENSOO RELEASE DAY" is both songs and "LWM x PT x SS" is both plus
// LISA's single. A per-card test would have to treat a shared id as either
// forbidden or invisible. Here it is neither — it is checked to be on exactly
// the cards it belongs on, which is the only version of that check that can
// catch a copy-paste slip without also banning the real case.
//
// AND WHY THE NOTES ARE CHECKED IN A BROWSER. They are deliberately NOT in the
// markup: each has to switch at its own release instant, and the three cards
// that wrote their note into the HTML all went stale — PRESS PLAY's still
// reads "they fill up when PRESS PLAY lands" two weeks after it landed. A note
// that is empty in the source is right only if a script fills it, so the only
// meaningful check is the rendered one, on both sides of the instant.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from './_playwright.mjs';

const root = new URL('../..', import.meta.url).pathname;
let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };
const check = (c, m, d) => (c ? ok(m, d) : bad(m, d));

const src = readFileSync(root + 'index.html', 'utf8');

// `shared: true` means the playlist carries more than one of the releases and
// is expected on more than one card. Everything else must appear exactly once
// on the whole page.
const SHARED = {
  jensoo: ['JENSOO RELEASE DAY',    '75Pc4jtAlQsKaQyBUtWpnJ'],
  lwmpt:  ['LWM x PT x SS Focused', '0PqV4NjZKG0Q3DKi2AkgJ3'],
};

const CARDS = [
  {
    key: 'powertrip', cls: 'cd-card-powertrip', song: 'Power Trip', path: '/countdowns/powertrip',
    noteId: 'pt-pl-note', post: '_ptPlaylistPost', live: 'ptLive',
    // Three of its own, then the two that span the other drops — in that
    // order, because it is the order in the shared post too.
    want: [
      ['POWER TRIP Focused', '6itTleOIire70BDaVOLf50'],
      ['POWER TRIP x PINKS', '4FMIAhP7tdzV7xgZbwsSCe'],
      ['POWER TRIP x BP',    '2QI45Deh6MrFuUKR2E6Rlu'],
      SHARED.jensoo,
      SHARED.lwmpt,
    ],
    // It has three of its own ABOVE the shared pair, so the pair is set apart
    // visually. See the Sun Showers entry for why that is not universal.
    dividerAfter: 3,
  },
  {
    key: 'sunshowers', cls: 'cd-card-sunshowers', song: 'Sun Showers', path: '/countdowns/sunshowers',
    noteId: 'ss-pl-note', post: '_ssPlaylistPost', live: 'ssLive',
    want: [SHARED.jensoo, SHARED.lwmpt],
    // NO DIVIDER, and that is the point: neither of these is Sun Showers' own,
    // so there is nothing above to set them apart from. The honesty moves into
    // the note instead, which is checked below. If this card ever gets its own
    // playlists they go above these and the divider comes with them.
    dividerAfter: null,
  },
];

// Bounded by brace depth, not by the next `</div>`: the share button sits
// after the pill list, so a bound that stopped at the first closing tag used
// to match nothing and report the playlists missing when they were right
// there. (Same lesson as test_presave_wiring's.)
const cardSrc = (cls) => {
  const open = src.indexOf(`<div class="cd-card ${cls}"`);
  if (open < 0) return '';
  let depth = 0;
  const tag = /<div\b[^>]*>|<\/div>/g;
  tag.lastIndex = open;
  for (let m; (m = tag.exec(src)); ) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return src.slice(open, m.index + m[0].length);
  }
  return '';
};

for (const card of CARDS) {
  console.log(`--- ${card.song}: the card lists them`);
  const html = cardSrc(card.cls);
  check(!!html, 'the card is there to read');
  check(html.includes('<div class="cd-pl-pills">'),
        'and carries the playlists block, open rather than behind a <summary>');

  // The label sits after an inline Spotify glyph, so the visible text is what
  // is left once tags are stripped — reading up to the first '<' would measure
  // the <svg> and every name would come back empty.
  const links = [...html.matchAll(/<a class="cd-pl-pill" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => [m[2].replace(/<[^>]*>/g, '').trim(), m[1]]);

  check(links.length === card.want.length, `${card.want.length} playlists listed`,
        `${links.length}: ${links.map((l) => l[0]).join(', ')}`);
  card.want.forEach(([name, id], i) => {
    const got = links[i] || [];
    check(got[0] === name && got[1] === `https://open.spotify.com/playlist/${id}`,
          `  ${i + 1}. ${name}`, got[0] ? `got ${got[0]} → ${got[1]}` : 'missing');
  });

  const ids = card.want.map(([, id]) => id);
  check(new Set(ids).size === ids.length, '  no id appears twice on this card');

  // ?si= identifies whoever copied the link and would be handed to every
  // visitor alike. Every other playlist list on the site is stripped of it.
  const si = (html.match(/open\.spotify\.com\/playlist\/[^"]*[?&]si=[^"]*/g) || []);
  check(!si.length, '  and none carries a share-tracking parameter', si.join(' '));

  if (card.dividerAfter !== null) {
    const divider = html.indexOf('class="pt-pl-also"');
    check(divider > 0, '  a divider marks where its own playlists end');
    if (divider > 0) {
      const last  = html.indexOf(card.want[card.dividerAfter - 1][1]);
      const first = html.indexOf(card.want[card.dividerAfter][1]);
      check(last < divider && divider < first,
            `    and it sits between #${card.dividerAfter} and #${card.dividerAfter + 1}`);
    }
  } else {
    check(!html.includes('pt-pl-also'),
          '  no divider, because none of these is this song\'s own');
  }

  const noteEl = html.match(new RegExp(`<p class="cd-pl-note" id="${card.noteId}">([\\s\\S]*?)</p>`));
  check(!!noteEl, `  the note is an empty #${card.noteId}, filled by script`);
  check(noteEl && noteEl[1].trim() === '',
        '    with nothing hardcoded inside it', noteEl ? noteEl[1].trim() : 'no element');
  console.log('');
}

// ── the ids themselves ──────────────────────────────────────────────────────
console.log('--- the ids are the shape an id is, and sit where they belong');
const ALL = [...new Map(CARDS.flatMap((c) => c.want).map((w) => [w[1], w])).values()];

// A typo in an id is the failure this whole file exists for, and it does not
// look like one: 22 base62 characters all look alike. So the shape is checked
// too, which catches a truncated or pasted-over id even if the tables above
// are edited to match it.
const shapeBad = ALL.filter(([, id]) => !/^[0-9A-Za-z]{22}$/.test(id));
check(!shapeBad.length, 'every id is 22 base62 characters',
      shapeBad.map(([n, id]) => `${n}: ${id} (${id.length})`).join('; '));

// The real check behind "did someone paste the wrong link": count where each
// id actually appears on the page. A song's own playlist must be on exactly
// one card; a shared one on exactly the cards that carry its songs. Counting
// rather than forbidding is what lets both be true at once.
const sharedIds = new Set(Object.values(SHARED).map(([, id]) => id));
for (const [name, id] of ALL) {
  const on = CARDS.filter((c) => cardSrc(c.cls).includes(id)).map((c) => c.key);
  // One occurrence per card it is on, and no more. A twelfth copy somewhere
  // else on the page is a paste that landed in the wrong block.
  const total = (src.match(new RegExp(id, 'g')) || []).length;
  const elsewhere = total > on.length;
  if (sharedIds.has(id)) {
    check(on.length === CARDS.length, `  ${name} is on both cards, deliberately`, on.join(', ') || 'neither');
  } else {
    check(on.length === 1, `  ${name} is on exactly one card`, on.join(', ') || 'none');
  }
  check(!elsewhere, `    and nowhere else on the page`);
}

// ── the YouTube premiere row, which is NOT the card's own instant ───────────
console.log('\n--- the Power Trip premiere row keeps its own clock');
{
  const html = cardSrc('cd-card-powertrip');
  const PREMIERE = '2026-11-20T05:00:00Z';   // read off the watch page's scheduledStartTime
  const VIDEO    = 'aCRr5rASMGY';
  const row = html.match(/<a class="cd-mv-note"[\s\S]*?<\/a>/);
  check(!!row, 'the card carries a premiere row');
  const r = row ? row[0] : '';
  check(r.includes(`youtube.com/watch?v=${VIDEO}`), '  pointing at the right video', VIDEO);
  // ?is= is YouTube's share token — it identifies whoever copied the link and
  // would be handed to every visitor alike, same rule as ?si= on Spotify.
  check(!/[?&](is|si|feature|t)=/.test(r), '  with no share-tracking parameter on it',
        (r.match(/https:\/\/[^"]*/) || [''])[0]);

  // THE CHECK THAT MATTERS. The song lands at midnight LOCAL; the premiere is
  // one worldwide instant. If this row ever borrows the card's target it will
  // say "is on YouTube" at a reader's own midnight — up to 14 hours early in
  // Kiritimati, and still 6 hours early in Rome. Pinning the literal instant
  // is not enough on its own: it also has to DIFFER from the card's.
  const preAt = (r.match(/data-pre-at="([^"]+)"/) || [])[1];
  const whenAt = (r.match(/data-local-target="([^"]+)"/) || [])[1];
  check(preAt === PREMIERE, '  its label flips on the premiere instant', `${preAt}`);
  check(whenAt === PREMIERE, '  and the time it prints is that same instant', `${whenAt}`);
  const cardTarget = (html.match(/data-target="([^"]+)"/) || [])[1];
  check(preAt && cardTarget && preAt !== cardTarget,
        '  which is NOT the card\'s own target', `premiere ${preAt} vs song ${cardTarget}`);
  // 05:00 UTC is midnight on the US east coast, which is the one place the two
  // do coincide — and the note says so, so it is worth pinning that it stays
  // true if either instant is ever edited.
  const etMidnight = new Date(Date.UTC(2026, 10, 20, 0, 0, 0) + 5 * 3600000).toISOString();
  check(new Date(PREMIERE).toISOString() === etMidnight,
        '  and it really is midnight US east coast, as the note claims', etMidnight);

  // It must not claim a format nobody has confirmed. The video is titled with
  // no "Official Music Video" / "Official Audio" marker and has no published
  // duration, so the card says "premiere" and stops.
  // The VISIBLE text only. Matching the raw markup catches the row's own
  // `cd-mv-note` / `cd-mv-when` class names and fails on the component it is
  // built from rather than on anything the card says.
  const words = [r.replace(/<[^>]*>/g, ' '),
                 ...(r.match(/data-(?:pre|post)="([^"]*)"/g) || [])].join(' ');
  check(!/\bMV\b|Music Video|Official Audio|Visualizer|Lyric Video/i.test(words),
        '  and claims no format the title does not state', words.replace(/\s+/g, ' ').trim());
}

// ── rendered, in a real browser, on both sides of each release ──────────────
const SPA = /^\/(countdowns|voting|vote|streams|badges|leaderboard|account|feedback)(\/|$)/;
const server = createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (p.startsWith('/api/')) { res.writeHead(404); res.end(''); return; }
  const file = SPA.test(p) || p === '/' ? '/index.html' : p;
  try {
    const b = readFileSync(root + file.slice(1));
    const ext = file.split('.').pop();
    res.writeHead(200, { 'content-type': { html: 'text/html', js: 'text/javascript', css: 'text/css',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' }[ext]
      || 'application/octet-stream' });
    res.end(b);
  } catch { res.writeHead(404); res.end(''); }
});
await new Promise(r => server.listen(0, r));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch();

// One sample before BOTH releases (Power Trip's first midnight is 10:00 UTC at
// UTC+14; Sun Showers is 05:00 UTC on the 20th) and one after both.
const at = async (card, iso) => {
  // SERVICE WORKERS BLOCKED, and this is the fix for the flake rather than a
  // precaution. In a fresh context sw.js installs, calls clients.claim(), and
  // index.html's `controllerchange` handler reloads the page ONCE on purpose —
  // so the build swaps instead of running stale cached JS. That reload lands
  // somewhere in the middle of reading the card, and destroys the execution
  // context mid-read: "Execution context was destroyed, most likely because of
  // a navigation", on about half of all runs, with nothing in the message to
  // connect it to a service worker. Nothing here is testing the worker, so the
  // honest fix is to not have one rather than to retry around it.
  const ctx = await browser.newContext({ viewport: { width: 430, height: 950 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(iso));
  await page.addInitScript(() => { try { localStorage.setItem('bu_tutorial_seen', '1');
    localStorage.setItem('ltal_reminder_dismissed_v1', '1');
    localStorage.setItem('ext_update_dismissed_1.9.8', '1'); } catch (e) {} });
  // `load`, not `domcontentloaded`: the router finishes settling the deep link
  // after DOMContentLoaded, and evaluating into the page mid-settle loses the
  // execution context — which surfaces as "Execution context was destroyed"
  // on roughly every other run rather than as anything to do with playlists.
  await page.goto(base + card.path, { waitUntil: 'load' });
  // WAIT FOR THE FUNCTIONS, NOT FOR THE PILLS. The card markup is at line
  // ~4,600 of a 28,000-line file and these functions are at ~20,000, so the
  // pills are on screen and the locator resolves while the rest of the script
  // is still parsing. Gating on the DOM therefore evaluates into a half-built
  // page, which surfaced as "renderSsPlaylistNote is not defined" on about one
  // run in three — and, when the teardown won the race instead, as "Execution
  // context was destroyed", which reads like a navigation and is not one.
  //
  // It cannot be a `typeof window[name]` probe either: ptLive and ssLive are
  // top-level `const`s, so they live in the script's lexical scope and are NOT
  // properties of window. Evaluated code shares that scope, so they are named
  // directly, inside a try/catch — before they are declared the reference
  // throws rather than returning undefined, and that throw is the "not ready
  // yet" signal.
  //
  // AND THE WAIT AND THE READ ARE ONE CALL, which is the part that actually
  // fixed it. Waiting and then evaluating is two round trips with a gap
  // between them, and the gap is where the page kept being caught still
  // parsing. Returning the whole result FROM the predicate closes the gap by
  // construction: a falsy return keeps polling, so the read only ever happens
  // in a tick where everything it needs already exists.
  const got = await (await page.waitForFunction((c) => {
    let T;
    try {
      T = {
        powertrip:  { live: () => ptLive(), post: () => _ptPlaylistPost(), render: () => renderPtPlaylistNote() },
        sunshowers: { live: () => ssLive(), post: () => _ssPlaylistPost(), render: () => renderSsPlaylistNote() },
      }[c.key];
      T.render();
    } catch { return null; }
    if (!document.querySelector(`.${c.cls} .cd-pl-pill`)) return null;
    const pills = [...document.querySelectorAll(`.${c.cls} .cd-pl-pill`)];
    return {
      live:  T.live(),
      note:  document.getElementById(c.noteId)?.textContent.trim() || '',
      // Visible without opening anything — the whole point of the block being
      // open on the card. A pill inside a closed <details> has height 0.
      shown: pills.filter((p) => p.getBoundingClientRect().height > 0).length,
      // Contrast is a real risk on Sun Showers, the one card on a bright
      // ground: the component's defaults are light-on-dark and both vanish on
      // #f9b218. Read the computed colours back rather than trusting the CSS.
      //
      // THREE colours, not two. The pill's own background is a 4–7% wash, so
      // getComputedStyle returns the wash and not what anyone sees; comparing
      // ink to a 7%-alpha copy of that same ink reports 1.0:1 for a pill that
      // is perfectly legible. What the reader sees is the wash composited over
      // the CARD, so the card's own opaque ground is read too and the
      // compositing is done in the test.
      // ALL THREE ELEMENTS, not just the pill. Only the pills read the --pl-*
      // variables; .cd-pl-note and .cd-pl-share hardcode rgba(255,255,255,…).
      // So inverting the palette for a bright card fixes the pills and leaves
      // the note and the button near-white on yellow — which is exactly what
      // happened, and a check that measured one of the three said it was fine.
      parts: [
        ['pill',  pills[0]],
        ['note',  document.getElementById(c.noteId)],
        ['share', document.querySelector(`.${c.cls} .cd-pl-share`)],
        // The premiere row reuses .cd-mv-note, whose only other rule is scoped
        // to .cd-card-lisa — so on any other card it falls back to a browser
        // default and renders as a blue underlined link. That is how it first
        // shipped here, and a contrast reading is what catches it.
        ['premiere', document.querySelector(`.${c.cls} .cd-mv-note`)],
      ].filter(([, el]) => el).map(([name, el]) => ({
        name, ink: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor,
      })),
      ground: (() => {
        for (let n = document.querySelector('.' + c.cls); n; n = n.parentElement) {
          const col = getComputedStyle(n).backgroundColor;
          const a = (col.match(/[\d.]+/g) || [])[3];
          if (col && col !== 'transparent' && (a === undefined || Number(a) > 0.9)) return col;
        }
        return 'rgb(0, 0, 0)';
      })(),
      post:  T.post(),
    };
  }, { key: card.key, cls: card.cls, noteId: card.noteId }, { timeout: 25000 })).jsonValue();
  await ctx.close();
  return got;
};

// Relative luminance, so "is this readable on its own card" is measured rather
// than eyeballed. The 4.5:1 line is WCAG AA for body text.
// Takes a CSS colour string or an already-parsed [r,g,b] — `over` returns the
// latter and is composited twice (wash onto card, then ink onto that).
const parse = (c) => Array.isArray(c) ? c : (c.match(/[\d.]+/g) || ['0', '0', '0']).map(Number);
// Source-over: the pill's translucent wash onto the card's opaque ground.
const over = (fg, bg) => {
  const f = parse(fg), b = parse(bg);
  const a = f.length > 3 ? f[3] : 1;
  return [0, 1, 2].map((i) => f[i] * a + b[i] * (1 - a));
};
const lum = (rgb) => {
  const [r, g, b] = rgb.map((v) => { const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

for (const card of CARDS) {
  const before = await at(card, '2026-11-19T09:00:00Z');
  const after  = await at(card, '2026-11-22T12:00:00Z');

  console.log(`\n--- ${card.song}: rendered, on each side of its release`);
  check(before.live === false && after.live === true,
        'the two samples really do straddle the release', `${before.live} → ${after.live}`);
  check(before.shown === card.want.length,
        `all ${card.want.length} pills are visible without opening anything`,
        `${before.shown} of ${card.want.length}`);
  check(/fill up|pre-save/i.test(before.note) && !/is out/i.test(before.note),
        'before: it does not say the song is out', before.note);
  check(/is out/i.test(after.note), 'after: it says the song is out', after.note);

  // Sun Showers' note must also say these are not its own, because unlike
  // Power Trip's it has no divider to show it.
  if (card.dividerAfter === null) {
    check(/alongside the other/i.test(before.note) && /alongside the other/i.test(after.note),
          '  and on both sides it says whose they also are', before.note);
  }

  // What a reader actually sees: each element's own wash composited over the
  // card's opaque ground, with its ink on top. AA for body text is 4.5:1, and
  // this is 0.62-0.64rem type, so the bar is the body one rather than the
  // large-text 3:1.
  //
  // This is the check that catches a bright card inheriting the component's
  // light-on-dark defaults, which is the single most likely way this block
  // breaks when it is dropped onto the next release — and it has to cover all
  // three elements, because only the pills read the palette variables.
  for (const p of before.parts) {
    // The INK has an alpha too — the note's is rgba(…,0.6) and the Sun Showers
    // override is rgba(…,0.72). Measuring the raw rgb ignores that and reports
    // the ratio of a colour nobody sees: it returned 18.9:1 for the note on a
    // near-black card, which is the theoretical maximum for white on black and
    // not what 60%-opacity white does. So both layers are composited.
    const seen = over(p.bg, before.ground);
    const ratio = contrast(over(p.ink, seen), seen);
    check(ratio >= 4.5, `  the ${p.name} reads on the card it is actually on`,
          `${ratio.toFixed(1)}:1 — ${p.ink} over ${p.bg} on ${before.ground}`);
  }

  console.log(`--- ${card.song}: the shared post carries them, read off the card`);
  const missing = card.want.filter(([, id]) => !(before.post || '').includes(id));
  check(before.post && !missing.length, 'every playlist is in the post',
        missing.map(([n]) => n).join(', '));
  check(!/is out/i.test(before.post || ''), '  before the release it does not say the song is out');
  check(/is out/i.test(after.post || ''), '  after it does',
        (after.post || '').split('\n')[1]);
  check((before.post || '').includes(card.path),
        '  and it links back to the card', card.path);
}

await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nAll correct.');
process.exit(fails ? 1 : 0);
