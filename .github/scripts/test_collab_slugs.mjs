// The ballot category slugs have to mean the same thing in three files.
//
// Run: node .github/scripts/test_collab_slugs.mjs
//
// A vote is matched by slug AND nominee name: the extension reads both off
// kca.nick.tv, posts the slug, the API stores it, and /collabs sums by it. So
// three separate files carry the same strings:
//
//   vote-extension/background.js  COLLAB.nominees   — what the counter records
//   collabs.html                  COLLABS[].slug    — what the page sums
//   index.html                    KCA_CATEGORIES    — the Kids' Choice board
//
// Drift between them does not throw and does not look wrong. It silently
// counts nothing: a slug the page does not know lands in no total, and a
// nominee name that does not match the ballot never matches at all. Both read
// on the page as "the collab has no votes", which is the hardest kind of bug
// to notice because it is also what an honest empty board looks like.
import { readFileSync } from 'node:fs';

const root = new URL('../..', import.meta.url).pathname;
let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

// Pull one top-level literal out of a file and evaluate it. Deliberately not a
// regex over the contents: these are hand-edited lists and the point is to
// compare what the code actually holds, not what a pattern can scrape.
function literal(file, decl) {
  const src = readFileSync(root + file, 'utf8');
  const at = src.indexOf(decl);
  if (at < 0) throw new Error(`${decl} not found in ${file}`);
  const open = src.indexOf(decl.endsWith('[') ? '[' : '{', at + decl.length - 1);
  let depth = 0, i = open, inStr = null, prev = '';
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === inStr && prev !== '\\') inStr = null;
    } else if (ch === '"' || ch === "'" || ch === '`') inStr = ch;
    else if (ch === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; }
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') { depth--; if (!depth) { i++; break; } }
    prev = ch;
  }
  return new Function('return (' + src.slice(open, i) + ')')();
}

const COLLAB = literal('vote-extension/background.js', 'const COLLAB = {');
// The Android app carries its own copy, in Kotlin, for phones that cannot run
// extensions. A third copy is a third chance to drift, and the app's failure
// mode is the worst of the three: it is installed, not loaded from the site, so
// a wrong slug there keeps counting nothing until somebody reinstalls.
const APP = readFileSync(root + 'android-app/app/src/main/java/com/blinksunited/votecounter/KcaVoteParser.kt', 'utf8');
function appPairs(block) {
  const at = APP.indexOf(block);
  if (at < 0) throw new Error(`${block} not found in KcaVoteParser.kt`);
  const end = APP.indexOf(')', APP.indexOf('mapOf(', at));
  const body = APP.slice(at, APP.indexOf('\n    )', at));
  const out = {};
  for (const m of body.matchAll(/"([a-z0-9-]+)" to \(?"([^"]+)"/g)) out[m[1]] = m[2];
  return out;
}
const COLLABS = literal('collabs.html', 'var COLLABS = [');
const KCA_CATEGORIES = literal('index.html', 'const KCA_CATEGORIES = [');

const page = COLLABS.find((c) => c.id === COLLAB.id);
check(!!page, `collabs.html has the collab the extension posts to (${COLLAB.id})`);
if (!page) { console.log(`\nFAILURES: ${fails.length}`); process.exit(1); }

const picks = page.theyGive.concat(page.weGive);

console.log('--- every category the page shows, the counter records');
for (const p of picks) {
  const got = COLLAB.nominees[p.slug];
  check(!!got, `the counter knows ${p.slug}`, got || 'missing from COLLAB.nominees');
  if (got) {
    check(got === p.nominee, `and calls ${p.slug} the same thing`,
          got === p.nominee ? p.nominee : `extension "${got}" vs page "${p.nominee}"`);
  }
}

console.log('--- and records nothing the page would not count');
// A slug the counter posts that the page does not know lands in no total at
// all: it would be written, charged against nobody, and invisible.
for (const slug of Object.keys(COLLAB.nominees)) {
  check(picks.some((p) => p.slug === slug), `the page counts ${slug}`,
        picks.some((p) => p.slug === slug) ? '' : 'the page has no such category');
}

console.log('--- our own three still agree with the Kids’ Choice board');
// These three are counted twice over, in two tables, and the nominee string is
// what matches a pick to a nominee in both. If one copy drifts, one of the two
// boards quietly stops counting a member.
for (const p of page.theyGive) {
  const kca = KCA_CATEGORIES.find((k) => k.slug === p.slug);
  check(!!kca, `${p.slug} is a Kids’ Choice category`, kca ? '' : 'not in KCA_CATEGORIES');
  if (kca) {
    check(kca.nominee === p.nominee, `${p.slug}: the nominee string matches index.html`,
          kca.nominee === p.nominee ? p.nominee : `board "${kca.nominee}" vs collab "${p.nominee}"`);
    check(kca.who === p.who, `${p.slug}: and so does the artist`,
          kca.who === p.who ? p.who : `board "${kca.who}" vs collab "${p.who}"`);
  }
}

console.log('--- the partner’s category is NOT one of ours');
// The whole premise. If BINI's category were also one BLACKPINK is up for,
// there would be no trade to make, and the counter would be posting a vote for
// a rival in a category we are in.
for (const p of page.weGive) {
  check(!KCA_CATEGORIES.some((k) => k.slug === p.slug),
        `${p.slug} is not a category we have a nominee in`);
}

console.log('--- and the Android app agrees with both');
const appCollab = appPairs('private val COLLAB_NOMINEES');
const appMine = appPairs('private val KCA_NOMINEES');
for (const p of picks) {
  check(appCollab[p.slug] === p.nominee, `the app counts ${p.slug} for the collab`,
        appCollab[p.slug] ? (appCollab[p.slug] === p.nominee ? p.nominee
          : `app "${appCollab[p.slug]}" vs page "${p.nominee}"`) : 'missing');
}
for (const p of page.theyGive) {
  check(appMine[p.slug] === p.nominee, `and counts ${p.slug} for the Kids’ Choice board`,
        appMine[p.slug] ? (appMine[p.slug] === p.nominee ? p.nominee
          : `app "${appMine[p.slug]}" vs page "${p.nominee}"`) : 'missing');
}
for (const p of page.weGive) {
  check(!appMine[p.slug], `and does NOT count ${p.slug} as ours`,
        appMine[p.slug] ? `the app would post a ${appMine[p.slug]} pick to the BLACKPINK board` : '');
}
const appUntil = (APP.match(/COLLAB_UNTIL_MS = (\d+)L/) || [])[1];
check(appUntil && Number(appUntil) === Date.parse(page.deadline),
      'and stops at the same moment', appUntil ? new Date(Number(appUntil)).toISOString() : 'not found');
const appId = (APP.match(/COLLAB_ID = "([^"]+)"/) || [])[1];
check(appId === COLLAB.id, 'and posts to the same collab', appId || 'not found');

console.log('--- and matches a nominee the same way');
// The names agreeing is not enough on its own: the ballot writes BINI as
// "Asia: BINI", so a counter comparing titles EXACTLY drops every pick while
// still holding the right string. The extension was fixed for that; an app
// left on exact matching would carry the same bug, agree with every check
// above, and count nothing — which is exactly how this was found.
const EXT = readFileSync(root + 'vote-extension/background.js', 'utf8');
for (const [src, label] of [[EXT, 'the extension'], [APP, 'the app']]) {
  // The prefix-tolerant compare: take everything after the first colon and
  // compare it WHOLE. Both files must have it, and neither may compare titles
  // with a bare equality on the normalised whole string alone.
  const tolerant = /indexOf\(':'\)/.test(src) && /(slice|substring)\(i \+ 1\)/.test(src);
  check(tolerant, `${label} tolerates the ballot's region prefix`,
        tolerant ? '' : 'titles are compared exactly — "Asia: BINI" would count for nobody');
  const reports = /nearMiss|NearMiss/.test(src);
  check(reports, `${label} reports a nominee the ballot has renamed`,
        reports ? '' : 'a dropped pick would be silent again');
}

console.log('--- the two sides a person can say they are');
// The key is what gets stored and counted. A key only the counter knows counts
// nobody — the board would simply never see that side — and a key only the
// page knows draws a column that can never fill. Same class of silent drift as
// the category slugs above, with the same symptom: an honest-looking zero.
const pageFandoms = page.fandoms || [];
const extFandoms = COLLAB.fandoms || [];
check(pageFandoms.length > 0, 'the page defines the sides', pageFandoms.map((f) => f.key).join(', '));
check(extFandoms.length === pageFandoms.length,
      'and the counter offers the same number of them', `${extFandoms.length} vs ${pageFandoms.length}`);
for (const f of pageFandoms) {
  check(extFandoms.some((x) => x.key === f.key), `the counter knows ${f.key}`,
        extFandoms.map((x) => x.key).join(', '));
}
for (const f of extFandoms) {
  check(pageFandoms.some((x) => x.key === f.key), `the page counts ${f.key}`,
        pageFandoms.map((x) => x.key).join(', '));
}
// The app carries a fourth copy, in Kotlin, and its failure mode is the worst:
// it is installed rather than loaded from the site, so a side it does not know
// counts nobody until somebody reinstalls.
for (const f of extFandoms) {
  const inApp = new RegExp(`"${f.key}" to "`).test(APP);
  check(inApp, `and the app offers ${f.key}`, inApp ? '' : 'not in KcaVoteParser.FANDOMS');
}
const appSends = /put\("fandom", fandom\)/.test(
  readFileSync(root + 'android-app/app/src/main/java/com/blinksunited/votecounter/VoteApi.kt', 'utf8'));
check(appSends, 'and actually sends it with the collab post',
      appSends ? '' : 'the chooser would store a side and post nothing');

// The panel has its own copy, because a content script cannot import from the
// service worker — a third place for the same strings to drift.
const PANEL = readFileSync(root + 'vote-extension/panel.js', 'utf8');
for (const f of extFandoms) {
  const inPanel = new RegExp(`key:\\s*'${f.key}'`).test(PANEL);
  check(inPanel, `and the panel offers ${f.key} to click`, inPanel ? '' : 'not in KCA_FANDOMS');
}

console.log('--- the window the counter will post in');
const until = COLLAB.until;
check(Number.isFinite(until), 'the extension has a closing time', new Date(until).toISOString());
check(until === Date.parse(page.deadline), 'and it is the page’s deadline to the second',
      until === Date.parse(page.deadline) ? new Date(until).toISOString()
        : `${new Date(until).toISOString()} vs ${page.deadline}`);
check(/^https:\/\/(www\.)?blinksunited\.com\/api\/collabs$/.test(COLLAB.endpoint),
      'and posts to the collab endpoint, not the vote board', COLLAB.endpoint);

console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
