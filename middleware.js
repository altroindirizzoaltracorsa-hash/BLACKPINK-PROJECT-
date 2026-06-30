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

export const config = {
  matcher: ['/voting', '/leaderboard', '/badges', '/feedback', '/account'],
};

// Lets the request fall through to the normal Vercel routing (the
// vercel.json rewrite to /index.html), used when there's nothing to
// customize or the origin fetch below fails.
function next() {
  return new Response(null, { headers: { 'x-middleware-next': '1' } });
}

export default async function middleware(req) {
  const url = new URL(req.url);
  const page = PAGES[url.pathname];
  if (!page) return next();

  try {
    const origin = await fetch(new URL('/index.html', url));
    if (!origin.ok) return next();
    let html = await origin.text();

    html = html
      .replace(/<title>.*?<\/title>/, `<title>${page.title}</title>`)
      .replace(/(<meta name="description" content=")[^"]*(")/, `$1${page.description}$2`)
      .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${page.title}$2`)
      .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${page.description}$2`)
      .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${url.origin}${url.pathname}$2`)
      .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${page.title}$2`)
      .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${page.description}$2`);

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
