// ============================================================
// BLACKPINK Spotify Stats Loader
// Reads from data/stats.json — no API calls from visitors!
// ============================================================

const ARTISTS = [
  { key: 'blackpink', name: 'BLACKPINK',  color: '#ff006e' },
  { key: 'jisoo',     name: 'JISOO',      color: '#ff85a1' },
  { key: 'jennie',    name: 'JENNIE',      color: '#ffbe0b' },
  { key: 'lisa',      name: 'LISA',        color: '#8338ec' },
  { key: 'rose',      name: 'ROSÉ',        color: '#fb5607' },
];

// Format big numbers nicely: 12345678 → "12.3M"
function formatNumber(num) {
  if (!num && num !== 0) return '—';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000)     return (num / 1_000).toFixed(1) + 'K';
  return num.toLocaleString();
}

// Format date nicely
function formatDate(isoString) {
  if (!isoString || isoString === 'never') return 'Not yet fetched';
  const d = new Date(isoString);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Extract the stats we care about from the API response
function extractStats(artistData) {
  if (!artistData || Object.keys(artistData).length === 0) {
    return { monthlyListeners: null, followers: null, popularity: null };
  }
  return {
    monthlyListeners: artistData?.stats?.monthlyListeners ?? null,
    followers:        artistData?.stats?.followers        ?? null,
    popularity:       artistData?.stats?.popularity       ?? null,
    name:             artistData?.name                    ?? null,
    image:            artistData?.visuals?.avatarImage?.sources?.[0]?.url ?? null,
  };
}

// Main function — call this from your HTML page
async function loadSpotifyStats() {
  // Find the container in your HTML (id="spotify-stats")
  const container = document.getElementById('spotify-stats');
  if (!container) {
    console.warn('No element with id="spotify-stats" found.');
    return;
  }

  container.innerHTML = '<p style="text-align:center;opacity:0.6;">Loading stats...</p>';

  let data;
  try {
    // Fetch from your repo — GitHub Pages serves this file automatically
    const res = await fetch('./data/stats.json');
    if (!res.ok) throw new Error('Could not load stats.json');
    data = await res.json();
  } catch (err) {
    container.innerHTML = '<p style="color:red;">Could not load stats. Please try again later.</p>';
    console.error(err);
    return;
  }

  const lastUpdated = formatDate(data.lastUpdated);

  let html = `
    <p class="stats-updated">Last updated: ${lastUpdated}</p>
    <div class="stats-grid">
  `;

  for (const artist of ARTISTS) {
    const raw   = data.artists?.[artist.key] ?? {};
    const stats = extractStats(raw);

    const imgHtml = stats.image
      ? `<img src="${stats.image}" alt="${artist.name}" class="stats-artist-img" />`
      : `<div class="stats-artist-img stats-artist-img--placeholder"></div>`;

    html += `
      <div class="stats-card" style="--accent: ${artist.color}">
        ${imgHtml}
        <h3 class="stats-artist-name">${artist.name}</h3>
        <div class="stats-row">
          <span class="stats-label">Monthly Listeners</span>
          <span class="stats-value">${formatNumber(stats.monthlyListeners)}</span>
        </div>
        <div class="stats-row">
          <span class="stats-label">Followers</span>
          <span class="stats-value">${formatNumber(stats.followers)}</span>
        </div>
        <div class="stats-row">
          <span class="stats-label">Popularity</span>
          <span class="stats-value">${stats.popularity ?? '—'} / 100</span>
        </div>
      </div>
    `;
  }

  html += `</div>`;
  container.innerHTML = html;
}

// Auto-load when the page is ready
document.addEventListener('DOMContentLoaded', loadSpotifyStats);
