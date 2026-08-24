const PAGES = {
  '/voting': {
    title: 'Vote Now | BLINKS UNITED',
    description: "Help decide BLACKPINK's next streaming target — cast your vote now!",
  },
  '/leaderboard': {
    title: 'Leaderboard | BLINKS UNITED',
    description: 'See how Blinks rank on the BLACKPINK streaming leaderboard — climb the ranks!',
  },
  '/badges': {
    title: 'Badges | BLINKS UNITED',
    description: 'Earn badges for your BLACKPINK streaming milestones.',
  },
  '/feedback': {
    title: 'Feedback | BLINKS UNITED',
    description: 'Share your feedback and help us improve the BLACKPINK streaming hub.',
  },
  '/account': {
    title: 'My Account | BLINKS UNITED',
    description: 'Sign in and link multiple Last.fm or ListenBrainz accounts to combine your BLACKPINK streams into one profile.',
  },
};

// Per-countdown link previews. Keyed by the /countdowns/<slug> deep link so a
// shared link shows that specific countdown's card (title + date + art) instead
// of the generic site preview.
const COUNTDOWNS = {
  'jisoo.io': {
    title: 'JISOO — Sep 4, 2026 | Countdown · BLINKS UNITED',
    description: "Counting down to JISOO — Sep 4, 2026 (1PM KST / 12AM EDT). CLICK jisoo.io.",
    image: '/og-countdown-jisoo.jpg',
  },
  'jenn.ie': {
    title: 'JENNIE — Fallen Angel, Aug 28, 2026 | Countdown · BLINKS UNITED',
    description: "Counting down to JENNIE's Fallen Angel EP — Aug 28, 2026 (1PM KST / 12AM EDT).",
    image: '/og-countdown-jennie.jpg',
  },
  'hellosawadika.com': {
    title: 'LISA — New Single, Sep 3, 2026 | Countdown · BLINKS UNITED',
    description: "Counting down to LISA's new single — Sep 3, 2026 (1PM KST / 12AM EDT). Pre-save at lalisaofficial.com.",
    image: '/og-countdown-lisa.jpg',
  },
  'lalisaofficial.com': {
    title: 'LISA — PRESS PLAY EP, Oct 23, 2026 | Countdown · BLINKS UNITED',
    description: "Counting down to LISA's PRESS PLAY EP — Oct 23, 2026 (1PM KST / 12AM EDT). lalisaofficial.com.",
    image: '/og-countdown-pressplay.jpg',
  },
  'vmas': {
    title: '2026 VMAs — voting closes Sep 25 | Countdown · BLINKS UNITED',
    description: 'BLACKPINK, LISA and JISOO x ZAYN are nominated at the 2026 VMAs. Fan voting closes Sep 25, 6PM ET.',
    image: '/og-countdown-vmas.jpg',
  },
};
const COUNTDOWNS_HUB = {
  title: 'Countdowns | BLINKS UNITED',
  description: 'Every BLACKPINK & members release and reveal countdown in one place.',
  image: '/og-countdown-jisoo.jpg',
};

export const config = {
  // Explicit paths — the dotted deep-link slugs (jisoo.io, jenn.ie, …) don't
  // reliably match a `:slug*` wildcard, so list each one so middleware runs.
  matcher: [
    '/voting', '/leaderboard', '/badges', '/feedback', '/account',
    '/countdowns',
    '/countdowns/jisoo.io', '/countdowns/jenn.ie', '/countdowns/hellosawadika.com',
    '/countdowns/lalisaofficial.com', '/countdowns/vmas',
  ],
};

// Lets the request fall through to the normal Vercel routing (the
// vercel.json rewrite to /index.html), used when there's nothing to
// customize or the origin fetch below fails.
function next() {
  return new Response(null, { headers: { 'x-middleware-next': '1' } });
}

// HTML-escape values injected into meta attributes.
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Resolve which metadata to use for a request: a plain PAGES entry, the
// /countdowns hub, or a specific /countdowns/<slug> deep link.
function metaFor(pathname) {
  if (pathname === '/countdowns') return COUNTDOWNS_HUB;
  if (pathname.startsWith('/countdowns/')) {
    const slug = decodeURIComponent(pathname.slice('/countdowns/'.length).replace(/\/+$/, '')).toLowerCase();
    return COUNTDOWNS[slug] || COUNTDOWNS_HUB;
  }
  return PAGES[pathname] || null;
}

export default async function middleware(req) {
  const url = new URL(req.url);
  const page = metaFor(url.pathname);
  if (!page) return next();

  try {
    const origin = await fetch(new URL('/index.html', url));
    if (!origin.ok) return next();
    let html = await origin.text();

    const title = esc(page.title);
    const desc = esc(page.description);
    html = html
      .replace(/<title>.*?<\/title>/, `<title>${title}</title>`)
      .replace(/(<meta name="description" content=")[^"]*(")/, `$1${desc}$2`)
      .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${title}$2`)
      .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${desc}$2`)
      .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${url.origin}${url.pathname}$2`)
      .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${title}$2`)
      .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${desc}$2`);
    if (page.image) {
      const img = `${url.origin}${page.image}`;
      html = html
        .replace(/(<meta property="og:image" content=")[^"]*(")/, `$1${img}$2`)
        .replace(/(<meta name="twitter:image" content=")[^"]*(")/, `$1${img}$2`);
    }

    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 's-maxage=3600, stale-while-revalidate=86400',
      },
    });
  } catch {
    return next();
  }
}
