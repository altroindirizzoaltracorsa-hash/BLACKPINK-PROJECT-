// A countdown slug has to exist in THREE places, and two of them are silent.
//
// Run: node .github/scripts/test_countdown_slugs.mjs
//
//   index.html    data-slug on the card        — the deep link /countdowns/<slug>
//   middleware.js COUNTDOWNS[slug]             — the link preview when shared
//   middleware.js matcher: '/countdowns/<slug>' — or middleware never RUNS there
//
// The matcher is the trap: its own comment says a `:slug*` wildcard does not
// reliably match, so every slug is listed by hand — and a slug missing from
// that list gets the generic site preview with nothing failing anywhere.
// `newtrick` had a card, and a /countdowns/newtrick link in the hub, and
// neither of the other two, for over a month.
import { readFile, access } from 'node:fs/promises';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const ix = await readFile(ROOT + '/index.html', 'utf8');
const mw = await readFile(ROOT + '/middleware.js', 'utf8');

let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };

const block = (src, start) => {
  const i = src.indexOf(start); if (i < 0) return null;
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(open, j + 1);
  }
  return null;
};

const cdBlock = block(mw, 'const COUNTDOWNS =');
if (!cdBlock) { console.log('  FAIL COUNTDOWNS not found in middleware.js'); process.exit(1); }
// Keys may be quoted ('jisoo.io') or bare (addicted).
const previews = [...cdBlock.matchAll(/^  '?([A-Za-z0-9._-]+)'?:\s*\{/gm)].map(m => m[1]);
const matcher  = [...mw.matchAll(/'\/countdowns\/([^']+)'/g)].map(m => m[1]);
const slugs    = [...ix.matchAll(/<div class="cd-card[^"]*"[^>]*data-slug="([^"]+)"/g)].map(m => m[1]);

console.log(`    ${slugs.length} cards · ${previews.length} previews · ${matcher.length} matcher entries`);
slugs.length ? ok('card slugs parsed', slugs.join(', ')) : bad('card slugs parsed');

const noPreview = slugs.filter(s => !previews.includes(s));
noPreview.length ? bad('every card slug has a link preview', noPreview.join(', '))
                 : ok('every card slug has a link preview');
const noMatch = slugs.filter(s => !matcher.includes(s));
noMatch.length ? bad('every card slug is in the middleware matcher', noMatch.join(', '))
               : ok('every card slug is in the middleware matcher');
// The other direction: a preview for a card that no longer exists is dead
// weight, and usually means a card was renamed and this was left behind.
const orphan = previews.filter(p => !slugs.includes(p));
orphan.length ? bad('no preview without a card', orphan.join(', '))
              : ok('no preview without a card');
const dupes = [...new Set(slugs.filter((s, i) => slugs.indexOf(s) !== i))];
dupes.length ? bad('card slugs are unique — two cards cannot share a deep link', dupes.join(', '))
             : ok('card slugs are unique');

// ADDICTED specifically: one worldwide instant, so it must NOT carry the
// midnight-local attribute the PRESS PLAY EP needs.
const card = ix.match(/<div class="cd-card[^"]*"[^>]*data-slug="addicted"[^>]*>/);
if (!card) { bad('the ADDICTED card exists'); }
else {
  ok('the ADDICTED card exists');
  /data-target="2026-10-29T23:00:00Z"/.test(card[0])
    ? ok('it counts to 2026-10-29T23:00:00Z', '08:00 KST Oct 30')
    : bad('it counts to 2026-10-29T23:00:00Z', card[0].slice(0, 120));
  /data-target-local/.test(card[0])
    ? bad('it is a single instant, not midnight-local — data-target-local must be absent')
    : ok('it is a single instant, not midnight-local');
}
// The worldwide-times list must be generated from the same instant the card
// counts to; two copies of a date is two chances to be wrong.
const cardBlock = (slug) => {
  const i = ix.indexOf(`data-slug="${slug}"`);
  if (i < 0) return '';
  // From the card's own tag to the start of the next card — enough to hold
  // everything the card owns and nothing from its neighbour.
  const rest = ix.slice(i);
  const next = rest.indexOf('<div class="cd-card', 1);
  return next < 0 ? rest : rest.slice(0, next);
};
const addicted = cardBlock('addicted');
addicted.includes('data-times-for="2026-10-29T23:00:00Z"')
  ? ok('the worldwide-times list uses that same instant')
  : bad('the worldwide-times list uses that same instant');

// EVERY RELEASE CARD OFFERS A SHARE CARD.
//
// Nothing checked this, and a release shipped without one: the Steps card —
// JENNIE, "Someone to Hold" — had a pre-save button and no way to post it,
// for as long as the card existed. It was not a broken button or a failed
// draw; the markup simply never had one, so there was nothing to notice.
// Every other card had grown one as it was built, which is exactly how the
// gap stayed invisible.
//
// The list of cards comes from the page itself rather than a list kept here,
// so the NEXT release is covered the day its card lands.
const SHARELESS_OK = {
  // Not a release: it is the awards-voting card, and it links out to the
  // ballot rather than to anything a fan would post an image of.
  vmas: 'a voting card, not a release — it links to the ballot',
};
{
  // THE CARD'S OWN ELEMENT, found by matching its closing tag.
  //
  // cardBlock() above runs from one card to the NEXT one, which is fine for
  // the checks that use it and useless here: the LAST card on the page has no
  // next one, so its "block" is the whole rest of the file. This check passed
  // `vmas` twice before this — first on an openGoalsCard() three thousand
  // lines below it in the JavaScript, then, after bounding the block at the
  // first <script, on a DIFFERENT openGoalsCard() in the campaign-goals markup
  // that sits between the two. A bound that is merely tighter is not a bound.
  //
  // Comments are stripped before the walk because several of these cards carry
  // long ones that contain markup, and a <div inside a comment would throw the
  // depth off and silently widen the window again.
  const cardMarkup = (slug) => {
    const at = ix.indexOf(`data-slug="${slug}"`);
    if (at < 0) return '';
    const open = ix.lastIndexOf('<div', at);
    const src = ix.slice(open).replace(/<!--[\s\S]*?-->/g, '');
    let depth = 0;
    for (let i = 0; i < src.length; i++) {
      if (src.startsWith('<div', i)) depth++;
      else if (src.startsWith('</div>', i)) { if (--depth === 0) return src.slice(0, i + 6); }
    }
    return src;   // unbalanced markup: fall back to everything, and fail loudly below
  };
  const cards = [...ix.matchAll(/<div class="cd-card[^"]*"[^>]*data-slug="([^"]+)"/g)].map(m => m[1]);
  const missing = [];
  for (const slug of cards) {
    const body = cardMarkup(slug);
    // A share button is a button that opens a card. Matched on the call, not
    // on the label: the emoji and the wording differ per release ("📸 Share",
    // an image-plus-word button on the JISOO card), and matching the label
    // would have passed a button that opens nothing.
    const opener = body.match(/onclick="(open[A-Za-z]*Card\([^"]*\))"/);
    if (opener) ok(`${slug} can be shared`, opener[1]);
    else if (SHARELESS_OK[slug]) ok(`${slug} has no share card`, SHARELESS_OK[slug]);
    else missing.push(slug);
  }
  missing.length
    ? bad('every release card offers a share card', `${missing.join(', ')} — pre-save button, no way to post it`)
    : ok('every release card offers a share card');
  // And the other direction: an exemption for a card that no longer exists is
  // a hole waiting for a slug to be reused.
  const staleExempt = Object.keys(SHARELESS_OK).filter(s => !cards.includes(s));
  staleExempt.length
    ? bad('no exemption without a card', staleExempt.join(', '))
    : ok('no exemption without a card');
}

// The bug this section exists for: the ADDICTED card was written inside
// #cd-past — the block that carries `hidden` on the home page and is revealed
// only on the /countdowns hub. Nothing failed. The slug was wired, the link
// preview was there, the deep link worked, every check above passed, and a
// release a week away simply never appeared on the home carousel.
// A countdown still ahead of us belongs in the live wrap.
const pastAt = ix.indexOf('<div id="cd-past"');
const pastBlock = pastAt < 0 ? '' : ix.slice(pastAt);
pastAt < 0 ? bad('#cd-past is in the page') : ok('#cd-past is in the page');
const attr = (tag, name) => (tag.match(new RegExp(`${name}="([^"]*)"`)) || [])[1];
const buried = [...pastBlock.matchAll(/<div class="cd-card[^"]*"[^>]*>/g)]
  .map(m => ({ slug: attr(m[0], 'data-slug'), target: attr(m[0], 'data-target') }))
  .filter(c => c.target && new Date(c.target) > new Date());
buried.length
  ? bad('no countdown still ahead of us is buried in the hidden #cd-past block',
        buried.map(c => `${c.slug} → ${c.target}`).join(', '))
  : ok('no countdown still ahead of us is buried in the hidden #cd-past block');

// Its art comes from jisoo.io and lives in the repo. A renamed or missing
// file is a broken image on the card and nothing anywhere says so.
const srcs = [...addicted.matchAll(/src="(\/addicted\/[^"]+)"/g)].map(m => m[1]);
srcs.length >= 3
  ? ok('the card carries jisoo.io\'s art', `${srcs.length} files`)
  : bad('the card carries jisoo.io\'s art', `${srcs.length} /addicted/ images referenced`);
for (const s of srcs) {
  try { await access(ROOT + s); ok(`  ${s} is in the repo`); }
  catch { bad(`  ${s} is in the repo — referenced but not on disk`); }
}
// The pieces that make it move. Each is silent when it goes: the sky with no
// hook is a still picture, and a strike with no bolt flashes nothing. That it
// actually strikes is checked where it can be measured — test_addicted_sky.mjs.
addicted.includes('data-addicted-sky')
  ? ok('the sky is wired to the script') : bad('the sky is wired to the script');
/class="ad-bolt"/.test(addicted) && /class="ad-logo"/.test(addicted)
  ? ok('the lightning and the lockup are both there')
  : bad('the lightning and the lockup are both there');

console.log(fails ? `\n${fails} failure(s)` : '\nall good');
process.exit(fails ? 1 : 0);
