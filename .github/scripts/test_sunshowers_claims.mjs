// The Sun Showers card says what is known and not one word more.
//
// Run: node .github/scripts/test_sunshowers_claims.mjs
//
// WHY. The Hollywood Reporter's exclusive says JISOO CO-WROTE an original
// song, "Sun Showers", for The Angry Birds Movie 3. It does not say she
// performs it, and it gives no release date. Two unknowns, and a card is a
// very easy place to quietly resolve both — "JISOO's new song, out soon" reads
// naturally and asserts two things nobody has said.
//
// This site has already made the mirror-image mistake. The Steps card claimed
// Jennie "wrote and performs" a song the HMMA nominee list credits to Justin
// Tranter, Julia Michaels and Jason Gill — and that claim survived an edit to
// the very sentence it sat in, because the edit was about the release date and
// nobody re-read the clause before it. There the writing credit was invented;
// here the performing credit is the one at risk. Same failure, opposite half.
//
// THE DISCLAIMER CONTAINS THE WORD IT IS GUARDING AGAINST. The card says
// "Whether she also performs it has not been said" — so a check that simply
// refuses /performs/ fails on the correct copy, and a check that simply
// requires it passes on "JISOO performs Sun Showers". A substring that occurs
// in both the claim and its denial cannot test either. So the disclaimer is
// matched and REMOVED first, and only then is the remaining text searched for
// a performance verb.
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../..', import.meta.url).pathname;
let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };

const site = readFileSync(root + 'index.html', 'utf8');

// The card, by its slug. Not found is a failure, never a skip.
const m = site.match(/<div class="cd-card cd-card-sunshowers"[^>]*>([\s\S]*?)\n          <\/div>\n/);
if (!m) {
  console.log('  FAIL the Sun Showers card is not in index.html (or its markup moved — fix this test)');
  process.exit(1);
}
const cardTag  = site.match(/<div class="cd-card cd-card-sunshowers"[^>]*>/)[0];
const cardHtml = m[0];
// Visible words only: the long comment above the card explains the rule using
// the very words the rule forbids, so searching the raw markup would fail on
// its own documentation.
const text = cardHtml
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
ok('found the card', `${text.length} visible chars`);

console.log('\n--- what IS known is said');
/co-?writ/i.test(text)
  ? ok('it says she co-wrote the song')
  : bad('it says she co-wrote the song', 'the one credit we actually have is missing');
/sun showers/i.test(text)   ? ok('it names the song')  : bad('it names the song');
/angry birds movie 3/i.test(text) ? ok('it names the film') : bad('it names the film');
/shumon/i.test(text)
  ? ok('it keeps the Shumon detail', 'the dustball she drew in middle school')
  : bad('it keeps the Shumon detail');
/hollywood reporter/i.test(text)
  ? ok('it attributes the report')
  : bad('it attributes the report', 'an exclusive is not an official announcement');

console.log('\n--- what is NOT known is not claimed');

// 1. THE PERFORMANCE CLAIM. Remove the disclaimer, then nothing about
//    performing may remain.
const DISCLAIMER = /whether she also \*{0,2}performs\*{0,2} it has not been said/i;
const hasDisclaimer = DISCLAIMER.test(text);
hasDisclaimer
  ? ok('it says plainly that we do not know if she performs it')
  : bad('it says plainly that we do not know if she performs it',
        'the disclaimer is gone — readers will assume she sings it');
const stripped = text.replace(DISCLAIMER, ' ');
const PERF = /\b(performs?|performed|performing|sings?|sung|singing|vocals?|her vocal)\b/i;
const hit = stripped.match(PERF);
hit
  ? bad('and claims nothing about her performing it', `"${hit[0]}" appears outside the disclaimer`)
  : ok('and claims nothing about her performing it');

// 2. THE DATE. No timer, because there is no date to count to.
/data-target\s*=/.test(cardTag)
  ? bad('the card carries no countdown target', 'a date was invented to make the timer work')
  : ok('the card carries no countdown target');
// And no date in the copy either — a month or a year reads as a release date
// on a countdown card whatever sentence it sits in.
const DATEY = /\b(20\d\d|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;
// "middle school" is the one time span the card is allowed to mention.
const dateHit = text.replace(/middle school/ig, ' ').match(DATEY);
dateHit
  ? bad('and names no date', `"${dateHit[0]}" is on the card`)
  : ok('and names no date');
/not announced|has not been said|nothing to count down/i.test(text)
  ? ok('and says outright that the date is unknown')
  : bad('and says outright that the date is unknown', 'a card with no timer and no explanation reads as broken');

// 3. No pre-save button, because there is no link to pre-save at.
/<a[^>]+class="[^"]*cd-btn/.test(cardHtml)
  ? bad('it offers no pre-save link', 'there is no campaign to link to yet')
  : ok('it offers no pre-save link');

console.log('\n--- the artwork is really in the repo');
const art = (cardHtml.match(/src="(\/sunshowers\/[^"]+)"/) || [])[1];
art ? ok('the card points at an artwork file', art) : bad('the card points at an artwork file');
if (art) {
  existsSync(root + art.slice(1))
    ? ok('and that file exists', art)
    : bad('and that file exists', `${art} is referenced and not committed`);
}
const og = readFileSync(root + 'middleware.js', 'utf8')
  .match(/sunshowers:\s*\{[\s\S]*?image:\s*'([^']+)'/);
og ? ok('the share preview names an image', og[1]) : bad('the share preview names an image');
if (og) {
  existsSync(root + og[1].slice(1))
    ? ok('and that file exists', og[1])
    : bad('and that file exists', `${og[1]} is referenced and not committed`);
}

// The link preview is read far more often than the card, and by people who
// never reach the page. Same two rules apply to it.
console.log('\n--- and the share preview makes the same two claims, no more');
{
  const mw = readFileSync(root + 'middleware.js', 'utf8');
  const blk = (mw.match(/sunshowers:\s*\{[\s\S]*?\n  \},/) || [''])[0]
    .replace(/\/\/[^\n]*/g, ' ');
  /co-?writ/i.test(blk) ? ok('the preview says co-written') : bad('the preview says co-written');
  const pStripped = blk.replace(/whether she performs it[^."]*/i, ' ')
                       .replace(/it has not been said whether she performs it/i, ' ');
  const pHit = pStripped.match(PERF);
  pHit ? bad('the preview claims nothing about performing', `"${pHit[0]}"`)
       : ok('the preview claims nothing about performing');
  const pDate = blk.replace(/sunshowers|sun-showers|og-countdown-sunshowers/ig, ' ').match(DATEY);
  pDate ? bad('the preview names no date', `"${pDate[0]}"`) : ok('the preview names no date');
}

console.log(fails ? `\n${fails} FAILED` : '\nAll correct.');
process.exit(fails ? 1 : 0);
