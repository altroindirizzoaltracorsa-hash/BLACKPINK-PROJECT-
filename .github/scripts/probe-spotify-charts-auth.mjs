/**
 * One-off diagnostic: tries to replicate charts.spotify.com's auth flow
 * server-side (no browser) to see if a usable bearer token can be obtained
 * purely via HTTP requests + PKCE, or whether it requires an actual logged-in
 * Spotify account / browser-executed anti-bot logic.
 *
 * Observed from devtools:
 *   POST https://accounts.spotify.com/api/token
 *     grant_type=authorization_code
 *     client_id=44407c71b3b24071865aaa4fea948a15
 *     code=<from an /authorize redirect>
 *     redirect_uri=https://charts.spotify.com
 *     code_verifier=<PKCE verifier>
 *
 * Safe to remove once the feature (if built) ships.
 */

import crypto from 'node:crypto';

const CLIENT_ID = '44407c71b3b24071865aaa4fea948a15';
const REDIRECT_URI = 'https://charts.spotify.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomVerifier() {
  return base64url(crypto.randomBytes(64)).slice(0, 128);
}

async function main() {
  const codeVerifier = randomVerifier();
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());

  console.log('=== Attempt 1: client_credentials grant (no PKCE dance) ===');
  const r1 = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Origin: 'https://charts.spotify.com',
      Referer: 'https://charts.spotify.com/',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID }).toString(),
  });
  console.log(`status=${r1.status}`);
  console.log((await r1.text()).slice(0, 500));

  console.log('\n=== Attempt 2: hit /authorize to see if a code is auto-issued without login ===');
  const authorizeUrl = `https://accounts.spotify.com/authorize?` + new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  console.log(`GET ${authorizeUrl}`);
  const r2 = await fetch(authorizeUrl, {
    headers: { 'User-Agent': UA, Referer: 'https://charts.spotify.com/' },
    redirect: 'manual',
  });
  console.log(`status=${r2.status}`);
  console.log(`location header: ${r2.headers.get('location')}`);
  const body2 = await r2.text();
  console.log(`body length=${body2.length}`);
  console.log(body2.slice(0, 500));
}

main().catch(e => { console.error(e); process.exit(1); });
