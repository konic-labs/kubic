#!/usr/bin/env python3
"""art: the README's brand art, as SVG files.

Konic's brand, drawn for the README: a black field (white under GitHub's
light theme), one red accent, the website's Bayer dither field and the TUI's
own half-block wordmark, read from packages/tui/src/preflight.ts so the two
never drift apart. Every file stands alone: the type is outlined into paths,
so no font, script or outside reference is inside, and the motion stops for a
reader who asks for reduced motion.

  banner-dark.svg, banner-light.svg   the top of the README
  facts-dark.svg, facts-light.svg     the strip of facts under the title
  footer-dark.svg, footer-light.svg   the closing band
  icon-NAME.svg                       the feature grid's 12-pixel icons

Usage: art.py [--out DIR] [--fonts DIR]

The type is Inter Tight and Space Mono (SIL Open Font License 1.1), fetched
once from the Google Fonts repository at a pinned commit, checked against its
SHA-256 and kept in .cache/art-fonts/ in the checkout; --fonts names a
directory that already holds both files. Outlining the type needs fontTools
(python3 -m pip install fonttools).
"""

import argparse
import hashlib
import math
import os
import re
import sys
import urllib.request

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PREFLIGHT = os.path.join(REPO, 'packages', 'tui', 'src', 'preflight.ts')
DEFAULT_OUT = os.path.join(REPO, 'docs', 'assets', 'readme')
FONT_CACHE = os.path.join(REPO, '.cache', 'art-fonts')

GOOGLE_FONTS = 'https://raw.githubusercontent.com/google/fonts'
# file name: (URL, SHA-256)
FONT_FILES = {
    'InterTight[wght].ttf': (
        f'{GOOGLE_FONTS}/0b58fb370093f9a9f4ff785d94405710b79de67c/ofl/intertight/InterTight%5Bwght%5D.ttf',
        'b81b73dcb64df3c230cabade7df6c5773bf863233f24c9ee51087519f1f88b6f'),
    'SpaceMono-Regular.ttf': (
        f'{GOOGLE_FONTS}/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/spacemono/SpaceMono-Regular.ttf',
        '95837e182baeeada83368f7748db28357f0a1b75c6b84ff7065b5edf933c8e18'),
}
DISPLAY = 'InterTight[wght].ttf'
LABEL = 'SpaceMono-Regular.ttf'

# Konic red, the one accent; the TUI's `accent` token.
RED = '#ff004d'
THEMES = {
    'dark': {'bg': '#050505', 'fg': '#ffffff', 'muted': '#a3a3a3',
             'rule': '#1a1a1a', 'dot': ('#ffffff', 0.22)},
    'light': {'bg': '#ffffff', 'fg': '#050505', 'muted': '#737373',
              'rule': '#e8e8e8', 'dot': ('#050505', 0.2)},
}

EYEBROW = 'Agentic coding, in your control'
TAGLINE = 'Built for teams and enterprise'
SIGNATURE = 'Konic'
FACTS = ('MIT license', 'Node 22.19+', 'Any model', 'Not on npm yet')
# How many leading facts are stated plainly; the rest are muted.
FACTS_PLAIN = 3

# The Konic mark: a disc split by a gap at 60 degrees, on a 512 grid.
MARK = ('M169.748 476.331L403.686 71.138A16.384 16.384 0 0 1 428.944 67.25'
        'A256 256 0 0 1 179.01 500.149A16.384 16.384 0 0 1 169.748 476.331Z'
        'M342.252 35.669L108.314 440.862A16.384 16.384 0 0 1 83.056 444.75'
        'A256 256 0 0 1 332.99 11.851A16.384 16.384 0 0 1 342.252 35.669Z')

# 12 x 12 icons for the feature grid, by name: (title, rows); '#' is lit.
ICONS = {
    'models': ('Any model', (
        '............', '.###....###.', '.#.#....#.#.', '.###....###.',
        '..#......#..', '..########..', '.....##.....', '.....##.....',
        '....####....', '....#..#....', '....####....', '............')),
    'journal': ('Journal and undo', (
        '............', '...#........', '..##........', '.#########..',
        '..##......#.', '...#.......#', '...........#', '...........#',
        '..........#.', '..#######...', '............', '............')),
    'approvals': ('Approvals', (
        '............', '.##########.', '.#........#.', '.#........#.',
        '.#......#.#.', '.#.....##.#.', '.#.#..##..#.', '.#.####...#.',
        '..#.##...#..', '...#....#...', '....####....', '............')),
    'sessions': ('Sessions that branch', (
        '............', '.##.........', '.##.........', '..#.........',
        '..#....##...', '..#####.##..', '..#.....##..', '..#.........',
        '..#....##...', '..#####.##..', '........##..', '............')),
    'sandbox': ('Bash sandbox', (
        '............', '....#####...', '...#....##..', '..#....#.#..',
        '.######..#..', '.#....#..#..', '.#....#..#..', '.#....#.#...',
        '.#....##....', '.######.....', '............', '............')),
    'policy': ('Policy and audit', (
        '............', '.########...', '.#......#...', '.#.####.#...',
        '.#......#...', '.#.###..#...', '.#......###.', '.#.##..#...#',
        '.#.....#.#.#', '.#######.#.#', '........###.', '............')),
}

BAYER8 = (0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
          12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
          3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
          15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21)

MOTION_CSS = (
    '.px{animation:px .7s cubic-bezier(.22,.61,.36,1) backwards;'
    'transform-box:fill-box;transform-origin:50% 50%}'
    '@keyframes px{from{opacity:0;transform:scale(.25)}to{opacity:1;transform:none}}'
    '.rise{animation:rise .8s cubic-bezier(.22,.61,.36,1) backwards}'
    '@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}'
    '.dg{animation-timing-function:linear;animation-iteration-count:infinite}'
    '.tw{animation:tw 1.6s ease-in-out infinite}'
    '@keyframes tw{0%,100%{opacity:1}50%{opacity:.2}}'
)
# Last in the sheet and one step more specific than the rules it stops.
REDUCED_MOTION = ('@media (prefers-reduced-motion:reduce){'
                  'svg .px,svg .rise,svg .dg,svg .tw{animation:none}}')


class ArtError(Exception):
    """Art that cannot be drawn: a missing font, a changed wordmark."""


def num(value):
    """A coordinate, at most two decimals and no trailing zeros."""
    text = f'{value:.2f}'.rstrip('0').rstrip('.')
    return '0' if text in ('', '-0') else text


# --- the wordmark ------------------------------------------------------------

def wordmark_rows(source):
    """The two half-block rows of the TUI's WORDMARK constant."""
    match = re.search(r"const WORDMARK = \['([^']*)', '([^']*)'\];", source)
    if match is None:
        raise ArtError('no WORDMARK constant in packages/tui/src/preflight.ts')
    return match.group(1), match.group(2)


def wordmark_pixels(rows):
    """The lit pixels as (column, row): each text row is two pixel rows, a
    full block lights both, an upper half the top and a lower half the
    bottom."""
    pixels = []
    for r, line in enumerate(rows):
        for c, ch in enumerate(line):
            if ch in '█▀':
                pixels.append((c, 2 * r))
            if ch in '█▄':
                pixels.append((c, 2 * r + 1))
            if ch not in ' █▀▄':
                raise ArtError(f'the wordmark has a glyph art cannot draw: {ch!r}')
    return pixels


def draw_wordmark(pixels, x, y, size, fill, delay=0.0):
    """The wordmark at (x, y), assembling column by column."""
    out = []
    for c, r in pixels:
        start = delay + c * 0.045 + r * 0.02
        out.append(f'<rect class="px" style="animation-delay:{start:.2f}s" '
                   f'x="{num(x + c * size)}" y="{num(y + r * size)}" '
                   f'width="{num(size)}" height="{num(size)}" fill="{fill}"/>')
    return ''.join(out)


def draw_mark(x, y, size, fill):
    return (f'<path transform="translate({num(x)} {num(y)}) scale({size / 512:.5f})" '
            f'fill="{fill}" d="{MARK}"/>')


# --- the dither field --------------------------------------------------------

def bayer8(x, y):
    """The 8 x 8 ordered-dither threshold at (x, y), in (0, 1)."""
    return (BAYER8[x % 8 + (y % 8) * 8] + 0.5) / 64


def unit_hash(x, y):
    """A deterministic value in [0, 1) for a pair of integers."""
    h = (x * 374761393 + y * 668265263) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return (h ^ (h >> 16)) / 2 ** 32


def stroke_dots(dots, size):
    """Square dots as one stroked path: each dot a `h<size>` segment at its
    centre line, the next along a row reached by a relative move."""
    out = []
    last = None
    for y, x in sorted(dots):
        if last is not None and last[0] == y:
            out.append(f'm{x - last[1] - size} 0h{size}')
        else:
            out.append(f'M{x} {y}h{size}')
        last = (y, x)
    return ''.join(out)


FIELDS = {
    # origin: (distance from the origin edge, position along it), both in [0, 1]
    'right': lambda nx, ny: (1 - nx, ny),
    'bottom': lambda nx, ny: (1 - ny, nx),
}


def dither(box, origin, coverage, swing, period, colours, cell=16, dot=6,
           bands=24, levels=8, spread=0.3, keep_out=None):
    """A Bayer dither field growing from one edge of BOX (x, y, w, h).

    Each band along the edge swings its front back and forth on its own
    period. A dot whose threshold sits inside the swing is lit for one arc of
    its band's cycle; dots that share a band and an arc share one animated
    path, so the field costs a few hundred elements, not one per dot. Dots
    left of KEEP_OUT (an x) are never drawn. Returns (svg, css).
    """
    x0, y0, w, h = box
    cols, rows = int(w // cell), int(h // cell)
    inset = (cell - dot) // 2
    lit = {key: [] for key in colours}
    twinkle = {key: [] for key in colours}
    swinging = {}
    for cy in range(rows):
        for cx in range(cols):
            x = x0 + cx * cell + inset
            if keep_out is not None and x < keep_out:
                continue
            from_edge, along = FIELDS[origin]((cx + 0.5) / cols, (cy + 0.5) / rows)
            up = rows - 1 - cy
            threshold = from_edge + (bayer8(cx, up) - 0.5) * spread
            band = min(bands - 1, int(along * bands))
            reach = swing * (0.65 + 0.35 * unit_hash(band, 71))
            s = (threshold - coverage) / reach
            key = 'accent' if bayer8(cx + 3, up + 5) > 0.5 else 'quiet'
            centre = (y0 + cy * cell + inset + dot // 2, x)
            if s <= -1:
                (twinkle if unit_hash(cx, cy + 7) < 0.08 else lit)[key].append(centre)
            elif s < 1:
                duty = (math.pi - 2 * math.asin(s)) / (2 * math.pi)
                level = max(1, min(levels - 1, round(duty * levels)))
                swinging.setdefault((key, band, level), []).append(centre)
    css = []
    for level in range(1, levels):
        half = level / levels * 50
        ramp = min(6.0, half)
        css.append(f'.k{level}{{animation-name:k{level}}}@keyframes k{level}{{'
                   f'0%,{num(50 - half)}%{{opacity:0}}{num(50 - half + ramp)}%,'
                   f'{num(50 + half - ramp)}%{{opacity:1}}{num(50 + half)}%,100%{{opacity:0}}}}')
    for band in range(bands):
        length = period * (0.8 + 0.4 * unit_hash(band, 23))
        peak = unit_hash(band, 11) * length
        css.append(f'.b{band}{{animation-duration:{length:.2f}s;'
                   f'animation-delay:{(peak - length / 2) % length - length:.2f}s}}')
    paths = []
    for key, (colour, opacity) in colours.items():
        css.append(f'.{key}{{stroke:{colour}'
                   f'{"" if opacity >= 1 else f";stroke-opacity:{opacity}"}}}')
        if lit[key]:
            paths.append(f'<path class="{key}" d="{stroke_dots(lit[key], dot)}"/>')
        if twinkle[key]:
            paths.append(f'<path class="{key} tw" d="{stroke_dots(twinkle[key], dot)}"/>')
    for (key, band, level), dots in sorted(swinging.items()):
        paths.append(f'<path class="{key} dg b{band} k{level}" d="{stroke_dots(dots, dot)}"/>')
    return f'<g fill="none" stroke-width="{dot}">{"".join(paths)}</g>', ''.join(css)


# --- type --------------------------------------------------------------------

def ensure_fonts(fonts_dir=None):
    """The directory holding the font files: --fonts, else the cache, filled
    from the pinned URLs and refused when a download's hash differs."""
    folder = fonts_dir or FONT_CACHE
    os.makedirs(folder, exist_ok=True)
    for name, (url, sha256) in FONT_FILES.items():
        path = os.path.join(folder, name)
        if not os.path.isfile(path):
            if fonts_dir:
                raise ArtError(f'no {name} in {fonts_dir}')
            print(f'fetching {name}')
            with urllib.request.urlopen(url, timeout=60) as response:
                body = response.read()
            if hashlib.sha256(body).hexdigest() != sha256:
                raise ArtError(f'{name} from {url} does not match its pinned SHA-256')
            with open(path, 'wb') as handle:
                handle.write(body)
    return folder


class Type:
    """Outlines text from the font files as SVG path data."""

    def __init__(self, folder):
        try:
            from fontTools.pens.svgPathPen import SVGPathPen
            from fontTools.pens.transformPen import TransformPen
            from fontTools.ttLib import TTFont
            from fontTools.varLib import instancer
        except ImportError:
            raise ArtError('outlining the type needs fontTools: '
                           'python3 -m pip install fonttools') from None
        self.folder = folder
        self.pens = (SVGPathPen, TransformPen)
        self.open = TTFont
        self.instancer = instancer
        self.faces = {}

    def face(self, name, weight=None):
        key = (name, weight)
        if key not in self.faces:
            font = self.open(os.path.join(self.folder, name))
            if weight is not None and 'fvar' in font:
                font = self.instancer.instantiateVariableFont(font, {'wght': weight})
            self.faces[key] = font
        return self.faces[key]

    def path(self, text, name, size, x, y, tracking=0.0, weight=None, anchor='start'):
        """Path data for TEXT on the baseline y, and its advance width.
        TRACKING is in em; ANCHOR is start, middle or end."""
        svg_pen, transform_pen = self.pens
        font = self.face(name, weight)
        scale = size / font['head'].unitsPerEm
        glyphs = font.getGlyphSet()
        cmap = font.getBestCmap()
        advances = font['hmtx']
        placed, width = [], 0.0
        for ch in text:
            glyph = cmap.get(ord(ch))
            if glyph is None:
                raise ArtError(f'{name} has no glyph for {ch!r}')
            placed.append((glyph, width))
            width += advances[glyph][0] * scale + tracking * size
        width -= tracking * size if text else 0
        if anchor == 'middle':
            x -= width / 2
        elif anchor == 'end':
            x -= width
        pen = svg_pen(glyphs, ntos=lambda v: num(v))
        for glyph, offset in placed:
            glyphs[glyph].draw(transform_pen(pen, (scale, 0, 0, -scale, x + offset, y)))
        return pen.getCommands(), width

    def label(self, text, x, y, size, fill, anchor='start', cls=None, delay=None):
        """Space Mono in capitals, tracked out: Konic's small labels."""
        d, width = self.path(text.upper(), LABEL, size, x, y, tracking=0.1, anchor=anchor)
        return f'<path{motion(cls, delay)} fill="{fill}" d="{d}"/>', width

    def words(self, text, x, y, size, fill, weight=500, cls=None, delay=None):
        """Inter Tight, set a little tight: Konic's display type."""
        d, width = self.path(text, DISPLAY, size, x, y, tracking=-0.02, weight=weight)
        return f'<path{motion(cls, delay)} fill="{fill}" d="{d}"/>', width


def motion(cls, delay):
    if cls is None:
        return ''
    return f' class="{cls}"' + ('' if delay is None else f' style="animation-delay:{delay:.2f}s"')


# --- the files ---------------------------------------------------------------

def svg(width, height, title, desc, css, body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
            f'width="{width}" height="{height}" role="img" aria-labelledby="title desc">'
            f'<title id="title">{title}</title><desc id="desc">{desc}</desc>'
            f'{f"<style>{css}</style>" if css else ""}{body}</svg>\n')


def banner(theme, wordmark, type_):
    """1280 x 400: the eyebrow, the wordmark, the tagline and the signature
    on the left; the dither field washing in from the right."""
    t = THEMES[theme]
    width, height = 1280, 400
    field, field_css = dither((0, 0, width, height), 'right', 0.3, 0.1, 3.5,
                              {'accent': (RED, 1), 'quiet': t['dot']}, spread=0.22, keep_out=690)
    eyebrow, _ = type_.label(EYEBROW, 80, 102, 18, t['muted'], cls='rise', delay=0.1)
    tagline, _ = type_.words(TAGLINE, 80, 334, 34, t['fg'], cls='rise', delay=1.0)
    signature, _ = type_.label(SIGNATURE, 104, 372, 15, t['muted'], cls='rise', delay=1.2)
    body = (f'<rect width="{width}" height="{height}" fill="{t["bg"]}"/>{field}{eyebrow}'
            f'{draw_wordmark(wordmark, 80, 128, 34, RED)}{tagline}'
            f'<g class="rise" style="animation-delay:1.2s">{draw_mark(80, 359, 15, t["muted"])}</g>'
            f'{signature}<rect x=".5" y=".5" width="{width - 1}" height="{height - 1}" '
            f'fill="none" stroke="{t["rule"]}"/>')
    return svg(width, height, 'Kubic',
               f'The Kubic wordmark in Konic red, between the lines "{EYEBROW}" and '
               f'"{TAGLINE}", beside a red dither field.',
               MOTION_CSS + field_css + REDUCED_MOTION, body)


def facts(theme, type_):
    """1280 x 64: the facts in a row of hairline cells."""
    t = THEMES[theme]
    width, height = 1280, 64
    cell = width / len(FACTS)
    parts = [f'<rect width="{width}" height="{height}" fill="{t["bg"]}"/>']
    for i, fact in enumerate(FACTS):
        x = i * cell
        if i:
            parts.append(f'<path d="M{num(x)} 0V{height}" stroke="{t["rule"]}"/>')
        parts.append(f'<rect x="{num(x + 28)}" y="{height // 2 - 5}" width="10" height="10" fill="{RED}"/>')
        text, _ = type_.label(fact, x + 50, height / 2 + 6, 17,
                              t['fg'] if i < FACTS_PLAIN else t['muted'])
        parts.append(text)
    parts.append(f'<rect x=".5" y=".5" width="{width - 1}" height="{height - 1}" '
                 f'fill="none" stroke="{t["rule"]}"/>')
    return svg(width, height, 'Kubic at a glance', '. '.join(FACTS) + '.', '', ''.join(parts))


def footer(theme, type_):
    """1280 x 200: the dither field rising under the Konic mark."""
    t = THEMES[theme]
    width, height = 1280, 200
    field, field_css = dither((0, 0, width, height), 'bottom', 0.42, 0.16, 4.0,
                              {'accent': (RED, 1), 'quiet': t['dot']}, bands=40)
    signature, label_width = type_.label(SIGNATURE, width / 2 + 15, 74, 18, t['fg'], anchor='middle')
    mark = draw_mark(width / 2 - label_width / 2 - 15, 58, 20, RED)
    body = f'<rect width="{width}" height="{height}" fill="{t["bg"]}"/>{field}{mark}{signature}'
    return svg(width, height, 'Konic', 'The Konic mark over a red dither field rising from the bottom edge.',
               MOTION_CSS + field_css + REDUCED_MOTION, body)


def icon(name):
    """A 48 x 48 icon: the 12 x 12 grid at four pixels a cell."""
    title, rows = ICONS[name]
    d = ''.join(f'M{c * 4} {r * 4}h4v4h-4z'
                for r, row in enumerate(rows) for c, ch in enumerate(row) if ch == '#')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" '
            f'role="img" shape-rendering="crispEdges"><title>{title}</title>'
            f'<path fill="{RED}" d="{d}"/></svg>\n')


def write_all(out_dir, fonts_dir=None):
    """Draw every file into OUT_DIR; return their paths."""
    with open(PREFLIGHT, encoding='utf-8') as handle:
        wordmark = wordmark_pixels(wordmark_rows(handle.read()))
    type_ = Type(ensure_fonts(fonts_dir))
    files = {}
    for theme in THEMES:
        files[f'banner-{theme}.svg'] = banner(theme, wordmark, type_)
        files[f'facts-{theme}.svg'] = facts(theme, type_)
        files[f'footer-{theme}.svg'] = footer(theme, type_)
    for name in ICONS:
        files[f'icon-{name}.svg'] = icon(name)
    os.makedirs(out_dir, exist_ok=True)
    written = []
    for name, content in files.items():
        path = os.path.join(out_dir, name)
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write(content)
        written.append(path)
    return written


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog='art', description="Draw the README's brand art as SVG files.")
    parser.add_argument('--out', default=DEFAULT_OUT,
                        help='where the files go (default: docs/assets/readme)')
    parser.add_argument('--fonts', help='a directory holding '
                        + ' and '.join(FONT_FILES) + ' (default: fetch them '
                        'once into .cache/art-fonts)')
    args = parser.parse_args(argv)
    try:
        for path in write_all(args.out, args.fonts):
            print(f'{os.path.relpath(path, REPO)}: {os.path.getsize(path)} bytes')
    except ArtError as error:
        print(f'art: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
