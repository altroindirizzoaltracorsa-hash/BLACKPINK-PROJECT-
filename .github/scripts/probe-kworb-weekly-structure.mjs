/**
 * One-off diagnostic: checks whether kworb.net's weekly per-country chart
 * pages (global_weekly.html etc.) exist and share the same table structure
 * as the daily pages, so fetch_chart_positions.mjs can be extended to cover
 * both chart types.
 * Safe to remove once the Charts feature is built.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function main() {
  const url = 'https://kworb.net/spotify/country/global_weekly.html';
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
  console.log(`status=${r.status}`);
  if (!r.ok) return;
  const html = await r.text();
  console.log(`length=${html.length}`);

  const theadMatch = html.match(/<thead>[\s\S]*?<\/thead>/);
  console.log('\n=== <thead> ===');
  console.log(theadMatch ? theadMatch[0] : 'NOT FOUND');

  const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
  let m;
  const rows = [];
  while ((m = rowRe.exec(html))) rows.push(m[0]);
  console.log('\n=== first data row ===');
  console.log(rows[1] || 'NONE');

  // Also check for our tracked artists directly on this page.
  const ids = ['41MozSoPIsD1dJM0CLPjZF', '6UZ0ba50XreR4TM8u322gs', '250b0Wlc5Vk0CoUsaCY84M', '3eVa5w3URK5duf6eyVDbu9', '5L1lO4eRHmJ7a0Q6csE5cT'];
  console.log('\n=== tracked artist ID occurrences ===');
  for (const id of ids) {
    const count = (html.match(new RegExp(id, 'g')) || []).length;
    console.log(`${id}: ${count}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
