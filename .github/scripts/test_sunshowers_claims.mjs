// The Sun Showers card says what is known and not one word more.
//
// Run: node .github/scripts/test_sunshowers_claims.mjs
//
// WHY. JISOO co-wrote AND performs "Sun Showers", an original song for The
// Angry Birds Movie 3, and the pre-save is open. What is still not announced
// is the RELEASE DATE — confirmed at the source, not assumed: the
// distributor's own pre-save page carries releaseDateInfo.date = null.
//
// So the rule has now flipped for BOTH halves, one at a time, and each flip
// is written down here because a check whose meaning silently inverts is
// worse than no check.
//   · The performing credit was unknown when this card shipped and this file
//     FORBADE claiming it; it was confirmed, so the file REQUIRES it.
//   · The date was unknown and this file FORBADE naming one. It is announced
//     for 20 Nov 2026, so the file now REQUIRES the card to carry it — and
//     requires it to be the SAME date in all four places (card, share card,
//     shared caption, link preview), because four copies of a date is four
//     chances for one of them to be stale.
// What has NOT flipped is the hour: a date was given, a time was not, so the
// card counts to the reader's own midnight and must name no clock time.
//
// This site has already made the mirror-image mistake. The Steps card claimed
// Jennie "wrote and performs" a song the HMMA nominee list credits to Justin
// Tranter, Julia Michaels and Jason Gill — and that claim survived an edit to
// the very sentence it sat in, because the edit was about the release date and
// nobody re-read the clause before it. There the writing credit was invented;
// here the performing credit is the one at risk. Same failure, opposite half.
//
// THE DATE HALF STILL HAS THE HARD CASE. "Release date not announced" and a
// real date both contain date-ish words, so the check strips the one phrase
// the card is allowed to say and then refuses any month or year in what is
// left — rather than grepping for a string that appears in both the claim and
// its denial.
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
/co-?(writ|wrote)/i.test(text)
  ? ok('it says she co-wrote the song')
  : bad('it says she co-wrote the song');
/\b(performs?|sings?)\b/i.test(text)
  ? ok('and that she performs it', 'confirmed, so the card says so')
  : bad('and that she performs it', 'it is her song and the card no longer says so');
/sun showers/i.test(text)   ? ok('it names the song')  : bad('it names the song');
/angry birds movie 3/i.test(text) ? ok('it names the film') : bad('it names the film');
/shumon/i.test(text)
  ? ok('it keeps the Shumon detail', 'the dustball she drew in middle school')
  : bad('it keeps the Shumon detail');
/hollywood reporter/i.test(text)
  ? ok('it attributes the report')
  : bad('it attributes the report', 'an exclusive is not an official announcement');

console.log('\n--- what is NOT known is not claimed');

// And nothing may re-introduce the old hedge, which is now false.
const HEDGE = /whether she (also )?(performs?|sings?)[^.]*not been said|not( been)? (said|confirmed|clear) (whether|if) she/i;
HEDGE.test(text)
  ? bad('the old "we do not know if she sings it" hedge is gone', 'it is back, and it is now untrue')
  : ok('the old "we do not know if she sings it" hedge is gone');

// 2. THE DATE — 20 Nov 2026, announced, so this half is inverted. See header.
const DATEY = /\b(20\d\d|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;
const DAY = '2026-11-20';
// MIDNIGHT ON THE READER'S OWN CLOCK, because a date was given and an hour
// was not. data-target alone would count every reader to one instant nobody
// announced; Date.parse('2026-11-20') is UTC midnight, which is most of a day
// early in the Americas.
(cardTag.match(/data-target-local="([^"]+)"/) || [])[1] === DAY
  ? ok('the card counts to the reader\'s own midnight on Nov 20', 'data-target-local')
  : bad('the card counts to the reader\'s own midnight on Nov 20',
        'without data-target-local the clock runs to one worldwide instant nobody gave');
// The floor for anything reading this card without the local rule. It has to
// be the SAME DAY — a fallback on the wrong date is worse than none, because
// nothing reports it.
new RegExp('data-target="' + DAY + 'T\\d\\d:\\d\\d:\\d\\dZ"').test(cardTag)
  ? ok('  with a same-day floor for readers of data-target')
  : bad('  with a same-day floor for readers of data-target', 'liveCountdownFor ranks on it');
// The date is allowed on the card now; an HOUR is not, because none was
// announced. This is the half that did not flip.
{
  const hour = text.match(/\b\d{1,2}\s*(?:AM|PM)\b|\b\d{1,2}:\d{2}\b|\b(?:KST|EST|EDT|PST|PDT|CET|UTC|GMT)\b/i);
  hour ? bad('and names no release hour', `"${hour[0]}" — no time has been announced`)
       : ok('and names no release hour');
}
/nov(ember)?\s*20/i.test(text)
  ? ok('and the date it names is the one that was announced')
  : bad('and the date it names is the one that was announced', 'Nov 20 is not in the copy');
// An unexplained clock is a time claim with no source: the reader cannot see
// what it counts to, so the card has to say.
/midnight where you are/i.test(text)
  ? ok('and says what the clock is counting to')
  : bad('and says what the clock is counting to', 'the timer silently asserts an hour');
// The old wording must be gone, not merely outnumbered.
/not announced|nothing to count down/i.test(text.replace(/no release time has been announced/ig, ' '))
  ? bad('and the "no date announced" copy is gone', 'the card contradicts its own timer')
  : ok('and the "no date announced" copy is gone');

// 3. THE PRE-SAVE, which now exists. Exact URL, no tracking tail: this repo
//    strips ?si=/?is=/utm_* everywhere else and a pre-save link is the one
//    most likely to arrive carrying one.
const PRESAVE = 'https://JISOO.lnk.to/SunShowers';
const btn = cardHtml.match(/<a[^>]+class="[^"]*cd-btn[^"]*"[^>]*href="([^"]+)"[^>]*>/)
         || cardHtml.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*cd-btn/);
btn ? ok('it offers the pre-save', btn[1]) : bad('it offers the pre-save', 'the button is gone');
if (btn) {
  btn[1] === PRESAVE
    ? ok('and the link is the official one, clean', PRESAVE)
    : bad('and the link is the official one, clean', `got ${btn[1]}`);
  /[?&](si|is|utm_|_r|_t|ref)=/i.test(btn[1])
    ? bad('and carries no tracking parameters', btn[1])
    : ok('and carries no tracking parameters');
}
/onclick="saveSunShowers\(\)"/.test(cardHtml)
  ? ok('and the tap is counted', 'saveSunShowers()')
  : bad('and the tap is counted', 'the button does not call saveSunShowers(), so the bar and badge never move');


// The share card is a canvas, so what it PRINTS is pinned in a real browser by
// test_sunshowers_share.mjs — that one spies on fillText and reads the strings
// back. What is checked here is only what a file read can answer: that the
// button exists, that the pictures it offers are committed, and that the data
// handed to the renderer carries no date for it to count to.
console.log('\n--- the share card is wired and offers only committed pictures');
/onclick="openSunShowersCard\(\)"/.test(cardHtml)
  ? ok('the card has a share button', 'openSunShowersCard()')
  : bad('the card has a share button', 'the 📸 Share button is missing or calls something else');

// Comments stripped here too — a note inside the list saying why there is no
// focalBias would otherwise fail the check that there is no focalBias.
const picsBlock = (site.match(/const SUNSHOWERS_CARD_PICS = \[[\s\S]*?\n\];/) || [''])[0]
  .replace(/\/\/[^\n]*/g, ' ');
const picUrls = [...picsBlock.matchAll(/url:\s*'([^']+)'/g)].map(x => x[1]);
picUrls.length
  ? ok('it lists share-card pictures', `${picUrls.length}`)
  : bad('it lists share-card pictures', 'SUNSHOWERS_CARD_PICS is empty or moved');
for (const u of picUrls) {
  existsSync(root + u.slice(1))
    ? ok('and that file exists', u)
    : bad('and that file exists', `${u} is offered on the picker and not committed`);
}

// NOTHING IS CROPPED, and the picture list is where that would come back.
// A crop anchor only exists to answer "which part do we keep", so a focalBias
// on any of these pictures means the card went back to cutting one of them —
// and on the sleeve, whose cast runs along the bottom edge, what it cuts first
// is Shumon. landscapeOnly likewise: it exists to hide a picture whose crop
// would be unacceptable in one shape, and an uncropped picture has none.
/focalBias/.test(picsBlock)
  ? bad('no picture carries a crop anchor', 'a focalBias is back, so something is being cropped again')
  : ok('no picture carries a crop anchor');
/landscapeOnly/.test(picsBlock)
  ? bad('and none is hidden from a shape', 'landscapeOnly is back; uncropped pictures work in both')
  : ok('and none is hidden from a shape');

// Comments stripped, for the same reason the card's visible text is read
// without them: this function explains the rules using the very words the
// rules forbid ("no focalBias because there is no crop to anchor"), so a
// search over the raw source fails on its own documentation. That is not
// hypothetical — it failed exactly that way the first time this ran.
const openFn = (site.match(/async function openSunShowersCard\(\) \{[\s\S]*?\n\}/) || [''])[0]
  .replace(/\/\/[^\n]*/g, ' ');
openFn ? ok('found openSunShowersCard()') : bad('found openSunShowersCard()', 'it moved — fix this test');
/releaseAt:\s*ssReleaseAt\(\)/.test(openFn)
  ? ok('it hands the renderer a release date', 'releaseAt: ssReleaseAt()')
  : bad('it hands the renderer a release date', 'the share card would print RELEASE DATE NOT ANNOUNCED');
// THE READER'S OWN MIDNIGHT, same instant as the card on the page. Built from
// parts: Date.parse('2026-11-20') is UTC midnight, and a share card that
// disagreed with the card it was made from would be wrong by up to a day
// depending only on who pressed the button.
/new Date\(SS_DAY\[0\], SS_DAY\[1\] - 1, SS_DAY\[2\]/.test(site)
  ? ok('  built from parts, not Date.parse of a date string')
  : bad('  built from parts, not Date.parse of a date string',
        "Date.parse('2026-11-20') is UTC midnight — hours early in the Americas");
/SS_DAY = \[2026, 11, 20\]/.test(site)
  ? ok('  and it is the announced day')
  : bad('  and it is the announced day', 'the share card counts to a different date than the page');
/dateLine:[^\n]*Nov 20, 2026/.test(openFn)
  ? ok('and a date line naming it')
  : bad('and a date line naming it', 'the card prints no date under the title');
{
  const oHour = openFn.match(/\b\d{1,2}\s*(?:AM|PM)\b|\b(?:KST|EST|EDT|PST|PDT)\b/i);
  oHour ? bad('and names no hour either', `"${oHour[0]}"`) : ok('and names no hour either');
}
// THE TITLE HEADS THE TYPE COLUMN ON EVERY PICTURE, including the sleeve that
// letters its own name. That was forbidden while the artwork was the card's
// background — setting it again printed it twice over the same picture — and
// is required now that the picture is a contained object with the type beside
// it rather than over it. Pinned in BOTH places because they are two separate
// assignments: the object the card opens on, and the one each pick rewrites.
/titleText:\s*SS_CARD_TITLE/.test(openFn)
  ? ok('the card opens with the title set')
  : bad('the card opens with the title set', 'the first card drawn has no heading over its type');
{
  const selFn = (site.match(/async function selectSunShowersCardArt\([\s\S]*?\n\}/) || [''])[0]
    .replace(/\/\/[^\n]*/g, ' ');
  /titleText\s*=\s*SS_CARD_TITLE\s*;/.test(selFn)
    ? ok('and every pick keeps it', 'not conditional on the artwork')
    : bad('and every pick keeps it',
          /hasLockup\s*\?/.test(selFn)
            ? 'it is back to being suppressed on artwork that letters its own name'
            : 'selectSunShowersCardArt no longer sets it');
}
/fitWhole:\s*true/.test(openFn)
  ? ok('and asks for the picture whole', 'fitWhole: true')
  : bad('and asks for the picture whole', 'the card is back to cropping a canvas out of the artwork');
/focalBias/.test(openFn)
  ? bad('with no crop anchor', 'a focalBias on a card that crops nothing means it crops something')
  : ok('with no crop anchor');

// ONE BADGE, THREE PLACES. Shumon is the Early Supporter badge on the card's
// chip, in the My Badges row and on the share card — and the share card was
// the one place he was missing, because its stamp falls back to the release's
// wordmark image and this release has none (its sleeve letters its own title).
// The pill came out saying EARLY SUPPORTER with nothing in it.
console.log('\n--- and the Early Supporter badge is Shumon everywhere');
{
  const badgeSrc = (site.match(/const SS_BADGE_IMG\s*=\s*'([^']+)'/) || [])[1];
  badgeSrc ? ok('the badge file is named once', badgeSrc)
           : bad('the badge file is named once', 'SS_BADGE_IMG is gone');
  if (badgeSrc) {
    existsSync(root + badgeSrc.slice(1))
      ? ok('and it exists', badgeSrc)
      : bad('and it exists', `${badgeSrc} is referenced and not committed`);
    // The chip on the card and the My Badges row point at it too. Three
    // copies of a path is how one of them ends up a release behind.
    const uses = [...site.matchAll(/\/sunshowers\/shumon[^"']*/g)].map(m => m[0]);
    uses.length >= 2 && uses.every(u => u === badgeSrc)
      ? ok('and every badge on the site uses that same file', `${uses.length} references`)
      : bad('and every badge on the site uses that same file', `got ${JSON.stringify([...new Set(uses)])}`);
  }
  /emblemImg:\s*shumon/.test(openFn)
    ? ok('the share card hands it to the Early Supporter pill', 'emblemImg: shumon')
    : bad('the share card hands it to the Early Supporter pill', 'the pill is empty — no emblem and no wordmark to fall back on');
  /loadImg\(SS_BADGE_IMG\)/.test(openFn)
    ? ok('and loads it up front', 'the draw is synchronous, so a late fetch misses the frame')
    : bad('and loads it up front', 'nothing fetches the badge before the card is drawn');
  /stampTint:\s*false/.test(openFn)
    ? ok('and leaves him his own colours', 'stampTint: false')
    : bad('and leaves him his own colours', 'the default tint flattens a drawing to one shape');
}

// The film's own lettering. Sent as a reference for the type, not as a
// picture — so what has to survive here is the face and the chrome, and the
// test for it is the wiring, because the glyphs themselves are only visible
// on the canvas (test_sunshowers_share.mjs reads those).
console.log('\n--- and it is set in the film\'s own lettering');
/chrome:\s*SS_CARD_CHROME/.test(openFn)
  ? ok('the card asks for the chrome treatment')
  : bad('the card asks for the chrome treatment', 'the scarlet-and-chrome lettering is gone');
/headFont:\s*SS_CARD_FONT/.test(openFn)
  ? ok('and the heavy condensed face')
  : bad('and the heavy condensed face', 'it fell back to the site default serif');
/const SS_CARD_FONT\s*=\s*'[^']*Anton/.test(site)
  ? ok('which is Anton')
  : bad('which is Anton', 'SS_CARD_FONT no longer names it');
/fonts\.googleapis\.com\/css2\?[^"]*family=Anton[&"]/.test(site)
  ? ok('and Anton is actually loaded', 'same Google Fonts request as the rest, so no extra round trip')
  : bad('and Anton is actually loaded', 'the card asks for a font the page never fetches');
{
  const chromeDef = (site.match(/const SS_CARD_CHROME\s*=\s*\{[^}]*\}/) || [''])[0];
  /ink:/.test(chromeDef) && /rim:/.test(chromeDef) && /fill:/.test(chromeDef)
    ? ok('the chrome keeps all three passes', 'outline, rim, fill')
    : bad('the chrome keeps all three passes', `got: ${chromeDef || 'nothing'}`);
}

// The words posted BESIDE the image. The shared wording is built around a
// date — "is coming {dateShort}" — so an undated release either reads as a
// broken sentence or quietly acquires a date from whatever dateShort holds.
console.log('\n--- and the words posted with the card say the same thing');
{
  // Found WHEREVER it sits in the chain, not assumed to be the first arm:
  // another campaign (leavewithme) was given its own branch above this one and
  // the old "statsText = d.campaign === 'sunshowers'" anchor stopped matching,
  // which reported a branch that was still there as missing.
  const branch = (site.match(/d\.campaign === 'sunshowers'[\s\S]*?\)\n        : d\.earned/) || [''])[0];
  branch
    ? ok('the share text still has its own wording')
    : bad('the share text still has its own wording',
          'it falls through to the shared line, which never mentions the film');
  if (branch) {
    /angry birds movie 3/i.test(branch)
      ? ok('and still names the film, which is the point of having its own')
      : bad('and still names the film, which is the point of having its own');
    // THROUGH dateShort, never written out. A date typed into the caption is a
    // fifth copy that no longer moves when the card's does.
    /\$\{d\.dateShort\}/.test(branch)
      ? ok('and takes the date from the card rather than repeating it')
      : bad('and takes the date from the card rather than repeating it',
            'a literal date here goes stale on its own');
    const sDate = branch.replace(/sunshowers|sun ?showers|angry birds movie 3/ig, ' ').match(DATEY);
    sDate ? bad('  so there is no literal date in it', `"${sDate[0]}"`)
          : ok('  so there is no literal date in it');
    /not announced/i.test(branch.replace(/no release time announced/ig, ' '))
      ? bad('and the old "no date" wording is gone', 'the caption contradicts the card')
      : ok('and the old "no date" wording is gone');
  }
}

console.log('\n--- the artwork is really in the repo');
const art = (cardHtml.match(/src="(\/sunshowers\/[^"]+)"/) || [])[1];
art ? ok('the card points at an artwork file', art) : bad('the card points at an artwork file');
if (art) {
  existsSync(root + art.slice(1))
    ? ok('and that file exists', art)
    : bad('and that file exists', `${art} is referenced and not committed`);
}
const chip = (cardHtml.match(/src="(\/sunshowers\/shumon[^"]*)"/) || [])[1];
chip ? ok('the pre-save badge is Shumon', chip) : bad('the pre-save badge is Shumon', 'the chip image is missing');
if (chip) existsSync(root + chip.slice(1))
  ? ok('and that file exists', chip)
  : bad('and that file exists', `${chip} is referenced and not committed`);
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
  /co-?(writ|wrote)/i.test(blk) ? ok('the preview says co-written') : bad('the preview says co-written');
  /\b(performs?|sings?)\b/i.test(blk)
    ? ok('the preview says she performs it')
    : bad('the preview says she performs it');
  HEDGE.test(blk)
    ? bad('and does not carry the old hedge', 'it is back, and untrue')
    : ok('and does not carry the old hedge');
  // The preview is the half of a shared link people read without clicking, so
  // a date missing here is a link that still says "not announced" days after
  // the card stopped.
  /nov(ember)?\s*20,?\s*2026/i.test(blk)
    ? ok('the preview names the announced date')
    : bad('the preview names the announced date', 'a shared link would still read as undated');
  /not announced/i.test(blk.replace(/no release time announced/ig, ' '))
    ? bad('and not the old "no date" line', 'it contradicts the card')
    : ok('and not the old "no date" line');
}

console.log(fails ? `\n${fails} FAILED` : '\nAll correct.');
process.exit(fails ? 1 : 0);
