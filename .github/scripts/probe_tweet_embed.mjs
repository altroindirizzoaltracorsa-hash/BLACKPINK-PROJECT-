// READ-ONLY. Answers the one question that decides how the MAMA card can show
// our daily vote post: can this site render the REAL post, and by which route?
//
// There are three, and they are not equally good:
//
//   1. oEmbed, server side  — GET publish.twitter.com/oembed?...&omit_script=1
//      returns the post's own markup INCLUDING ITS TEXT. We could cache that
//      and render it ourselves: the real post, no third-party script, nothing
//      of X loaded in a visitor's browser. Best outcome by a distance.
//   2. widgets.js, client side — the official embed. Shows the post properly,
//      avatar and counts and all, but every visitor to /awards then fetches a
//      script from X and X sees them. dnt=true limits that; it does not remove
//      the request.
//   3. Neither — keep quoting the text ourselves and link out.
//
// None of this can be decided from a Claude Code container: every X host is
// refused there (checked — platform.twitter.com, cdn.syndication.twimg.com and
// x.com all fail to connect, while api.github.com answers). A GitHub runner
// can reach them, so the probe runs here.
//
// ONE CAVEAT ON READING THE RESULT: a GitHub runner is not Vercel. X rate
// limits and blocks by IP range, and datacentre ranges are exactly what it
// blocks, so a FAILURE here is weaker evidence than a success — it may be this
// runner rather than the endpoint. A success means the endpoint exists and
// answers unauthenticated, which is the thing in doubt.
import { writeFile, mkdir } from 'node:fs/promises';

const TWEET = process.env.TWEET_URL || 'https://x.com/jack/status/20';
const SITE = process.env.SITE_URL || 'https://www.blinksunited.com';

const line = (s) => console.log(s);
const head = (s) => console.log(`\n=== ${s} ===`);
let summary = [];

// ── 1. is a post pinned on the site right now? ──────────────────────────────
// Decides whether any of this has anything to show today: the card can only
// embed a post it knows the URL of, and the pin is how it knows.
head('the pin the site is serving right now');
try {
  const r = await fetch(`${SITE}/api/mama-votes`, { headers: { accept: 'application/json' } });
  line(`GET /api/mama-votes → HTTP ${r.status}`);
  const j = await r.json();
  if (j && j.pinned && j.pinned.url) {
    const ageH = (j.pinned.ageMs / 3600000).toFixed(1);
    line(`pinned: ${j.pinned.url}`);
    line(`id: ${j.pinned.id}   age: ${ageH}h`);
    summary.push(`pin: present (${ageH}h old)`);
  } else {
    line('pinned: null — nothing pinned, or the pin is over 24h old and expired');
    summary.push('pin: none');
  }
} catch (e) {
  line(`failed: ${e.message}`);
  summary.push('pin: could not ask');
}

// ── 2. oEmbed, the route that needs no script in the browser ────────────────
head('oEmbed (publish.twitter.com)');
let oembedOk = false;
for (const omit of ['1', '0']) {
  const u = `https://publish.twitter.com/oembed?url=${encodeURIComponent(TWEET)}&omit_script=${omit}&dnt=1&theme=dark`;
  try {
    const r = await fetch(u, { headers: { accept: 'application/json' } });
    line(`omit_script=${omit} → HTTP ${r.status}`);
    const body = await r.text();
    if (r.ok) {
      let j = null;
      try { j = JSON.parse(body); } catch (e) {}
      if (j && j.html) {
        // The point of this route: the TEXT comes back, so the post can be
        // rendered without loading anything of X's in the visitor's browser.
        const text = j.html.replace(/<script[\s\S]*?<\/script>/g, '')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        line(`author: ${j.author_name} (${j.author_url})`);
        line(`text came back: ${text.slice(0, 220)}`);
        line(`html carries a script tag: ${/<script/.test(j.html)}`);
        if (omit === '1') oembedOk = true;
      } else {
        line(`body (first 300): ${body.slice(0, 300)}`);
      }
    } else {
      line(`body (first 300): ${body.slice(0, 300)}`);
    }
  } catch (e) {
    line(`omit_script=${omit} → failed: ${e.message}`);
  }
}
summary.push(`oembed: ${oembedOk ? 'WORKS unauthenticated' : 'no'}`);

// ── 3. widgets.js, the official client-side embed ───────────────────────────
// Rendered for real in a browser rather than guessed at: the blockquote is
// only a placeholder until X's script replaces it with an iframe, so the only
// honest check is whether that iframe appears.
head('widgets.js (the official embed), rendered in a browser');
let widgetOk = false, widgetNote = '';
try {
  const { chromium } = await import('playwright');
  await mkdir('probe-out', { recursive: true });
  const page = `<!doctype html><meta charset="utf-8">
<body style="background:#080808;margin:0;padding:16px">
<blockquote class="twitter-tweet" data-theme="dark" data-dnt="true"><a href="${TWEET}"></a></blockquote>
<script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>`;
  await writeFile('probe-out/widget.html', page);
  const browser = await chromium.launch();
  const p = await browser.newPage({ viewport: { width: 560, height: 900 } });
  const failed = [];
  p.on('requestfailed', (r) => failed.push(`${r.url().slice(0, 80)} ${r.failure()?.errorText || ''}`));
  await p.goto('file://' + process.cwd() + '/probe-out/widget.html', { waitUntil: 'domcontentloaded' });
  try {
    await p.waitForSelector('iframe.twitter-tweet-rendered', { timeout: 25000 });
    widgetOk = true;
    const box = await p.locator('iframe.twitter-tweet-rendered').boundingBox();
    widgetNote = `rendered at ${Math.round(box.width)}x${Math.round(box.height)}`;
    line(`the embed rendered — ${widgetNote}`);
    // What the post actually says, read out of the widget's own iframe. Proves
    // it is the post and not an empty shell.
    const inner = await p.frameLocator('iframe.twitter-tweet-rendered').locator('[data-testid="tweetText"], .css-901oao')
      .first().textContent().catch(() => null);
    if (inner) line(`it reads: ${inner.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  } catch (e) {
    widgetNote = 'no iframe appeared within 25s';
    line(widgetNote);
    if (failed.length) line(`requests that failed:\n  ${failed.slice(0, 8).join('\n  ')}`);
  }
  await p.screenshot({ path: 'probe-out/widget.png', fullPage: true });
  await browser.close();
} catch (e) {
  widgetNote = e.message;
  line(`could not run the browser check: ${e.message}`);
}
summary.push(`widgets.js: ${widgetOk ? 'WORKS' : 'no (' + widgetNote + ')'}`);

head('summary');
summary.forEach((s) => line('  ' + s));
line('');
line('Remember: a failure on a GitHub runner may be X blocking the runner, not');
line('the endpoint. A success is the conclusive direction.');
