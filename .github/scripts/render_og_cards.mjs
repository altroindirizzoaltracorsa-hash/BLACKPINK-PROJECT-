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
// NO TYPE ON THESE CARDS, deliberately. The obvious thing is to letter them
// like /og-countdown-*.jpg — and that is exactly how og-countdown-vmas.jpg now
// carries "Voting closes Sep 25, 2026" into November. A card with words on it
// is a second copy of the page's claims that nothing re-renders when they
// change. og:title and og:description already carry the words, they live in
// the page, and they are edited when the page is. So these are photographs,
// cropped, and there is nothing on them that can go out of date.
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

await browser.close();
