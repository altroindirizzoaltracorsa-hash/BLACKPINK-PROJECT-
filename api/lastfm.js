export const config = { runtime: 'edge' };

// Server-side proxy for Last.fm API calls. Routes through Vercel's network
// instead of the browser, so client-side ISP routing issues to
// ws.audioscrobbler.com don't cause "Failed to fetch" / 2-minute hangs.

const LFM_BASE = 'https://ws.audioscrobbler.com/2.0/';
const LFM_KEY  = '666b8ef2f3cc360fbc20df275fba2981';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const params = Object.fromEntries(searchParams.entries());

  if (!params.method) return json({ message: 'Missing Last.fm method' }, 400);

  const lfmUrl = LFM_BASE + '?' + new URLSearchParams({
    ...params,
    api_key: LFM_KEY,
    format: 'json',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(lfmUrl, { signal: controller.signal });
    const data = await r.json();
    return json(data);
  } catch (e) {
    if (e.name === 'AbortError') return json({ message: 'Last.fm request timed out' }, 504);
    return json({ message: e.message }, 502);
  } finally {
    clearTimeout(timer);
  }
}
