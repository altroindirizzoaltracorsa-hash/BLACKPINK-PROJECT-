// THE FOUR COUNTING PATHS MUST AGREE ABOUT WHO AN ARTIST STRING IS.
//
// Run: node .github/scripts/test_artist_credit_parity.mjs
//
// WHAT WENT WRONG, found 2026-11-21 while probing Power Trip. One fan's plays
// carried TWO artist strings for the same song:
//
//     ARTISTS  {'Jennie': 20, 'JENNIE, Grand Theft Auto VI': 20}
//
// Three of the four paths compare the artist with `includes` and counted both.
// The CLIENT'S LISTENBRAINZ path used an exact map lookup (_lbMemberKey) and
// dropped the GTA-credited half. So a fan with a ListenBrainz account linked
// saw half their Power Trip plays on the badges page while the cron counted
// all of them — and the two then disagreed about the same fan depending on
// which wrote last. Same shape as the *_all sums that stopped at `lwm`: not a
// crash, not a log line, just two numbers that are each wrong somewhere else.
//
// THE CHECK IS PARITY, NOT A SPELLING LIST. Pinning "this function returns
// jennie for this string" would pass while the other side disagreed, which is
// precisely the failure. So this drives the CLIENT matcher in a real browser
// and the SERVER matcher in Node over the same credits, and requires the same
// answer from both.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { readFile as readFileP } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from './_playwright.mjs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };
const check = (c, m, d) => (c ? ok(m, d) : bad(m, d));

// ── The credits to test, and why each one is here ──────────────────────────
// Every entry is either a string seen on a real scrobble or a near-miss that
// a substring fallback could plausibly get wrong.
const CREDITS = [
  // Seen on real scrobbles. The second is the one that was being dropped.
  ['Jennie',                      'jennie', 'the plain credit'],
  ['JENNIE, Grand Theft Auto VI', 'jennie', 'THE BUG: a multi-artist credit'],
  ['JISOO',                       'jisoo',  'plain, from the Sun Showers scrobbles'],
  ['ROSÉ',                        'rose',   'accented'],
  ['Rose',                        'rose',   'unaccented — scrobblers send both'],
  ['LISA',                        'lisa',   'plain'],
  ['LALISA MANOBAL',              'lisa',   'the full name, already in the map'],
  // Near-misses a raw substring fallback would get wrong.
  ['Rosenberg',                   null,     'rose inside a longer word must NOT match'],
  ['Primrose',                    null,     'nor at the end of one'],
  ['Lisandro',                    null,     'nor lisa inside another name'],
  // Degenerate input.
  ['',                            null,     'empty'],
];

// ── The server matcher, from the real module ───────────────────────────────
const src = readFileSync(ROOT + '/api/cron-scrobbles.js', 'utf8');
for (const line of ["import { Redis } from '@upstash/redis';",
                    "import { createClient } from '@supabase/supabase-js';"]) {
  if (!src.includes(line)) {
    console.log(`  FAIL harness: expected import not found: ${line}`);
    process.exit(1);
  }
}
let built = src
  .replace("import { Redis } from '@upstash/redis';", '')
  .replace("import { createClient } from '@supabase/supabase-js';", '');
built = `const Redis = { fromEnv: () => ({}) };\nconst createClient = () => ({});\n` + built
      + `\nexport { countByTrack, TRACKS };\n`;
const dir = mkdtempSync(join(tmpdir(), 'bu-parity-'));
const modPath = join(dir, 'cron.mjs');
writeFileSync(modPath, built);
const mod = await import('file://' + modPath);
check(typeof mod.countByTrack === 'function', 'harness built the server matcher');

// ── The client matcher, in a real browser ──────────────────────────────────
const SPA = /^\/(countdowns|voting|vote|streams|charts|badges|leaderboard|account|feedback)(\/|$)/;
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const file = p === '/' ? '/index.html' : SPA.test(p) ? '/index.html' : p;
  try {
    const b = await readFileP(ROOT + file);
    const e = file.split('.').pop();
    res.writeHead(200, { 'content-type': { html: 'text/html', js: 'text/javascript', css: 'text/css',
      json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
      webp: 'image/webp', mp4: 'video/mp4' }[e] || 'application/octet-stream' });
    res.end(b);
  } catch { res.writeHead(404); res.end('{}'); }
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
// serviceWorkers blocked: its controllerchange reload destroys the execution
// context mid-evaluate, which is a documented flake in this suite.
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 430, height: 950 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
await page.addInitScript(() => { try { localStorage.setItem('bu_tutorial_seen', '1'); } catch (e) {} });
await page.goto(base + '/badges', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

// The track each credit is tested with: the member's own campaign track, so
// the title gate the matcher is always paired with is satisfied.
const TRACK_FOR = { jennie: 'Power Trip', jisoo: 'Sun Showers', rose: 'new trick', lisa: 'SaWaDiKa' };

const clientSays = await page.evaluate(({ credits, trackFor }) => {
  const out = {};
  for (const [credit, want] of credits) {
    // The member key itself …
    const key = _lbMemberKey(credit);
    // … and, more importantly, whether a LISTEN with this credit actually
    // lands on a track. The key is an implementation detail; the count is
    // what a fan sees.
    const title = trackFor[want] || 'Power Trip';
    const counts = countLbByTrack([{ track_metadata: { track_name: title, artist_name: credit } }]);
    const landed = Object.entries(counts).filter(([, n]) => n > 0).map(([id]) => id);
    out[credit] = { key, landed };
  }
  return out;
}, { credits: CREDITS.map(([c, w]) => [c, w]), trackFor: TRACK_FOR });

// ── 1. the client agrees with what each credit should mean ─────────────────
console.log('--- the browser matcher reads each credit');
for (const [credit, want, why] of CREDITS) {
  const got = clientSays[credit].key;
  check(got === want, `${JSON.stringify(credit)} → ${JSON.stringify(got)}`, why);
}

// ── 2. and a listen with that credit actually lands on the track ───────────
// The key being right is not the point; the play being counted is.
console.log('--- and a listen carrying it is counted');
for (const [credit, want] of CREDITS) {
  if (!want) continue;
  const landed = clientSays[credit].landed;
  check(landed.length === 1, `${JSON.stringify(credit)} lands on exactly one track`,
        landed.join(', ') || 'NOTHING — this play would be invisible');
}

// ── 3. THE PARITY CHECK ────────────────────────────────────────────────────
// The server counts the same listens. Where the two disagree, a fan's number
// depends on which side wrote last — which is the bug, not a detail.
console.log('--- and the server counts the same credits the same way');
for (const [credit, want] of CREDITS) {
  const title = TRACK_FOR[want] || 'Power Trip';
  const serverCounts = mod.countByTrack([{ name: title, artist: { '#text': credit } }]);
  const serverLanded = Object.entries(serverCounts).filter(([, n]) => n > 0).map(([id]) => id);
  const clientLanded = clientSays[credit].landed;
  check(JSON.stringify(serverLanded) === JSON.stringify(clientLanded),
        `${JSON.stringify(credit)}: client and server agree`,
        `client [${clientLanded}] vs server [${serverLanded}]`);
}

await browser.close();
server.close();
console.log('');
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log('All correct.');
