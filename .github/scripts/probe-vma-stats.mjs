// Probe MTV's VMA statistics endpoint (voteapi.votenow.tv) to see whether the live
// category standings — BLACKPINK's share in Best Pop / Best K-pop — are actually
// readable, or whether MTV hides/normalises them (roundingLogic=onair,
// excludeHiddenFields=true). Read-only GETs, the same the vote page makes itself.
//
// campaignId 1015731 was captured from a live request; we don't yet know which
// category it is — the response body should reveal nominee names.

const API = 'vma2026turbo';
const CIDS = ['1015731'];

const COMMON = {
  'Origin': 'https://vote.mtv.com',
  'Referer': 'https://vote.mtv.com/',
  'Accept': 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (probe) AppleWebKit/537.36',
};

async function hit(label, url, headers) {
  try {
    const r = await fetch(url, { headers });
    const text = await r.text();
    console.log(`\n===== ${label} =====`);
    console.log('URL:', url);
    console.log('HTTP', r.status, r.statusText);
    console.log('content-type:', r.headers.get('content-type'));
    console.log('body (first 6000 chars):');
    console.log(text.slice(0, 6000));
  } catch (e) {
    console.log(`\n===== ${label} ===== ERROR`, String(e).slice(0, 300));
  }
}

for (const cid of CIDS) {
  const stats = `https://voteapi.votenow.tv/s2/campaigns/statistics?v=1&properties=true&excludeHiddenFields=true&roundingLogic=onair&apiKey=${API}&campaignId=${cid}`;
  await hit(`statistics cid=${cid} (site headers)`, stats, COMMON);

  // Same, but WITHOUT excludeHiddenFields — maybe raw counts come back.
  const statsRaw = `https://voteapi.votenow.tv/s2/campaigns/statistics?v=1&properties=true&roundingLogic=raw&apiKey=${API}&campaignId=${cid}`;
  await hit(`statistics cid=${cid} (roundingLogic=raw, no exclude)`, statsRaw, COMMON);

  // Campaign metadata — often lists the nominees/slots so we can label the numbers.
  const meta = `https://voteapi.votenow.tv/s2/campaigns?v=1&properties=true&apiKey=${API}&campaignId=${cid}`;
  await hit(`campaign meta cid=${cid}`, meta, COMMON);
}
