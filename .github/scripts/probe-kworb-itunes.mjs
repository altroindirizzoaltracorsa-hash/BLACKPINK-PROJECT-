/**
 * One-off diagnostic: discovers kworb.net's iTunes chart URL structure and
 * table format so we can replace Apple's broken/limited RSS feed with a
 * kworb scraper (same approach used for Spotify via fetch_chart_positions.mjs).
 *
 * Checks: index page, candidate URL patterns, thead/row structure, whether
 * BLACKPINK/member tracks currently appear in US + KR + a few others.
 *
 * Safe to remove after fetch_itunes_chart_positions.mjs is rebuilt on kworb.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CANDIDATE_URLS = [
  'https://kworb.net/itunes/',
  'https://kworb.net/itunes/us_daily.html',
  'https://kworb.net/itunes/us_daily_song.html',
  'https://kworb.net/itunes/country/us_daily.html',
  'https://kworb.net/itunes/us.html',
  'https://kworb.net/apple_music/us_daily.html',
  'https://kworb.net/apple_music/country/us_daily.html',
  'https://kworb.net/apple/us_daily.html',
];

const ARTIST_NAMES = ['blackpink', 'jennie', 'jisoo', 'rosé', 'rose', 'lisa'];

async function probe(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
    if (!r.ok) { console.log(`${url} -> HTTP ${r.status}`); return null; }
    const html = await r.text();
    console.log(`${url} -> OK (${html.length} bytes)`);
    return html;
  } catch (e) {
    console.log(`${url} -> ERROR ${e.message}`);
    return null;
  }
}

function analyzeTable(html, label) {
  const theadMatch = html.match(/<thead[\s\S]*?<\/thead>/i);
  if (theadMatch) {
    console.log(`\n[${label}] thead:\n${theadMatch[0].slice(0, 600)}`);
  } else {
    console.log(`\n[${label}] no <thead> found`);
  }

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const rows = [];
  let m;
  while ((m = rowRe.exec(html))) {
    if (!m[1].includes('<th')) rows.push(m[0]);
  }
  console.log(`[${label}] data rows: ${rows.length}`);
  if (rows[0]) console.log(`[${label}] first data row:\n${rows[0].slice(0, 800)}`);

  const matches = rows.filter(r => ARTIST_NAMES.some(name => r.toLowerCase().includes(name)));
  console.log(`[${label}] BP/member rows: ${matches.length}`);
  for (const row of matches.slice(0, 5)) {
    const text = row.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    console.log(`  ${text}`);
  }
}

async function main() {
  console.log('=== Probing kworb iTunes URL patterns ===\n');

  // First: check the kworb iTunes index page for all linked pages
  const indexHtml = await probe('https://kworb.net/itunes/');
  if (indexHtml) {
    const links = [...indexHtml.matchAll(/href="([^"]+\.html)"/gi)].map(m => m[1]);
    const uniqueLinks = [...new Set(links)].slice(0, 40);
    console.log('\n[index] linked .html pages:');
    uniqueLinks.forEach(l => console.log(`  ${l}`));
  }

  console.log('\n=== URL candidate probes ===');
  let workingUrl = null;
  for (const url of CANDIDATE_URLS.slice(1)) { // skip index, already done
    const html = await probe(url);
    if (html && !workingUrl) {
      workingUrl = url;
      analyzeTable(html, url.split('/').pop());
    }
  }

  // If we found a working URL, try a few more countries
  if (workingUrl) {
    const base = workingUrl.replace(/us_daily.*/, '');
    const testRegions = ['kr', 'gb', 'jp', 'tw'];
    console.log(`\n=== Per-country tests (base: ${base}) ===`);
    for (const cc of testRegions) {
      const url = workingUrl.replace('/us', `/${cc}`);
      const html = await probe(url);
      if (html) {
        const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        const rows = [];
        let m;
        while ((m = rowRe.exec(html))) {
          if (!m[1].includes('<th')) rows.push(m[0]);
        }
        const matches = rows.filter(r => ARTIST_NAMES.some(name => r.toLowerCase().includes(name)));
        console.log(`  [${cc}] ${rows.length} rows, ${matches.length} BP hits`);
        for (const row of matches.slice(0, 3)) {
          console.log('    ' + row.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180));
        }
      }
    }
  } else {
    console.log('\nNo working URL found — dumping kworb.net root links for manual inspection:');
    const rootHtml = await probe('https://kworb.net/');
    if (rootHtml) {
      const links = [...rootHtml.matchAll(/href="([^"]+)"/gi)].map(m => m[1]).filter(l => l.includes('itunes') || l.includes('apple'));
      console.log([...new Set(links)].slice(0, 30));
    }
  }

  console.log('\n=== Done ===');
}

main().catch(e => { console.error(e); process.exit(1); });
