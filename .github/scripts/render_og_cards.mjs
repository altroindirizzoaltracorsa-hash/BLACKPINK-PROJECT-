// Render the link-preview images for the pages that had none of their own.
//
// Run: node .github/scripts/render_og_cards.mjs
//
// WHY THESE EXIST. /awards, /breaktudo and /vmas all declare
// `twitter:card = summary_large_image` — a request for a wide banner — and
// then handed the scraper an in-page thumbnail: a 3:2 photo (840x560) on the
// first two, and a SQUARE 414x414 still on /vmas. Facebook and WhatsApp drop
// to the small side-thumbnail layout below 600x315, and X crops to 2:1, so a
// shared /vmas link rendered as a little square beside the text instead of the
// banner the page asked for. Nothing was declared wrongly; the files were just
// the wrong shape for the card type.
//
// THE RULE ON THESE CARDS IS NOT "NO WORDS", IT IS "NOTHING THAT EXPIRES".
// og-countdown-vmas.jpg carried "Voting closes Sep 25, 2026" into November,
// which is what a card with a FUTURE-TENSE claim on it always ends up doing:
// nothing re-renders it when the date passes. The two photo cards below
// therefore carry no type at all — they have nothing to say that og:title and
// og:description do not already say in the page, where it gets edited.
//
// The VMA card at the bottom is lettered, and may be, because every line on
// it is settled: an award that was held, a ballot that shut, a list of who was
// nominated. A result cannot go stale. If you are about to add a line to it,
// the test is not "is this true" — it is "will this still be true with nobody
// looking at it".
//
// SAME PHOTOGRAPH, RIGHT GEOMETRY. Each card is the picture its page already
// used, cover-cropped to 1.91:1 with the crop window chosen so every member
// stays in frame. The sources stay where they are: both are also in-page
// thumbnails at their own sizes, and replacing them would resize those too.
//
// Drawn in a real browser rather than with an image library, for the same
// reason render_collab_card.mjs is: no new dependency on a deploy that serves
// a million other things, and the result is a static file, committed.
import { chromium } from './_playwright.mjs';
import { readFile, writeFile } from 'node:fs/promises';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const W = 1200, H = 630;          // what X and Facebook crop to

// `sy`/`sh` is the band of the source kept, in source pixels. Everything else
// follows from cover-cropping to 1.91:1, so only the vertical placement is a
// judgement — and the judgement is always the same one: keep all four of them,
// and prefer cutting legs to cutting heads.
const CARDS = [
  {
    out: 'og-awards.jpg',
    src: 'vote-blackpink-ot4.jpg',   // 840x560 — /awards and /breaktudo
    // 840 wide needs 441 of height. The group stands in the upper two thirds
    // and the frame already cuts them at the thigh, so the 119 removed comes
    // almost entirely off the bottom.
    sy: 18, sh: 441,
  },
  {
    out: 'og-vmas.jpg',
    src: 'vote-vma-jump.jpeg',       // 414x414 — /vmas
    // The one real upscale here: 414 wide into 1200. It survives because the
    // picture is a dense crowd shot that is already motion-blurred, and a
    // preview renders around 500px wide in a feed. A sharper source would be
    // better; there is no larger copy of this still in the repo.
    sy: 118, sh: 217,
  },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });

for (const card of CARDS) {
  const buf = await readFile(`${ROOT}/${card.src}`);
  const type = card.src.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const dataUrl = `data:${type};base64,${buf.toString('base64')}`;

  const jpeg = await page.evaluate(async ({ dataUrl, W, H, sy, sh }) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    // The crop has to be stated in the SOURCE's own pixels and checked against
    // them: a window that runs past the bottom of the image draws a
    // transparent strip that flattens to black, which looks like a deliberate
    // letterbox and is not.
    if (sy < 0 || sy + sh > img.naturalHeight) {
      return { err: `crop ${sy}..${sy + sh} is outside the ${img.naturalWidth}x${img.naturalHeight} source` };
    }
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, sy, img.naturalWidth, sh, 0, 0, W, H);
    return {
      src: `${img.naturalWidth}x${img.naturalHeight}`,
      data: c.toDataURL('image/jpeg', 0.9).split(',')[1],
    };
  }, { dataUrl, W, H, sy: card.sy, sh: card.sh });

  if (jpeg.err) { console.error(`${card.out}: ${jpeg.err}`); process.exitCode = 1; continue; }
  const bytes = Buffer.from(jpeg.data, 'base64');
  await writeFile(`${ROOT}/${card.out}`, bytes);
  console.log(`${card.out}  ${W}x${H}  ${Math.round(bytes.length / 1024)}KB  `
    + `from ${card.src} (${jpeg.src}, kept rows ${card.sy}–${card.sy + card.sh})`);
}

// ── The VMA countdown card ──────────────────────────────────────────────────
// The preview behind /countdowns/vmas. It used to end with "Voting closes Sep
// 25, 2026 · 6PM ET" — which was the one line on it that had a shelf life, and
// which it was still announcing in November. It is gone, and nothing has taken
// its place: the ballot shutting is now said in the eyebrow, in the past
// tense, where it cannot be read as an instruction.
//
// Composed rather than cropped, because this card is a lockup — the MTV mark
// is the subject. Every piece is a file already in the repo (the still behind
// it, the VMA lockup, our own mark), so nothing here is drawn by hand and the
// card can be rebuilt from source at any time.
{
  const b64 = async (f) => (await readFile(`${ROOT}/${f}`)).toString('base64');
  const bg   = `data:image/jpeg;base64,${await b64('vote-vma-jump.jpeg')}`;
  const vma  = `data:image/png;base64,${await b64('vmas.png')}`;
  const blu  = `data:image/png;base64,${await b64('icon-512.png')}`;

  // DM Mono is the site's own mono and is pulled from Google Fonts. If it
  // cannot be reached the card still renders, in the fallback — so the render
  // is checked by LOOKING at the file, not by trusting that it ran.
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{width:${W}px;height:${H}px;overflow:hidden;background:#07070a;
      font-family:'DM Mono',ui-monospace,monospace;position:relative}
    /* The still, filling the frame and pushed right back: it is a texture
       here, not a picture, and the type has to stay readable over it. */
    .bg{position:absolute;inset:0;background:url('${bg}') center/cover no-repeat;
      filter:brightness(.34) saturate(.7)}
    .veil{position:absolute;inset:0;
      background:linear-gradient(180deg,rgba(7,7,10,.72),rgba(7,7,10,.5) 45%,rgba(7,7,10,.88))}
    .eyebrow{position:absolute;left:60px;top:46px;color:#b4f8d3;font-size:19px;
      letter-spacing:.34em;font-weight:500;text-transform:uppercase}
    .blu{position:absolute;right:48px;top:30px;width:132px;height:132px;
      object-fit:contain;mix-blend-mode:screen}
    .lockup{position:absolute;left:50%;top:172px;transform:translateX(-50%);width:430px}
    .acts{position:absolute;left:0;right:0;top:412px;text-align:center;color:#b4f8d3;
      font-size:27px;letter-spacing:.17em;font-weight:500}
    .url{position:absolute;left:60px;bottom:44px;color:#8fe6bd;font-size:21px;letter-spacing:.07em}
  </style></head><body>
    <div class="bg"></div><div class="veil"></div>
    <div class="eyebrow">&#9671; 2026 &middot; Fan voting closed</div>
    <img class="blu" src="${blu}" alt="">
    <img class="lockup" src="${vma}" alt="">
    <div class="acts">BLACKPINK &middot; LISA &middot; JISOO&times;ZAYN</div>
    <div class="url">blinksunited.com/countdowns/vmas</div>
  </body></html>`, { waitUntil: 'load' });
  try { await page.evaluate(() => document.fonts.ready); } catch {}
  const shot = await page.screenshot({ type: 'jpeg', quality: 90 });
  await writeFile(`${ROOT}/og-countdown-vmas.jpg`, shot);
  console.log(`og-countdown-vmas.jpg  ${W}x${H}  ${Math.round(shot.length / 1024)}KB  composed`);
}

await browser.close();
