/**
 * One-off diagnostic: checks whether kworb.net's per-country Spotify Daily
 * Top 200 pages are reachable and scrapeable, and whether any BLACKPINK/
 * member tracks currently appear in them. This is step 1 toward a REAL
 * regional charts feature (actual Spotify Top 200 rank per country), not
 * the wrong "re-sort our own streams" version from before.
 * Safe to remove once the Charts feature is built.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// A representative sample of region codes kworb tracks -- global plus a few
// markets BLACKPINK/members are known to chart in.
const REGIONS = ['global', 'us', 'gb', 'kr', 'fr', 'de', 'br', 'mx', 'jp', 'au', 'ca'];

const ARTIST_NAMES = ['blackpink', 'jennie', 'jisoo', 'rosé', 'rose', 'lisa'];

async function fetchRegion(region) {
  const url = `https://kworb.net/spotify/country/${region}_daily.html`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
  if (!r.ok) return { region, url, ok: false, status: r.status };
  const html = await r.text();
  return { region, url, ok: true, length: html.length, html };
}

function extractRows(html) {
  // kworb daily chart tables: <tr><td>pos</td>...<td class="mp"><a href="...">Artist</a></td><td><a href="...track...">Title</a></td>...<td>streams</td>...</tr>
  // Keep this loose -- we just need position + a text blob per row to text-match artist names against.
  const rows = [];
  const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(html))) {
    const rowHtml = m[1];
    const posMatch = rowHtml.match(/^\s*<td[^>]*>(\d+)<\/td>/);
    if (!posMatch) continue;
    const textOnly = rowHtml.replace(/<[^>]+>/g, ' | ').replace(/\s+/g, ' ').trim();
    rows.push({ pos: Number(posMatch[1]), text: textOnly });
  }
  return rows;
}

async function main() {
  for (const region of REGIONS) {
    let result;
    try {
      result = await fetchRegion(region);
    } catch (e) {
      console.log(`${region}: FETCH ERROR ${e.message}`);
      continue;
    }
    if (!result.ok) {
      console.log(`${region}: HTTP ${result.status} (${result.url})`);
      continue;
    }
    const rows = extractRows(result.html);
    console.log(`${region}: reachable, ${result.length} bytes, parsed ${rows.length} chart rows`);
    const matches = rows.filter(r => ARTIST_NAMES.some(name => r.text.toLowerCase().includes(name)));
    if (matches.length) {
      console.log(`  MATCHES (${matches.length}):`);
      for (const mrow of matches.slice(0, 10)) console.log(`    #${mrow.pos}: ${mrow.text.slice(0, 160)}`);
    } else {
      console.log('  no BLACKPINK/member matches found on this page');
      console.log(`  sample row for debugging: ${JSON.stringify(rows[0] || null)}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
