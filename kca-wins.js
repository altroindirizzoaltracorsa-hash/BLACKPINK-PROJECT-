/* The 2026 Kids' Choice Awards wins.
 *
 * DATA ONLY. The card is drawn by /vma-wins.js, which exposes window.BUWinCard
 * and is not really VMA-specific below its own list — it draws whatever win it
 * is handed. The only thing that was: the show name, a module constant. A win
 * can now carry its own `show`, so this file needs no second copy of a canvas
 * renderer, and a fix to the card is a fix to both awards at once.
 *
 * Same field names as the VMA list, so a reader moving between the two is not
 * learning a second vocabulary:
 *
 *   key  — slug, used for the downloaded filename
 *   cat  — the category, exactly as the ballot names it
 *   who  — the artist, as it should read on the card
 *   song — optional; omit for a non-song category
 *   note — the line under it. Kept short: set at one size and wrapped.
 *   show — the award, in caps, for the top of the card and the share text
 *   img  — optional picture, drawn full-bleed. Omitted here: there is no
 *          KCA-specific photograph of either win in the repo, and reusing a
 *          promo shot from another campaign would caption itself wrongly.
 *          BUWinCard draws the type on its own ground without one.
 *
 * WHAT IS NOT HERE, and must not be added without being told: how BINI and
 * Ahn Hyo-seop finished. The vote trade ran across both fandoms' categories
 * and nobody has reported their results to us. A missing entry is "not told",
 * never a loss — the same rule the collab page's results block follows.
 */
(function () {
  'use strict';

  var SHOW = "2026 NICKELODEON KIDS' CHOICE AWARDS";

  window.BU_KCA_WINS = [
    {
      key: 'jennie-favorite-music-collaboration',
      cat: 'Favorite Music Collaboration',
      who: 'JENNIE',
      song: '“Dracula”',
      note: 'Voted for by blinks, and by BLOOMs and Pauljjak through the vote trade.',
      show: SHOW,
    },
    {
      key: 'rose-favorite-female-artist',
      cat: 'Favorite Female Artist',
      who: 'ROSÉ',
      note: 'The category she was not even part of the agreement for — the other fandoms voted it anyway.',
      show: SHOW,
    },
  ];
})();
