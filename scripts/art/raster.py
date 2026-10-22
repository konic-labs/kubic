"""raster: art.py's SVG files drawn as PNG.

GitHub's mobile apps draw neither these SVGs nor a <picture>'s <source>: they
show the <img>. So each picture in the README keeps its SVG in a <source>
for browsers and names a PNG twin in the <img>. The twin is the still a
browser shows a reader who asks for reduced motion: every element at rest.

This draws the SVG art.py writes and nothing more: rects, filled paths (the
type and the mark, curves and arcs included) and stroked straight lines (the
dither's dots and the hairlines), styled by attributes, by the <g> they sit
in, or by a class's rule in the <style>. Anything else is refused, so a
change to the art cannot quietly draw a wrong PNG. Parsing a path needs
fontTools, and drawing needs Pillow.
"""

import math
import re
import xml.etree.ElementTree as ET

SVG_NS = '{http://www.w3.org/2000/svg}'
# Samples per pixel along each axis, where a path's edge crosses the pixel.
SUPERSAMPLE = 8
# The straight lines a curve is cut into.
CURVE_STEPS = 16
# The style an element takes from attributes, rules and its <g>.
INHERITED = ('fill', 'stroke', 'stroke-width', 'fill-opacity', 'stroke-opacity')
DEFAULTS = {'fill': '#000000', 'stroke': 'none', 'stroke-width': '1',
            'fill-opacity': '1', 'stroke-opacity': '1'}
# Properties that only move things, which a still leaves out.
MOTION = ('animation', 'transform-box', 'transform-origin')
ATTRIBUTES = {
    'g': set(),
    'rect': {'x', 'y', 'width', 'height'},
    'path': {'d'},
}
COMMON = {'class', 'style', 'transform', *INHERITED}


class RasterError(Exception):
    pass


def declarations(text):
    """The properties of a declaration block, leaving out the ones that only
    move things; any property a still would need to honour is refused."""
    out = {}
    for item in text.split(';'):
        name, colon, value = item.partition(':')
        name = name.strip()
        if not colon:
            if name:
                raise RasterError(f'a declaration without a value: {item!r}')
            continue
        if name.startswith(MOTION):
            continue
        if name not in INHERITED:
            raise RasterError(f'a style the PNG cannot draw: {name}')
        out[name] = value.strip()
    return out


def class_rules(css):
    """A style sheet's `.name{...}` rules in order, as (class, properties).
    At-rules and their blocks (@keyframes, @media) only move things and are
    skipped."""
    rules = []
    at = 0
    while (start := css.find('{', at)) != -1:
        depth, end = 1, start + 1
        while depth:
            if end == len(css):
                raise RasterError('an unclosed block in the style sheet')
            depth += {'{': 1, '}': -1}.get(css[end], 0)
            end += 1
        prelude = css[at:start].strip()
        if not prelude.startswith('@'):
            props = declarations(css[start + 1:end - 1])
            for selector in prelude.split(','):
                selector = selector.strip()
                if not re.fullmatch(r'\.[A-Za-z][\w-]*', selector):
                    raise RasterError(f'a selector the PNG cannot match: {selector}')
                rules.append((selector[1:], props))
        at = end
    if css[at:].strip():
        raise RasterError('text after the last rule of the style sheet')
    return rules


def colour(value):
    """An #rgb or #rrggbb colour as (r, g, b), or None for `none`."""
    if value == 'none':
        return None
    match = re.fullmatch(r'#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})', value)
    if match is None:
        raise RasterError(f'a colour the PNG cannot draw: {value}')
    digits = match.group(1)
    if len(digits) == 3:
        digits = ''.join(ch * 2 for ch in digits)
    return tuple(int(digits[i:i + 2], 16) for i in (0, 2, 4))


def transform(value, outer):
    """OUTER, then a transform attribute's translate and scale steps, as
    (sx, sy, tx, ty): a point (x, y) lands at (x * sx + tx, y * sy + ty)."""
    sx, sy, tx, ty = outer
    value = value or ''
    for name, args in re.findall(r'([a-z]+)\(([^)]*)\)', value):
        nums = [float(v) for v in re.split(r'[\s,]+', args.strip()) if v]
        if name == 'translate' and len(nums) in (1, 2):
            tx, ty = tx + nums[0] * sx, ty + (nums[1] if len(nums) == 2 else 0) * sy
        elif name == 'scale' and len(nums) in (1, 2):
            sx, sy = sx * nums[0], sy * nums[-1]
        else:
            raise RasterError(f'a transform the PNG cannot draw: {name}({args})')
    if re.sub(r'[a-z]+\([^)]*\)', '', value).strip():
        raise RasterError(f'a transform the PNG cannot read: {value}')
    return sx, sy, tx, ty


def place_box(box, at):
    """A box (x0, y0, x1, y1) in device pixels."""
    sx, sy, tx, ty = at
    x0, y0, x1, y1 = box
    return (x0 * sx + tx, y0 * sy + ty, x1 * sx + tx, y1 * sy + ty)


def outline(d, at):
    """The contours of path data D, each curve cut into lines and each point
    placed by AT."""
    try:
        from fontTools.pens.basePen import BasePen
        from fontTools.svgLib.path import parse_path
    except ImportError:
        raise RasterError('drawing the PNGs needs fontTools: '
                          'python3 -m pip install fonttools') from None
    contours = []

    class Pen(BasePen):
        def _moveTo(self, pt):
            contours.append([pt])

        def _lineTo(self, pt):
            contours[-1].append(pt)

        def _curveToOne(self, pt1, pt2, pt3):
            pt0 = self._getCurrentPoint()
            for i in range(1, CURVE_STEPS + 1):
                t = i / CURVE_STEPS
                u = 1 - t
                contours[-1].append(tuple(
                    u ** 3 * a + 3 * u * u * t * b + 3 * u * t * t * c + t ** 3 * e
                    for a, b, c, e in zip(pt0, pt1, pt2, pt3)))

        def _qCurveToOne(self, pt1, pt2):
            pt0 = self._getCurrentPoint()
            for i in range(1, CURVE_STEPS + 1):
                t = i / CURVE_STEPS
                u = 1 - t
                contours[-1].append(tuple(u * u * a + 2 * u * t * b + t * t * c
                                          for a, b, c in zip(pt0, pt1, pt2)))

        def _closePath(self):
            pass

        def _endPath(self):
            pass

    parse_path(d, Pen(None))
    sx, sy, tx, ty = at
    return [[(x * sx + tx, y * sy + ty) for x, y in points] for points in contours]


def coverage(contours, box, ss=SUPERSAMPLE):
    """How much of each pixel of BOX (x0, y0, x1, y1, in whole pixels) the
    contours fill under the nonzero rule: rows of sample counts, 0 to
    SS * SS a pixel. Each contour is closed back to its first point."""
    x0, y0, x1, y1 = box
    width = x1 - x0
    counts = [[0] * width for _ in range(y1 - y0)]
    edges = []
    for points in contours:
        for (ax, ay), (bx, by) in zip(points, points[1:] + points[:1]):
            if ay == by:
                continue
            way = 1 if by > ay else -1
            if ay > by:
                ax, ay, bx, by = bx, by, ax, ay
            edges.append(((ay - y0) * ss, (by - y0) * ss, (ax - x0) * ss,
                          (bx - ax) / (by - ay), way))
    edges.sort()
    active, waiting = [], 0
    for row in range((y1 - y0) * ss):
        middle = row + 0.5
        while waiting < len(edges) and edges[waiting][0] <= middle:
            active.append(edges[waiting])
            waiting += 1
        active = [edge for edge in active if edge[1] > middle]
        crossings = sorted((left + (middle - top) * slope, way)
                           for top, _, left, slope, way in active)
        line = counts[row // ss]
        winding = 0
        for x, way in crossings:
            if winding == 0:
                start = x
            winding += way
            if winding != 0:
                continue
            # The samples whose centres lie in [start, x).
            first = max(0, math.ceil(start - 0.5))
            stop = min(width * ss, math.ceil(x - 0.5))
            if first >= stop:
                continue
            p0, p1 = first // ss, (stop - 1) // ss
            if p0 == p1:
                line[p0] += stop - first
                continue
            line[p0] += ss * (p0 + 1) - first
            for p in range(p0 + 1, p1):
                line[p] += ss
            line[p1] += stop - ss * p1
    return counts


class Painter:
    """Paints the elements of one SVG onto an RGBA canvas, in order."""

    def __init__(self, canvas, rules):
        self.canvas = canvas
        self.rules = rules

    def look(self, element, inherited):
        """The element's style: its <g>'s, then its attributes, then the
        rules of its classes, then its own style attribute."""
        look = dict(inherited)
        for name in INHERITED:
            if element.get(name) is not None:
                look[name] = element.get(name)
        classes = (element.get('class') or '').split()
        for cls, props in self.rules:
            if cls in classes:
                look.update(props)
        look.update(declarations(element.get('style') or ''))
        return look

    def children(self, parent, inherited, at):
        for element in parent:
            tag = element.tag.removeprefix(SVG_NS)
            if tag in ('title', 'desc', 'style'):
                continue
            if tag not in ATTRIBUTES:
                raise RasterError(f'an element the PNG cannot draw: <{tag}>')
            extra = set(element.attrib) - ATTRIBUTES[tag] - COMMON
            if extra:
                raise RasterError(f'<{tag}> has what the PNG cannot draw: '
                                  + ', '.join(sorted(extra)))
            look = self.look(element, inherited)
            here = transform(element.get('transform'), at)
            if tag == 'g':
                self.children(element, look, here)
            elif tag == 'rect':
                self.rect(element, look, here)
            else:
                self.path(element, look, here)

    def rect(self, element, look, at):
        x, y = float(element.get('x', 0)), float(element.get('y', 0))
        right = x + float(element.get('width'))
        bottom = y + float(element.get('height'))
        fill = colour(look['fill'])
        if fill is not None:
            self.box(place_box((x, y, right, bottom), at), fill,
                     float(look['fill-opacity']))
        stroke = colour(look['stroke'])
        if stroke is not None:
            half = float(look['stroke-width']) / 2
            o = (x - half, y - half, right + half, bottom + half)
            i = (x + half, y + half, right - half, bottom - half)
            for band in ((o[0], o[1], o[2], i[1]), (o[0], i[3], o[2], o[3]),
                         (o[0], i[1], i[0], i[3]), (i[2], i[1], o[2], i[3])):
                self.box(place_box(band, at), stroke, float(look['stroke-opacity']))

    def path(self, element, look, at):
        d = element.get('d')
        fill = colour(look['fill'])
        if fill is not None:
            self.fill(outline(d, at), fill, float(look['fill-opacity']))
        stroke = colour(look['stroke'])
        if stroke is None:
            return
        half = float(look['stroke-width']) / 2
        for points in outline(d, (1, 1, 0, 0)):
            if len(points) != 2:
                raise RasterError('a stroke the PNG cannot draw: '
                                  'only single straight lines are stroked')
            (ax, ay), (bx, by) = points
            if ay == by:
                band = (min(ax, bx), ay - half, max(ax, bx), ay + half)
            elif ax == bx:
                band = (ax - half, min(ay, by), ax + half, max(ay, by))
            else:
                raise RasterError('a stroke the PNG cannot draw: a slanted line')
            self.box(place_box(band, at), stroke, float(look['stroke-opacity']))

    def box(self, box, rgb, alpha):
        """A filled box in device pixels: drawn at once on whole pixels,
        through its coverage otherwise."""
        if all(abs(v - round(v)) < 1e-6 for v in box):
            x0, y0, x1, y1 = (round(v) for v in box)
            self.composite((x0, y0, x1, y1), rgb, alpha)
            return
        x0, y0, x1, y1 = box
        self.fill([[(x0, y0), (x1, y0), (x1, y1), (x0, y1)]], rgb, alpha)

    def fill(self, contours, rgb, alpha):
        points = [pt for contour in contours for pt in contour]
        if not points:
            return
        width, height = self.canvas.size
        box = (max(0, math.floor(min(x for x, _ in points))),
               max(0, math.floor(min(y for _, y in points))),
               min(width, math.ceil(max(x for x, _ in points))),
               min(height, math.ceil(max(y for _, y in points))))
        if box[0] >= box[2] or box[1] >= box[3]:
            return
        full = SUPERSAMPLE * SUPERSAMPLE
        counts = coverage(contours, box)
        mask = bytes(round(255 * alpha * c / full) for row in counts for c in row)
        self.composite(box, rgb, alpha, mask)

    def composite(self, box, rgb, alpha, mask=None):
        """Paint RGB over the box, at ALPHA or through MASK (one byte a
        pixel, ALPHA already in it)."""
        from PIL import Image
        width, height = self.canvas.size
        x0, y0, x1, y1 = box
        if mask is None:
            x0, y0, x1, y1 = max(0, x0), max(0, y0), min(width, x1), min(height, y1)
        if x0 >= x1 or y0 >= y1:
            return
        layer = Image.new('RGBA', (x1 - x0, y1 - y0), (*rgb, round(255 * alpha)))
        if mask is not None:
            layer.putalpha(Image.frombytes('L', (x1 - x0, y1 - y0), mask))
        self.canvas.alpha_composite(layer, (x0, y0))


def draw(svg_text, scale):
    """The SVG as a Pillow image SCALE times its size: RGB when it covers
    every pixel, RGBA otherwise."""
    try:
        from PIL import Image
    except ImportError:
        raise RasterError('drawing the PNGs needs Pillow: '
                          'python3 -m pip install Pillow') from None
    root = ET.fromstring(svg_text)
    if root.tag != f'{SVG_NS}svg':
        raise RasterError('not an SVG file')
    width, height = float(root.get('width')), float(root.get('height'))
    if [float(v) for v in root.get('viewBox', '').split()] != [0, 0, width, height]:
        raise RasterError('the viewBox is not 0 0 WIDTH HEIGHT')
    canvas = Image.new('RGBA', (round(width * scale), round(height * scale)))
    rules = class_rules(''.join(el.text or '' for el in root.iter(f'{SVG_NS}style')))
    Painter(canvas, rules).children(root, DEFAULTS, (scale, scale, 0, 0))
    if canvas.getchannel('A').getextrema() == (255, 255):
        return canvas.convert('RGB')
    return canvas


def write_png(svg_text, path, scale):
    draw(svg_text, scale).save(path, optimize=True)
