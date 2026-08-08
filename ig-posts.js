// ── Featured Instagram content (BLACKPINK & the members) ─────────────────────
// Rendered on the homepage (where the Jennie banner was) and near the top of the
// 10th-anniversary page. TWO separate groups:
//   IG_LETTERS — the members' handwritten anniversary letters (self-hosted images)
//   IG_POSTS   — other Instagram posts, shown as live embeds
// Entry shapes:
//   image card:  { img: '/path.jpg', name: 'JISOO', link: 'https://instagram.com/…' }
//   live embed:  { url: 'https://www.instagram.com/p/XXXX/' }

window.IG_LETTERS = [
  { img: '/anniv-jisoo.jpg',  name: 'JISOO',  link: 'https://www.instagram.com/blackpinkofficial/' },
  { img: '/anniv-jennie.jpg', name: 'JENNIE', link: 'https://www.instagram.com/blackpinkofficial/' },
  { img: '/anniv-rose.jpg',   name: 'ROSÉ',   link: 'https://www.instagram.com/blackpinkofficial/' },
  { img: '/anniv-lisa.jpg',   name: 'LISA',   link: 'https://www.instagram.com/blackpinkofficial/' },
];

window.IG_POSTS = [
  { url: 'https://www.instagram.com/p/Dbvju_ipzwT/' },
  { url: 'https://www.instagram.com/p/DbvkMz_iQYc/' },
  { url: 'https://www.instagram.com/p/DbvklikFCcR/' },
  { url: 'https://www.instagram.com/p/Dbvj6S3z6cZ/' },
  // Lisa's post — add when the link is ready:
  // { url: 'https://www.instagram.com/p/XXXXXXXXXXX/' },
];

// renderIgPosts(containerId, list) — list defaults to IG_POSTS.
window.renderIgPosts = function (containerId, list) {
  var grid = document.getElementById(containerId);
  if (!grid) return;
  var posts = list || window.IG_POSTS || [];
  if (!posts.length) { grid.innerHTML = ''; return; }
  var needsEmbed = false;
  grid.innerHTML = posts.map(function (p) {
    if (p.img) {
      var label = p.name
        ? '<div style="font-family:ui-monospace,SFMono-Regular,monospace;font-size:0.6rem;letter-spacing:0.16em;text-transform:uppercase;color:#FF0066;padding:0.65rem 0.85rem;display:flex;justify-content:space-between;align-items:center;gap:0.5rem;">' +
          '<span>' + p.name + '</span><span style="opacity:0.65;">View on Instagram →</span></div>'
        : '';
      return '<a href="' + (p.link || '#') + '" target="_blank" rel="noopener" ' +
        'style="display:block;width:100%;max-width:340px;border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,0.1);background:#150c13;text-decoration:none;transition:border-color 0.2s;" ' +
        'onmouseover="this.style.borderColor=\'rgba(255,0,102,0.5)\'" onmouseout="this.style.borderColor=\'rgba(255,255,255,0.1)\'">' +
        '<img src="' + p.img + '" alt="' + (p.name || 'BLACKPINK') + ' — 10th anniversary letter to BLINK" loading="lazy" style="display:block;width:100%;height:auto;">' +
        label + '</a>';
    }
    needsEmbed = true;
    return '<blockquote class="instagram-media" data-instgrm-permalink="' + p.url +
      '" data-instgrm-version="14" style="margin:0;max-width:400px;width:100%;min-width:300px;"></blockquote>';
  }).join('');

  if (!needsEmbed) return; // pure image gallery — no external script needed
  if (window.instgrm && window.instgrm.Embeds) { window.instgrm.Embeds.process(); return; }
  if (document.getElementById('ig-embed-js')) return;
  var s = document.createElement('script');
  s.id = 'ig-embed-js';
  s.async = true;
  s.src = 'https://www.instagram.com/embed.js';
  s.onload = function () { if (window.instgrm && window.instgrm.Embeds) window.instgrm.Embeds.process(); };
  document.body.appendChild(s);
};
