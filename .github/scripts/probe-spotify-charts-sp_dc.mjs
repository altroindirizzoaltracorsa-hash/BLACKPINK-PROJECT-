/**
 * One-off diagnostic: tests whether a token minted from a real account's
 * `sp_dc` session cookie (the same "mint fresh tokens from a long-lived
 * cookie" trick already used by getSpotifyToken() in api/proxy-image.js,
 * just with a real cookie instead of an anonymous request) is accepted by
 * charts.spotify.com's internal charts-spotify-com-service backend.
 *
 * SECURITY: never logs the sp_dc cookie value or the full access token --
 * only status codes and a short excerpt of the resulting chart data, so
 * nothing sensitive ends up in job logs.
 *
 * Safe to remove once the feature (if built) ships.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SP_DC = process.env.SPOTIFY_SP_DC;

async function main() {
  if (!SP_DC) { console.error('SPOTIFY_SP_DC not set'); process.exit(1); }

  console.log('=== Control: anonymous request (no cookie) -- this same endpoint already works from Vercel in production ===');
  try {
    const controlRes = await fetch('https://open.spotify.com/get_access_token?reason=transport&productType=web_player', {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    console.log(`status=${controlRes.status}`);
    const controlText = await controlRes.text();
    console.log(`body starts with: ${controlText.slice(0, 120)}`);
  } catch (e) {
    console.log(`control ERROR: ${e.message}`);
  }

  console.log('\n=== Minting access token from sp_dc cookie ===');
  const tokenRes = await fetch('https://open.spotify.com/get_access_token?reason=transport&productType=web_player', {
    headers: {
      'User-Agent': UA,
      Cookie: `sp_dc=${SP_DC}`,
    },
  });
  console.log(`status=${tokenRes.status}`);
  const tokenText = await tokenRes.text();
  if (!tokenRes.ok) {
    console.log(`body starts with: ${tokenText.slice(0, 300)}`);
    return;
  }
  const tokenData = JSON.parse(tokenText);
  console.log(`isAnonymous=${tokenData.isAnonymous}`);
  console.log(`clientId=${tokenData.clientId}`);
  console.log(`accessToken present=${!!tokenData.accessToken}, length=${tokenData.accessToken?.length}`);
  console.log(`expires=${tokenData.accessTokenExpirationTimestampMs ? new Date(tokenData.accessTokenExpirationTimestampMs).toISOString() : 'n/a'}`);

  if (tokenData.isAnonymous !== false) {
    console.log('\n*** Cookie did NOT authenticate a real account (isAnonymous is not false). Stopping. ***');
    return;
  }
  if (!tokenData.accessToken) {
    console.log('\n*** No accessToken in response. Stopping. ***');
    return;
  }

  console.log('\n=== Calling charts-spotify-com-service with this token ===');
  const chartRes = await fetch('https://charts-spotify-com-service.spotify.com/auth/v0/charts/artist-global-daily/latest', {
    headers: {
      'User-Agent': UA,
      Authorization: `Bearer ${tokenData.accessToken}`,
      Accept: 'application/json',
      'App-Platform': 'Browser',
    },
  });
  console.log(`status=${chartRes.status}`);
  const text = await chartRes.text();
  console.log(`response length=${text.length}`);

  if (chartRes.ok) {
    const data = JSON.parse(text);
    const entries = data?.displayChart?.entries ?? [];
    console.log(`\nSUCCESS -- got ${entries.length} chart entries`);
    console.log('First 5 artists:');
    for (const e of entries.slice(0, 5)) {
      console.log(`  #${e.chartEntryData.currentRank} ${e.artistMetadata.artistName} (peak #${e.chartEntryData.peakRank}, streak ${e.chartEntryData.appearancesOnChart})`);
    }
    const bp = entries.find(e => ['BLACKPINK', 'JISOO', 'JENNIE', 'ROSÉ', 'LISA'].includes(e.artistMetadata.artistName));
    console.log(bp ? `\nBLACKPINK/member found: #${bp.chartEntryData.currentRank} ${bp.artistMetadata.artistName}` : '\nNo BLACKPINK/member in global top artists right now (expected, if true)');
  } else {
    console.log(`\nFAILED. Body excerpt: ${text.slice(0, 300)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
