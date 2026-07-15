export const config = { runtime: 'edge' };

const FILE_ID = '1JLIwdHnpsSw7_6JdaoajfvxTUv0BMTn1';

export default async function handler(req) {
  const url = `https://drive.usercontent.google.com/download?id=${FILE_ID}&export=download&authuser=0&confirm=t`;

  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    return new Response('Failed to reach audio source', { status: 502 });
  }

  if (!res.ok) {
    return new Response('Audio source returned ' + res.status, { status: 502 });
  }

  const headers = new Headers({
    'Content-Type': res.headers.get('content-type') || 'audio/mp4',
    'Cache-Control': 'public, max-age=86400',
    'Access-Control-Allow-Origin': '*',
  });
  const cl = res.headers.get('content-length');
  if (cl) headers.set('Content-Length', cl);

  return new Response(res.body, { status: 200, headers });
}
