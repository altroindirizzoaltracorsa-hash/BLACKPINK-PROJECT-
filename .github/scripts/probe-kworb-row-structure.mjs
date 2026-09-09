/**
 * One-off diagnostic: dumps the raw <thead> and one matching <tr> (ROSÉ - APT.)
 * from kworb.net's global daily chart page, so we can build an accurate
 * column-index-based parser instead of guessing from flattened text.
 * Safe to remove once the Charts feature is built.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function main() {
  const url = 'https://kworb.net/spotify/country/global_daily.html';
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
  const html = await r.text();

  const theadMatch = html.match(/<thead>[\s\S]*?<\/thead>/);
  console.log('=== <thead> ===');
  console.log(theadMatch ? theadMatch[0] : 'NOT FOUND');

  // Find the row containing "APT." (ROSÉ track) -- print its raw HTML untouched.
  const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
  let m;
  let found = 0;
  while ((m = rowRe.exec(html))) {
    if (m[1].includes('APT.') && found < 1) {
      console.log('\n=== raw <tr> for APT. row ===');
      console.log(m[0]);
      found++;
    }
  }
  if (!found) console.log('\nAPT. row not found on this page today');

  // Also print the very first data row regardless of content, for a second reference point.
  rowRe.lastIndex = 0;
  const rows = [];
  while ((m = rowRe.exec(html))) rows.push(m[0]);
  console.log('\n=== first 2 raw <tr> rows (any content) ===');
  console.log(rows.slice(0, 2).join('\n---\n'));
}

main().catch(e => { console.error(e); process.exit(1); });
