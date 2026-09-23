#!/usr/bin/env python3
"""ttym wordmark → outlined SVGs (no font dependency).

Proportions are the film's opening/closing word: Geist Mono at weight 640,
letter-spacing -0.05em, then a caret block 78x150 at a 168px size (0.464em x
0.893em) after a 14px gap, centred on the line box like the film's flexbox.

  python3 scripts/brand/make-logo.py   → site/brand/ttym-logo-{dark,light}.svg, favicon.svg
"""
import io, os
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FONT = os.path.join(ROOT, 'site/fonts/GeistMono-Variable.woff2')
OUT = os.path.join(ROOT, 'site/brand')
INK_DARK, INK_LIGHT, ACCENT, BG = '#f3f3f4', '#0b0b0c', '#f29c5c', '#0b0b0c'

font = instantiateVariableFont(TTFont(FONT), {'wght': 640})
upm = font['head'].unitsPerEm
gs, cmap, hmtx = font.getGlyphSet(), font.getBestCmap(), font['hmtx']
asc, desc = font['hhea'].ascent, font['hhea'].descent  # desc is negative

def wordmark(text='ttym'):
    """Glyph outlines in font units, y down, baseline at 0. Returns (path d, advance)."""
    pen, x = SVGPathPen(gs), 0.0
    track = -0.05 * upm
    for i, ch in enumerate(text):
        g = cmap[ord(ch)]
        gs[g].draw(TransformPen(pen, (1, 0, 0, -1, x, 0)))
        x += hmtx[g][0] + (track if i < len(text) - 1 else 0)
    return pen.getCommands(), x

d, adv = wordmark()
gap, cw, ch = 14 / 168 * upm, 78 / 168 * upm, 150 / 168 * upm
mid = (-asc - desc) / 2                     # centre of the line box (y down)
cx, cy = adv + gap, mid - ch / 2
# viewBox hugs the ink (glyphs ∪ caret), not the line box, so the mark sizes predictably
from fontTools.pens.boundsPen import BoundsPen
bp, x = BoundsPen(gs), 0.0
for i, c in enumerate('ttym'):
    g = cmap[ord(c)]
    gs[g].draw(TransformPen(bp, (1, 0, 0, -1, x, 0)))
    x += hmtx[g][0] + (-0.05 * upm if i < 3 else 0)
gx0, gy0, gx1, gy1 = bp.bounds
x0, y0, x1, y1 = min(gx0, cx), min(gy0, cy), max(gx1, cx + cw), max(gy1, cy + ch)
pad = 0.02 * upm
vb = (x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad)

def svg(ink, title='ttym'):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb[0]:.0f} {vb[1]:.0f} {vb[2]:.0f} {vb[3]:.0f}" role="img" aria-label="{title}">'
            f'<title>{title}</title><path fill="{ink}" d="{d}"/>'
            f'<rect x="{cx:.0f}" y="{cy:.0f}" width="{cw:.0f}" height="{ch:.0f}" fill="{ACCENT}"/></svg>\n')

os.makedirs(OUT, exist_ok=True)
open(os.path.join(OUT, 'ttym-logo-dark.svg'), 'w').write(svg(INK_DARK))   # for dark backgrounds
open(os.path.join(OUT, 'ttym-logo-light.svg'), 'w').write(svg(INK_LIGHT)) # for light backgrounds

# favicon: the caret alone on the film's background — the one mark that survives 16px
fav = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0b0b0c"/>'
       f'<rect x="22" y="12" width="20" height="40" fill="{ACCENT}"/></svg>\n')
open(os.path.join(OUT, 'favicon.svg'), 'w').write(fav)
print('viewBox', [round(v) for v in vb], 'caret', round(cx), round(cy), round(cw), round(ch))
