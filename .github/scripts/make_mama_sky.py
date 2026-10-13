#!/usr/bin/env python3
"""Recolour MAMA's own key-visual sky into the Blinks United palette.

    python3 .github/scripts/make_mama_sky.py <source.jpg> [out.png]

WHAT THIS IS. The 2026 MAMA AWARDS vote-guide graphics are Mnet/CJ ENM's
artwork. The site owner asked for their galaxy rather than a generated one, and
that is their call to make for their own fan page; this script is the honest
way to do it — a documented, repeatable derivation rather than a hand-edit
nobody can retrace. The source image is NOT committed to this repo: pass the
path to it. Only the recoloured sky is kept, because that is what the poster
needs to render.

WHAT IT HAS TO REMOVE. The source is a finished graphic, not a background
plate: MAMA's logo and the VISA sponsor line sit on the nebula, and the body
copy and two hairline rules sit in the middle. Shipping any of those on a fan
poster would be passing off their branding as ours, so all of it goes. The
middle of their frame is near-black behind the text, so clearing it costs
almost nothing; the logo sits on actual cloud, so that corner is patched from
the mirrored side of the same sky rather than blacked out.

HOW THE RECOLOUR WORKS. Their nebula is blue-white, so hue-rotating it would
leave the blues fighting the pink. Instead the image is reduced to luminance —
which is where all the structure lives — and that luminance is remapped through
a pink ramp: deep violet in the faint gas, #FF0066 through the body, near-white
at the cores. The result keeps every filament they drew and none of their
colour.
"""
import sys
from PIL import Image, ImageFilter
import numpy as np

W, H = 1080, 1350          # the poster's frame

# Where their furniture sits, in SOURCE pixels (1081x1441). Measured off a
# zoomed crop, not guessed: the wordmark runs y 50-162, x 75-200.
#
# The box is deliberately much bigger than that. The patch is feathered at its
# edges, so only its MIDDLE replaces anything at full strength — a box drawn
# tight to the logo leaves the feathered margin sitting on top of the lettering,
# and the first version of this did exactly that: "VISA" and the top of the
# wordmark came through on the finished poster. The box has to be big enough
# that the whole logo falls inside the full-strength core.
LOGO = (36, 8, 250, 212)           # MAMA logo + "Presented by VISA"
FEATHER = 0.18                     # fraction of the box spent fading in
TEXT_TOP, TEXT_BOT = 300, 1105     # the headline and body copy, between the rules


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else 'mama-sky.png'

    im = Image.open(src).convert('RGB')
    a = np.asarray(im).astype(np.float32)
    h, w, _ = a.shape

    # ── 1. patch out the logo ────────────────────────────────────────────────
    # Mirrored from the opposite side of the same sky: that region is cloud of
    # the same character at the same height, so the repair reads as more of
    # their nebula rather than as a hole. Feathered, or the patch shows its
    # edges — which on a poster is worse than the logo would have been.
    x0, y0, x1, y1 = LOGO
    patch = a[y0:y1, w - x1:w - x0][:, ::-1].copy()
    ph, pw = patch.shape[:2]
    fy = np.minimum(np.arange(ph), ph - 1 - np.arange(ph))[:, None] / (ph * FEATHER)
    fx = np.minimum(np.arange(pw), pw - 1 - np.arange(pw))[None, :] / (pw * FEATHER)
    feather = np.clip(np.minimum(fy, fx), 0, 1)[:, :, None]
    a[y0:y1, x0:x1] = a[y0:y1, x0:x1] * (1 - feather) + patch * feather

    # Did it actually go? Their lettering is white — bright AND colourless —
    # while their stars are bright and tiny and their gas is bright and blue.
    # Counting bright low-saturation pixels in the box separates the three, and
    # this check is here because the first version of this script shipped a
    # poster with "VISA" still legible on it. A sponsor's mark surviving onto a
    # fan graphic is not a cosmetic miss.
    box = a[y0:y1, x0:x1]
    white = ((box.max(axis=2) > 200) & ((box.max(axis=2) - box.min(axis=2)) < 45)).sum()
    if white > 120:
        sys.exit('FAILED: %d white logo-ish pixels still in the patched box — the '
                 'logo or the VISA line is not fully covered. Widen LOGO.' % white)

    # ── 2. clear their copy out of the middle ────────────────────────────────
    # Everything between the rules goes. Their own background there is
    # near-black (row means of 10-15 out of 255), so this removes the text and
    # the rules and essentially nothing else. Ramped at both ends so the cloud
    # above and below fades out instead of stopping at a line.
    ramp = np.ones(h, dtype=np.float32)
    ramp[TEXT_TOP:TEXT_BOT] = 0.0
    fade = 110
    ramp[TEXT_TOP - fade:TEXT_TOP] = np.linspace(1, 0, fade)
    ramp[TEXT_BOT:TEXT_BOT + fade] = np.linspace(0, 1, fade)
    a *= ramp[:, None, None]

    # ── 3. to luminance ──────────────────────────────────────────────────────
    # max() rather than a perceptual weighting: their gas is blue, and a
    # luminance curve that discounts blue would thin out the very structure
    # this is being done for.
    lum = a.max(axis=2) / 255.0
    lum = np.clip((lum - 0.045) / 0.955, 0, 1)      # drop the JPEG floor to true black
    lum = np.power(lum, 0.92)

    # ── 4. the pink ramp ─────────────────────────────────────────────────────
    # Three stops: faint gas violet, the body of the cloud #FF0066, the cores
    # near-white. Interpolated per pixel.
    stops = np.array([
        [0.00,  10,   2,  16],
        [0.22,  92,  16, 104],
        [0.55, 255,   0, 102],
        [0.80, 255, 110, 175],
        [1.00, 255, 232, 244],
    ], dtype=np.float32)
    rgb = np.empty((h, w, 3), dtype=np.float32)
    for c in range(3):
        rgb[:, :, c] = np.interp(lum, stops[:, 0], stops[:, c + 1])

    img = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8))

    # ── 5. into the poster's frame ───────────────────────────────────────────
    # Their 3:4 cropped to the poster's 4:5, taken off the top and bottom
    # equally so the sky stays centred.
    img = img.resize((W, round(W * h / w)), Image.LANCZOS)
    extra = img.height - H
    img = img.crop((0, extra // 2, W, extra // 2 + H))

    # ── 6. protect the type ──────────────────────────────────────────────────
    # Their brightest cloud is along the top edge, which is exactly where this
    # poster's headline goes. Rather than move the headline, the sky is dimmed
    # in a column down the middle and left at full strength at the edges — the
    # framing survives, and the words sit on something close to black.
    arr = np.asarray(img).astype(np.float32)
    yy = np.arange(H)[:, None] / H
    xx = np.arange(W)[None, :] / W
    centre_x = np.clip(1 - np.abs(xx - 0.5) / 0.46, 0, 1) ** 1.25
    band_y = np.clip(1 - np.abs(yy - 0.42) / 0.50, 0, 1) ** 1.1
    keep = 1 - 0.86 * centre_x * band_y
    arr *= keep[:, :, None]

    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    img = img.filter(ImageFilter.GaussianBlur(0.4))   # take the JPEG edge off
    img.save(out)
    print('wrote %s (%dx%d) from %s' % (out, img.width, img.height, src))


if __name__ == '__main__':
    main()
