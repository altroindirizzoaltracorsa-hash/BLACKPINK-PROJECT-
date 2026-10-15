"""Rebuild "SOMEONE TO HOLD" in the Steps credit lettering, from the trailer.

The film's logotype is custom swash lettering and gives only S/T/E/P, but the
eight cast lines are set in the film's CREDIT face — the same face the trailer
uses for "FEATURING AN ORIGINAL SONG BY / JENNIE" — and between them they carry
every letter this title needs. So each glyph is cut from the frame, traced to a
vector outline, normalised onto one baseline and set with the spacing measured
from the source lines.

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

FRAME, OUT_SVG, WORK = sys.argv[1], sys.argv[2], sys.argv[3]

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

gap, wordgap = LETTER_GAP * CAP, WORD_GAP * CAP
pen, groups, ext_y = 0.0, [], []
for ch in WORD:
    if ch == ' ':
        pen += wordgap
        continue
    g = glyphs[ch]
    dx = pen - g['x0']
    groups.append(f'    <g transform="translate({g["tx"] + dx:.2f},{g["ty"]:.2f}) '
                  f'scale({g["sx"]:.5f},{g["sy"]:.5f})">'
                  + ''.join(f'<path d="{d}"/>' for d in g['paths']) + '</g>')
    ext_y += [g['y0'], g['y1']]
    pen += (g['x1'] - g['x0']) + gap
width = pen - gap
top, bot = min(ext_y), max(ext_y)

# Caps run from -CAP to 0, with a little overshoot on the round ones. Anything
# far off that means a transform is wrong rather than a letter being unusual.
if not (1.0 * CAP <= (bot - top) <= 1.35 * CAP):
    raise SystemExit(f'wordmark is {(bot - top) / CAP:.2f}x cap height — expected ~1.0-1.15x')
if abs(top + CAP) > 0.12 * CAP or abs(bot) > 0.12 * CAP:
    raise SystemExit(f'wordmark is off its baseline (top={top:.0f}, bottom={bot:.0f}; '
                     f'expected ~{-CAP:.0f} and ~0)')

m = 0.03 * CAP
vb = (-m, top - m, width + 2 * m, (bot - top) + 2 * m)
svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb[0]:.1f} {vb[1]:.1f} {vb[2]:.1f} {vb[3]:.1f}" '
       f'role="img" aria-label="Someone to Hold">\n'
       f'  <title>Someone to Hold</title>\n  <g fill="{FILL}">\n'
       + '\n'.join(groups) + '\n  </g>\n</svg>\n')
open(OUT_SVG, 'w').write(svg)

print(f'{len(groups)} glyphs placed, {len(set(WORD.replace(" ", "")))} distinct')
print('sources: ' + '  '.join(f'{c}=line{g["src"][0]}[{g["src"][1]}]' for c, g in sorted(glyphs.items())))
print(f'cap height {CAP:.0f}, ink {top:.0f}..{bot:.0f} ({(bot - top) / CAP:.2f}x), '
      f'aspect {vb[2] / vb[3]:.2f}:1, {len(svg)} bytes')
