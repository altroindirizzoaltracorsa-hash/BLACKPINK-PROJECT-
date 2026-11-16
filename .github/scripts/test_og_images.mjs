// Every link preview is a real file, of the shape the page asked for.
//
// Run: node .github/scripts/test_og_images.mjs
//
// WHAT WENT WRONG. /awards, /breaktudo and /vmas all declare
// `twitter:card = summary_large_image` — a request for a wide banner — and
// then handed the scraper an in-page thumbnail. /vmas's was 414x414, SQUARE:
// Facebook and WhatsApp drop to the small side-thumbnail layout below
// 600x315, and X crops to 2:1, so every shared /vmas link came up as a little
// square beside the text rather than the banner the page had asked for. There
// was nothing wrong in the markup to notice — the tag was present, the file
// was there, the picture was the right picture. Only its shape was wrong, and
// a shape is not something anybody reads off a page of meta tags.
//
// THE OTHER HALF IS THE DECLARED SIZE. og:image:width / :height let a scraper
// lay the card out before the image has arrived, and a pair that disagrees
// with the file is worse than none: the reader gets a box of one shape with a
// picture of another in it. So they are checked against the file's real
// header, not against each other.
//
// Sizes are read out of the file's own bytes rather than with an image
// library, because this has to run in CI next to the other checks and adding
// a native dependency for four integers is not worth it.
import { readFile, readdir } from 'node:fs/promises';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };

// ── Pixel size from the file header ─────────────────────────────────────────
// JPEG: walk the markers to the first SOF. PNG: the IHDR is at a fixed offset.
// Anything else is reported as unknown rather than guessed — an unknown size
// fails the checks below instead of skipping them, so a format nobody thought
// about cannot slip through as a pass.
function pixelSize(buf, name) {
  if (/\.png$/i.test(name) && buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (/\.jpe?g$/i.test(name)) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15, minus the ones that are not frame headers.
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

// What a "large summary" card needs. The minimums are the platforms' own
// (Facebook/WhatsApp fall back to the small layout under 600x315); the aspect
// band is around X's 1.91:1 with enough slack that a sensibly cropped photo
// passes and a square or a portrait does not.
const MIN_W = 600, MIN_H = 315, LO = 1.6, HI = 2.1;

const files = (await readdir(ROOT)).filter(f => f.endsWith('.html'));
const seen = new Set();

for (const page of files.sort()) {
  const head = (await readFile(`${ROOT}/${page}`, 'utf8')).slice(0, 8000);
  const img  = head.match(/<meta property="og:image" content="([^"]+)"/);
  if (!img) continue;
  const card = (head.match(/<meta name="twitter:card" content="([^"]+)"/) || [])[1] || '';
  const url  = img[1];
  if (!url.includes('blinksunited.com/')) { ok(`${page}: og:image is off-site`, url); continue; }
  const local = url.split('blinksunited.com/')[1].split('?')[0];

  let buf = null;
  try { buf = await readFile(`${ROOT}/${local}`); }
  catch { bad(`${page}: og:image exists`, `${local} is not in the repo`); continue; }
  const size = pixelSize(buf, local);
  if (!size) { bad(`${page}: og:image size is readable`, `${local} — could not read a size from it`); continue; }
  const { w, h } = size;
  const ratio = w / h;

  // twitter:image should be the same picture. Two different files is two
  // previews to keep in step, and the one nobody looks at is the stale one.
  const tw = (head.match(/<meta name="twitter:image" content="([^"]+)"/) || [])[1];
  tw === url ? ok(`${page}: og:image and twitter:image agree`)
             : bad(`${page}: og:image and twitter:image agree`, `${url} vs ${tw || '(none)'}`);

  // The declared size, if there is one, has to be the file's real size.
  const dw = (head.match(/<meta property="og:image:width" content="(\d+)"/) || [])[1];
  const dh = (head.match(/<meta property="og:image:height" content="(\d+)"/) || [])[1];
  if (dw || dh) {
    (Number(dw) === w && Number(dh) === h)
      ? ok(`${page}: the declared size is the file's size`, `${w}x${h}`)
      : bad(`${page}: the declared size is the file's size`,
            `declared ${dw || '?'}x${dh || '?'}, file is ${w}x${h}`);
  }

  if (/summary_large_image/.test(card)) {
    (w >= MIN_W && h >= MIN_H)
      ? ok(`${page}: big enough for the card it asks for`, `${w}x${h}`)
      : bad(`${page}: big enough for the card it asks for`,
            `${local} is ${w}x${h} — under ${MIN_W}x${MIN_H}, so it renders as a small thumbnail, not a banner`);
    (ratio >= LO && ratio <= HI)
      ? ok(`${page}: and the right shape`, `${ratio.toFixed(2)}:1`)
      : bad(`${page}: and the right shape`,
            `${local} is ${ratio.toFixed(2)}:1 — a large card is cropped to about 1.91:1, so this loses ${
              ratio < LO ? 'the top and bottom' : 'the sides'}`);
  } else {
    ok(`${page}: not a large card`, card || 'no twitter:card');
  }
  seen.add(page);
}

seen.size >= 3 ? ok(`${seen.size} pages carry their own preview`)
               : bad('the pages were found at all', `${seen.size} checked — this file read nothing`);

// ── The countdown deep links ────────────────────────────────────────────────
// Same rule, different place: middleware.js rewrites og:image per
// /countdowns/<slug>, and a slug whose image has been renamed or deleted
// fails SILENTLY — the tag is written with a URL that 404s and the share comes
// up with no picture at all, which is indistinguishable from a scraper being
// slow. There is no page here to read, so the list is read from the source.
const mw = await readFile(`${ROOT}/middleware.js`, 'utf8');
const imgs = [...mw.matchAll(/image:\s*'([^']+)'/g)].map(m => m[1]);
imgs.length ? ok(`middleware: ${imgs.length} countdown previews to check`)
            : bad('middleware: countdown previews found', 'no image: lines — did the shape of that file change?');
for (const rel of imgs) {
  const name = rel.replace(/^\//, '');
  let buf = null;
  try { buf = await readFile(`${ROOT}/${name}`); } catch { buf = null; }
  if (!buf) { bad(`middleware: ${name} exists`, 'the deep link would share a 404'); continue; }
  const s = pixelSize(buf, name);
  if (!s) { bad(`middleware: ${name} size is readable`); continue; }
  const r = s.w / s.h;
  (s.w >= MIN_W && s.h >= MIN_H && r >= LO && r <= HI)
    ? ok(`middleware: ${name}`, `${s.w}x${s.h}`)
    : bad(`middleware: ${name}`, `${s.w}x${s.h} (${r.toFixed(2)}:1)`);
}

console.log(fails ? `\n${fails} FAILED` : '\nEvery preview is the right shape.');
process.exit(fails ? 1 : 0);
