"""Rebuild "SOMEONE TO HOLD" in the Steps lettering, from the trailer.

The body of the title is the film's CREDIT face — the same face the trailer
uses for "FEATURING AN ORIGINAL SONG BY / JENNIE" — cut from the eight cast
lines, which between them carry every letter this title needs. Each glyph is
cut from the frame, traced to a vector outline, normalised onto one baseline
and set with the spacing measured from the source lines.

The leading S is different: it is the big swash S of the STEPS logotype, used
as an ornamental initial the way the logo itself uses it. Its size and the
height it rides above and below the line are not invented — they are measured
off the logo, from the S against the smaller letters beside it, and reproduced.

Normalisation is per SOURCE LINE, not per glyph: a glyph is placed by its own
line's baseline and cap height, so round letters keep the overshoot they are
drawn with instead of being squashed to the same box as a flat-sided one.

Two things this gets right the hard way:
  * potrace emits RELATIVE path commands, so the outlines are never rewritten
    coordinate by coordinate — each glyph is placed with a <g transform>, which
    is correct for relative data by construction.
  * potrace traces BLACK as ink, so the mask is inverted before tracing.

Run with -I: it reads a frame out of an untrusted upload directory.
"""
import re
import subprocess
import sys
import numpy as np
from PIL import Image
from scipy import ndimage

FRAME, LOGO_FRAME, OUT_SVG, WORK = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

# Lines 6-7 ("with PETER DINKLAGE" / "and BETTE MIDLER") are deliberately
# unused: their small-caps words merge under the threshold, so their glyph
# counts do not match the strings and an index into them cannot be trusted.
LINES = {
    0: 'ALIWONG',
    1: 'AMANDASEYFRIED',
    2: 'STEPHANIEHSU',
    3: 'NIKKIGLASER',
    4: 'DANIELRADCLIFFE',
    5: 'YOUNGMAZINO',
}
PICK = {
    'S': (2, 0), 'T': (2, 1), 'E': (2, 2), 'H': (2, 4), 'N': (2, 6),
    'O': (5, 1), 'M': (5, 5), 'L': (4, 5), 'D': (4, 0),
}
WORD = 'SOMEONE TO HOLD'

LETTER_GAP = 0.05     # measured off the source lines, as a fraction of cap height
WORD_GAP = 0.45
CAP = 1000.0          # cap height in the SVG's own units
TRACE_SCALE = 4       # upscale before tracing, for smoother outlines
# Referenced with <img>, so the fill has to be literal: currentColor inside an
# <img> resolves against the SVG's own document and comes out black.
FILL = '#ff8fc4'
# Two different cuts, for two different jobs. SEG_THRESH is low so a whole
# glyph lands in one connected component. TRACE_THRESH is where the OUTLINE
# goes, and the glyphs carry a heavy bloom: cutting at 90 fattens every stem
# and blobs the flared serif tips, so it sits near the core instead (checked
# against the source S at 90/120/140/160/180).
SEG_THRESH = 90
TRACE_THRESH = 180

# The logo frame holds exactly five pieces: the big S, the swash-plus-t, the
# final S, the P and the E. Anything else means the frame or the threshold
# moved and the "leftmost is the S" rule below can no longer be trusted.
LOGO_PARTS = 5
LOGO_MIN_H, LOGO_MIN_AREA = 60, 2000
SWASH_TUCK = -0.08   # tuck the next letter under the initial's upper arm, as the logo does


def glyph_lines(frame):
    a = np.asarray(Image.open(frame).convert('RGB'), dtype=np.float32)
    lum = a.max(axis=2)
    lab, _ = ndimage.label(lum > SEG_THRESH)
    boxes = []
    for i, sl in enumerate(ndimage.find_objects(lab), start=1):
        ys, xs = sl
        if (ys.stop - ys.start) < 22 or (xs.stop - xs.start) < 6 or int((lab[sl] == i).sum()) < 90:
            continue
        # Re-measure the box at the TRACE cut, inside this component: the
        # SEG cut sits in the bloom, so its box is fatter than the ink that
        # actually gets drawn. Spacing and cap height must match the ink.
        ink = (lab[sl] == i) & (lum[sl] > TRACE_THRESH)
        if not ink.any():
            continue
        ry, rx = np.where(ink)
        boxes.append((xs.start + int(rx.min()), ys.start + int(ry.min()),
                      xs.start + int(rx.max()) + 1, ys.start + int(ry.max()) + 1, i))
    boxes.sort(key=lambda b: b[1])
    lines = []
    for b in boxes:
        mid = (b[1] + b[3]) / 2
        for ln in lines:
            if ln['y0'] - 12 <= mid <= ln['y1'] + 12:
                ln['items'].append(b)
                ln['y0'] = min(ln['y0'], b[1]); ln['y1'] = max(ln['y1'], b[3])
                break
        else:
            lines.append({'y0': b[1], 'y1': b[3], 'items': [b]})
    for ln in lines:
        ln['items'].sort(key=lambda b: b[0])
    lines.sort(key=lambda ln: ln['y0'])
    return lum, lab, lines


def line_metrics(items):
    """A line's baseline and cap height, from its full-height glyphs only.
    Medians, so a swashed or round letter cannot drag the line off true."""
    hs = sorted(b[3] - b[1] for b in items)
    tall = hs[len(hs) // 2]
    full = [b for b in items if (b[3] - b[1]) > tall * 0.8]
    return float(np.median([b[1] for b in full])), float(np.median([b[3] for b in full]))


def trace(gray, tag):
    """Greyscale ink crop -> (raw potrace path d-strings, its own transform).

    The GREYSCALE is upscaled and only then thresholded, so the frame's own
    antialiased edges set where the outline falls. Thresholding first and
    upscaling the resulting staircase is what made the first attempt lumpy."""
    big = Image.fromarray(np.clip(gray, 0, 255).astype(np.uint8)).resize(
        (gray.shape[1] * TRACE_SCALE, gray.shape[0] * TRACE_SCALE), Image.LANCZOS)
    # potrace treats BLACK as ink, so invert.
    big = big.point(lambda v: 0 if v > TRACE_THRESH else 255).convert('1')
    pbm, svg = f'{WORK}/{tag}.pbm', f'{WORK}/{tag}.svg'
    big.save(pbm)
    subprocess.run(['potrace', '-s', '-o', svg, '-a', '1.2', '-O', '0.35', '-t', '6',
                    '-u', '1', pbm], check=True)
    text = open(svg).read()
    m = re.search(r'<g transform="translate\(([-\d.]+),([-\d.]+)\) scale\(([-\d.]+),([-\d.]+)\)"', text)
    if not m:
        raise SystemExit(f'potrace output for {tag} has no transform group')
    return re.findall(r'<path[^>]*\bd="([^"]+)"', text), tuple(float(v) for v in m.groups())


def logo_initial(frame):
    """The STEPS logotype's leading S, with the proportions it has in the logo.

    Returns the traced S plus how tall it is, and how far it rides above the
    cap line and below the baseline, each as a multiple of the SMALL letters'
    cap height in the logo — so the initial keeps its real relationship to the
    text beside it instead of a guessed one."""
    lum = np.asarray(Image.open(frame).convert('RGB'), dtype=np.float32).max(axis=2)
    lab, _ = ndimage.label(lum > SEG_THRESH)
    parts = []
    for i, sl in enumerate(ndimage.find_objects(lab), start=1):
        ys, xs = sl
        if (ys.stop - ys.start) < LOGO_MIN_H or int((lab[sl] == i).sum()) < LOGO_MIN_AREA:
            continue
        ink = (lab[sl] == i) & (lum[sl] > TRACE_THRESH)
        if not ink.any():
            continue
        ry, rx = np.where(ink)
        parts.append((xs.start + int(rx.min()), ys.start + int(ry.min()),
                      xs.start + int(rx.max()) + 1, ys.start + int(ry.max()) + 1, i))
    if len(parts) != LOGO_PARTS:
        raise SystemExit(f'logo frame has {len(parts)} pieces, expected {LOGO_PARTS} '
                         '— "leftmost piece is the S" is no longer safe')
    parts.sort(key=lambda b: b[0])
    S = parts[0]
    # The two shortest pieces are the plain small letters (E and P); the swash
    # and the final S both run tall, so they cannot set the line.
    smalls = sorted(parts, key=lambda b: b[3] - b[1])[:2]
    cap_top = float(np.median([b[1] for b in smalls]))
    baseline = float(np.median([b[3] for b in smalls]))
    cap = baseline - cap_top
    x0, y0, x1, y1, comp = S
    above, below = (cap_top - y0) / cap, (y1 - baseline) / cap
    if not (0.2 <= above <= 1.0 and 0.05 <= below <= 0.8):
        raise SystemExit(f'logo S sits oddly against its own line (above={above:.2f}, '
                         f'below={below:.2f}) — the pieces were probably mis-identified')
    pad = 3
    ox, oy = max(0, x0 - pad), max(0, y0 - pad)
    sub = lum[oy:y1 + pad, ox:x1 + pad].copy()
    sub[lab[oy:y1 + pad, ox:x1 + pad] != comp] = 0
    paths, xf = trace(sub, 'SWASH')
    return {'paths': paths, 'xf': xf, 'ox': ox, 'oy': oy,
            'px': (x0, y0, x1, y1), 'above': above, 'below': below,
            'h_ratio': (y1 - y0) / cap}


lum, lab, lines = glyph_lines(FRAME)
for k, want in LINES.items():
    if len(lines[k]['items']) != len(want):
        raise SystemExit(f'line {k}: {len(lines[k]["items"])} glyphs but "{want}" has {len(want)} '
                         '— every index below would be off')

glyphs = {}
for ch, (ln, idx) in PICK.items():
    assert LINES[ln][idx] == ch, f'{ch} is not at index {idx} of line {ln} ({LINES[ln]})'
    items = lines[ln]['items']
    cap_top, baseline = line_metrics(items)
    k = CAP / (baseline - cap_top)              # frame pixels -> SVG units
    x0, y0, x1, y1, comp = items[idx]
    pad = 3
    ox, oy = max(0, x0 - pad), max(0, y0 - pad)
    # Gate on the connected component, not the crop rectangle: letters are set
    # tight here, and a neighbour's edge otherwise leaks into the cut.
    sub = lum[oy:y1 + pad, ox:x1 + pad].copy()
    sub[lab[oy:y1 + pad, ox:x1 + pad] != comp] = 0
    paths, (tx, ty, sx, sy) = trace(sub, ch)
    # potrace point P maps to crop pixel ((tx + P.x*sx)/TRACE_SCALE,
    # (ty + P.y*sy)/TRACE_SCALE); then + (ox, oy - baseline), then * k. As a
    # single affine, applied by the group rather than to the path data:
    s = k / TRACE_SCALE
    glyphs[ch] = {
        'paths': paths,
        'sx': s * sx, 'sy': s * sy,
        'tx': (tx / TRACE_SCALE + ox) * k,
        'ty': (ty / TRACE_SCALE + oy - baseline) * k,
        # Ink extent, straight from the connected component — exact, and it
        # needs no reading of the path data.
        'x0': x0 * k, 'x1': x1 * k,
        'y0': (y0 - baseline) * k, 'y1': (y1 - baseline) * k,
        'src': (ln, idx),
    }

# The ornamental initial, scaled and placed by the logo's own proportions.
sw = logo_initial(LOGO_FRAME)
sx0, sy0, sx1, sy1 = sw['px']
ks = (sw['h_ratio'] * CAP) / (sy1 - sy0)          # logo pixels -> SVG units
stx, sty, ssx, ssy = sw['xf']
sw_top = -CAP - sw['above'] * CAP                 # above the cap line, as in the logo
glyphs['\x01'] = {
    'paths': sw['paths'],
    'sx': (ks / TRACE_SCALE) * ssx, 'sy': (ks / TRACE_SCALE) * ssy,
    'tx': (stx / TRACE_SCALE + sw['ox']) * ks,
    'ty': (sty / TRACE_SCALE + sw['oy']) * ks - (sy0 * ks - sw_top),
    'x0': sx0 * ks, 'x1': sx1 * ks,
    'y0': sw_top, 'y1': sw_top + (sy1 - sy0) * ks,
    'src': ('logo', 'S'),
}
# \x01 stands in for the swash S, so the plain S stays available for the
# other S positions — this word has none, but the substitution should not
# quietly depend on that.
LAID = '\x01' + WORD[1:]

gap, wordgap = LETTER_GAP * CAP, WORD_GAP * CAP
pen, groups, ext_y, body_y = 0.0, [], [], []
for ch in LAID:
    if ch == ' ':
        pen += wordgap
        continue
    g = glyphs[ch]
    dx = pen - g['x0']
    groups.append(f'    <g transform="translate({g["tx"] + dx:.2f},{g["ty"]:.2f}) '
                  f'scale({g["sx"]:.5f},{g["sy"]:.5f})">'
                  + ''.join(f'<path d="{d}"/>' for d in g['paths']) + '</g>')
    ext_y += [g['y0'], g['y1']]
    if ch != '\x01':
        body_y += [g['y0'], g['y1']]
    pen += (g['x1'] - g['x0']) + gap + (SWASH_TUCK * CAP if ch == '\x01' else 0.0)
width = pen - gap
top, bot = min(ext_y), max(ext_y)
btop, bbot = min(body_y), max(body_y)

# The BODY letters are checked, not the whole mark: they run from -CAP to 0
# with a little overshoot on the round ones, and the initial is supposed to
# break that line. Anything far off means a transform is wrong rather than a
# letter being unusual — this is what caught a 4x trace upscale that had been
# baked into the coordinates.
if not (1.0 * CAP <= (bbot - btop) <= 1.35 * CAP):
    raise SystemExit(f'body letters span {(bbot - btop) / CAP:.2f}x cap height — expected ~1.0-1.15x')
if abs(btop + CAP) > 0.12 * CAP or abs(bbot) > 0.12 * CAP:
    raise SystemExit(f'body letters are off the baseline (top={btop:.0f}, bottom={bbot:.0f}; '
                     f'expected ~{-CAP:.0f} and ~0)')
# And the initial must be the one breaking it, in both directions.
if not (top < btop - 0.1 * CAP and bot > bbot + 0.02 * CAP):
    raise SystemExit(f'the swash initial does not overhang the line it should '
                     f'(mark {top:.0f}..{bot:.0f} vs body {btop:.0f}..{bbot:.0f})')

m = 0.03 * CAP
vb = (-m, top - m, width + 2 * m, (bot - top) + 2 * m)
svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb[0]:.1f} {vb[1]:.1f} {vb[2]:.1f} {vb[3]:.1f}" '
       f'role="img" aria-label="Someone to Hold">\n'
       f'  <title>Someone to Hold</title>\n  <g fill="{FILL}">\n'
       + '\n'.join(groups) + '\n  </g>\n</svg>\n')
open(OUT_SVG, 'w').write(svg)

print(f'{len(groups)} glyphs placed')
print('body: ' + '  '.join(f'{c}=line{g["src"][0]}[{g["src"][1]}]'
                           for c, g in sorted(glyphs.items()) if c != '\x01'))
print(f'initial: STEPS logotype S — {sw["h_ratio"]:.2f}x the logo\'s own cap height, '
      f'riding {sw["above"]:.2f} above and {sw["below"]:.2f} below its line')
print(f'cap height {CAP:.0f}, body {btop:.0f}..{bbot:.0f}, whole mark {top:.0f}..{bot:.0f}, '
      f'aspect {vb[2] / vb[3]:.2f}:1, {len(svg)} bytes')
