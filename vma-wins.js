/* The 2026 VMA wins, and the share card drawn from them.
 *
 * Loaded by BOTH /vmas and /voting. It is the single place a win is recorded:
 * add an entry to WINS and the nomination card lights up on /vmas, the banner
 * appears on the voting board, and the share card draws itself on both. The
 * ceremony runs live and categories land one at a time, so nothing else should
 * ever need editing mid-show.
 *
 *   key  — slug, used for the downloaded filename
 *   card — the data-key of the .video card on /vmas (omit if none)
 *   cat  — must match that card's .nom pill exactly, minus the ↗ / 🔒 / 📸
 *   who  — the artist, as it should read on the card
 *   song — optional; omit for a non-song category like Best Group
 *   note — the line under it. Kept short: it is set at one size and wrapped.
 *   img  — the nominee's picture. Drawn full-bleed on the share card.
 *   voteVideo — the VOTE_CAMPAIGNS video name on /voting, matched exactly.
 *
 * No dependencies — plain canvas, and only the two fonts both pages already
 * load (Bebas Neue, DM Mono).
 */
(function () {
  'use strict';

  var WINS = [
    {
      key: 'lisa-best-pop',
      card: 'lisa-dream',
      cat: 'Best Pop',
      who: 'LISA',
      song: '“Dream”',
      note: 'The only female act in VMAs history to win both Best K-Pop and Best Pop.',
      // The nominee's own picture — the card is built around it. Must be
      // same-origin or the canvas is tainted and nothing can be exported.
      img: '/vote-vma-dream.jpg',
      // Matches the video's name in VOTE_CAMPAIGNS on /voting, exactly.
      voteVideo: 'LISA — “Dream”'
    }
  ];

  var SHOW = '2026 MTV VIDEO MUSIC AWARDS';
  var SITE = 'blinksunited.com';

  // Shrink a line until it fits the width it has, leaving ctx.font at the size
  // that fit. Names and categories vary in length and a card that clips its own
  // headline is worse than a smaller one.
  function fit(ctx, text, maxW, startSize, family, weight) {
    var size = startSize;
    for (;;) {
      ctx.font = (weight ? weight + ' ' : '') + size + 'px "' + family + '", sans-serif';
      if (ctx.measureText(text).width <= maxW || size <= 14) return size;
      size -= Math.max(2, Math.round(size * 0.06));
    }
  }

  // Greedy wrap at the current font. Returns the lines.
  function wrap(ctx, text, maxW) {
    var words = String(text).split(/\s+/), lines = [], line = '';
    for (var i = 0; i < words.length; i++) {
      var probe = line ? line + ' ' + words[i] : words[i];
      if (line && ctx.measureText(probe).width > maxW) { lines.push(line); line = words[i]; }
      else line = probe;
    }
    if (line) lines.push(line);
    return lines;
  }

  // Resolves to the image, or to null — a picture that will not load must not
  // stop the card being made, it just falls back to the text layout.
  function loadWinImage(win) {
    return new Promise(function (res) {
      if (!win || !win.img) return res(null);
      var im = new Image();
      im.onload = function () { res(im); };
      im.onerror = function () { res(null); };
      im.src = win.img;
    });
  }

  function drawWinCard(canvas, win, img) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;

    ctx.fillStyle = '#080808';
    ctx.fillRect(0, 0, W, H);

    if (img) {
      // Cover-fit: fill the card and crop the overflow, rather than letterbox
      // a portrait shot into a square and leave bars down the sides.
      var scale = Math.max(W / img.width, H / img.height);
      var dw = img.width * scale, dh = img.height * scale;
      // Bias the crop upward — on a press shot the face sits above centre, and
      // a straight centre crop cuts the top of the head off.
      ctx.drawImage(img, (W - dw) / 2, (H - dh) * 0.35, dw, dh);

      // Scrim. The text sits top and bottom, so darken both ends hard and let
      // the middle of the picture breathe.
      var scrim = ctx.createLinearGradient(0, 0, 0, H);
      scrim.addColorStop(0,    'rgba(8,8,8,0.88)');
      scrim.addColorStop(0.30, 'rgba(8,8,8,0.42)');
      scrim.addColorStop(0.52, 'rgba(8,8,8,0.26)');
      scrim.addColorStop(0.78, 'rgba(8,8,8,0.93)');
      scrim.addColorStop(1,    'rgba(8,8,8,0.97)');
      ctx.fillStyle = scrim;
      ctx.fillRect(0, 0, W, H);

      // A touch of the pink, so it still reads as ours and not as a still.
      var tint = ctx.createRadialGradient(W / 2, H * 0.82, 0, W / 2, H * 0.82, W * 0.75);
      tint.addColorStop(0, 'rgba(255,0,102,0.22)');
      tint.addColorStop(1, 'rgba(255,0,102,0)');
      ctx.fillStyle = tint;
      ctx.fillRect(0, 0, W, H);
    } else {
      // No picture: the glow carries the card on its own.
      var glow = ctx.createRadialGradient(W / 2, H * 0.46, 0, W / 2, H * 0.46, W * 0.62);
      glow.addColorStop(0, 'rgba(255,0,102,0.24)');
      glow.addColorStop(1, 'rgba(255,0,102,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);
    }

    ctx.fillStyle = '#FF0066';
    ctx.fillRect(0, 0, W, 5);
    ctx.fillRect(0, H - 5, W, 5);

    ctx.textAlign = 'center';

    // The footer is a fixed 120px; everything above is laid out inside A so the
    // card survives a non-square format without landing on top of it.
    var A = H - 120;
    var pad = 80;

    // With a picture the text splits: the award at the top, the win itself
    // along the bottom over the darkest part of the scrim. Without one it
    // stacks down the middle, which is all a text card has.
    var topY  = img ? A * 0.10 : A * 0.16;
    var winY  = img ? A * 0.20 : A * 0.31;
    var catY  = img ? A * 0.28 : A * 0.42;

    // Show name
    ctx.fillStyle = 'rgba(245,240,240,' + (img ? '0.72' : '0.5') + ')';
    ctx.letterSpacing = '6px';
    fit(ctx, SHOW, W - pad * 2, Math.max(14, Math.round(A * 0.021)), 'DM Mono', '500');
    ctx.fillText(SHOW, W / 2, topY);

    // WINNER
    ctx.fillStyle = '#FF0066';
    ctx.letterSpacing = '10px';
    fit(ctx, '🏆 WINNER', W - pad * 2, Math.round(A * 0.075), 'Bebas Neue');
    ctx.fillText('🏆 WINNER', W / 2, winY);

    // Category
    ctx.fillStyle = 'rgba(245,240,240,0.92)';
    ctx.letterSpacing = '5px';
    fit(ctx, win.cat.toUpperCase(), W - pad * 2, Math.round(A * 0.055), 'Bebas Neue');
    ctx.fillText(win.cat.toUpperCase(), W / 2, catY);

    // ── the bottom block, measured from the footer upward ────────────────────
    // Laid out bottom-up so the note never rides over the footer rule however
    // many lines it wraps to — the thing that went wrong on the first cut.
    var noteSize = Math.max(14, Math.round(A * 0.026));
    var noteLines = [];
    if (win.note) {
      ctx.font = '300 ' + noteSize + 'px "DM Mono", monospace';
      ctx.letterSpacing = '1px';
      noteLines = wrap(ctx, win.note, W - pad * 2.4);
      while (noteLines.length > 3 && noteSize > 14) {
        noteSize -= 2;
        ctx.font = '300 ' + noteSize + 'px "DM Mono", monospace';
        noteLines = wrap(ctx, win.note, W - pad * 2.4);
      }
    }
    var lineH   = Math.round(noteSize * 1.5);
    var noteH   = noteLines.length ? (noteLines.length - 1) * lineH : 0;
    var songGap = win.song ? Math.round(A * 0.07) : 0;

    var bottom  = img ? H - 150 : A * 0.98;
    var noteTop = bottom - noteH;
    var songY   = noteTop - (win.note ? Math.round(A * 0.055) : 0);
    var nameY   = songY - songGap - (win.song ? 0 : Math.round(A * 0.02));

    // The name — the thing the card is for
    ctx.letterSpacing = '0px';
    var nameSize = fit(ctx, win.who, W - pad * 2, Math.round(A * (img ? 0.2 : 0.22)), 'Bebas Neue');
    var grad = ctx.createLinearGradient(0, nameY - nameSize * 0.8, 0, nameY + nameSize * 0.1);
    grad.addColorStop(0, '#FFFFFF');
    grad.addColorStop(1, '#FF0066');
    ctx.fillStyle = grad;
    ctx.fillText(win.who, W / 2, nameY);

    // Song
    if (win.song) {
      ctx.fillStyle = 'rgba(245,240,240,0.88)';
      ctx.letterSpacing = '4px';
      fit(ctx, win.song, W - pad * 2, Math.max(15, Math.round(A * 0.033)), 'DM Mono', '500');
      ctx.fillText(win.song, W / 2, songY);
    }

    // The note
    if (noteLines.length) {
      ctx.fillStyle = 'rgba(245,240,240,' + (img ? '0.7' : '0.55') + ')';
      ctx.letterSpacing = '1px';
      ctx.font = '300 ' + noteSize + 'px "DM Mono", monospace';
      for (var i = 0; i < noteLines.length; i++) {
        ctx.fillText(noteLines[i], W / 2, noteTop + i * lineH);
      }
    }

    // Footer
    ctx.fillStyle = 'rgba(255,0,102,0.25)';
    ctx.fillRect(pad, H - 120, W - pad * 2, 1);
    ctx.fillStyle = 'rgba(245,240,240,0.45)';
    ctx.letterSpacing = '5px';
    fit(ctx, SITE, W - pad * 2, Math.max(13, Math.round(A * 0.02)), 'DM Mono', '500');
    ctx.fillText(SITE, W / 2, H - 62);
    ctx.letterSpacing = '0px';
  }

  function shareText(win) {
    return '🏆 ' + win.who + ' won ' + win.cat
      + (win.song ? ' for ' + win.song : '') + ' at the ' + SHOW.replace('2026 ', '2026 ')
      + (win.note ? ' — ' + win.note : '');
  }

  // Build the card and hand it to the OS share sheet. Falls back to a download
  // wherever file sharing is not available (most desktops), because a card the
  // browser refuses to share is still a card worth keeping.
  async function shareWin(win, btn) {
    var label = btn && btn.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Making card…'; }
    try {
      var canvas = document.createElement('canvas');
      canvas.width = 1080; canvas.height = 1080;
      try { await document.fonts.ready; } catch (_) {}
      var img = await loadWinImage(win);
      drawWinCard(canvas, win, img);

      var blob = await new Promise(function (res) { canvas.toBlob(res, 'image/png'); });
      if (!blob) throw new Error('toBlob returned nothing');

      var name = 'blinksunited-' + (win.key || 'vma-win') + '.png';
      var file = new File([blob], name, { type: 'image/png' });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], text: shareText(win) });
          return;
        } catch (err) {
          // A dismissed share sheet is not a failure — do not then dump a file
          // into their downloads for a share they cancelled.
          if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return;
        }
      }

      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      if (btn) { btn.textContent = 'Saved ✓'; }
      return;
    } catch (err) {
      if (btn) { btn.textContent = 'Couldn’t make it'; }
      try { console.log('[BU wins] share failed:', err); } catch (_) {}
    } finally {
      if (btn) {
        setTimeout(function () { btn.disabled = false; btn.textContent = label; }, 1800);
      }
    }
  }

  window.BU_VMA_WINS = WINS;
  window.BUWinCard = { draw: drawWinCard, share: shareWin, text: shareText, show: SHOW, loadImage: loadWinImage };
})();
