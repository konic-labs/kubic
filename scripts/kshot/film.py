"""Screens as SVG: a still, or a film of frames that plays on a loop.

A row is drawn once, as its background rectangles and its text runs on the
cell grid, and every frame that shows the same row reuses it. Each run is
stretched to its cells (textLength), so the reader's own monospace font can
never push a column out of line. A frame is shown for its hold time; the
last frame is the still a reader who asks for reduced motion sees, and the
one shown where SVG animation does not run.
"""

CELL_W = 8.4
CELL_H = 18
FONT_SIZE = 14
BASELINE = 13.5
PAD = 16
# The TUI's own background and text tokens (bg0, fg0), and its rule (bg3).
BG = (10, 10, 12)
FG = (236, 236, 241)
RULE = '#22222a'
FONT = ("ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,"
        "'DejaVu Sans Mono','Liberation Mono',monospace")


def hex_colour(rgb):
    return '#%02x%02x%02x' % rgb


def blend(a, b, t):
    return tuple(round(x * (1 - t) + y * t) for x, y in zip(a, b))


def escape(text):
    return text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def num(value):
    text = f'{value:.2f}'.rstrip('0').rstrip('.')
    return text or '0'


def colours(style):
    """A cell's (fg, bg) as drawn: reverse swaps them, dim blends the fg."""
    fg = style.fg or FG
    bg = style.bg or BG
    if style.reverse:
        fg, bg = bg, fg
    if style.dim:
        fg = blend(fg, bg, 0.45)
    return fg, bg


def cells_of(row):
    """(column, character, width, style) for each drawn cell of a row."""
    out = []
    for x, cell in enumerate(row):
        if cell is None:
            continue
        ch, style = cell
        wide = x + 1 < len(row) and row[x + 1] is None
        out.append((x, ch, 2 if wide else 1, style))
    return out


def row_svg(row):
    """One row at y 0: background rectangles, then text runs."""
    parts = []
    cells = cells_of(row)
    span = None  # [first column, background, column after the last]

    def fill():
        if span is not None and span[1] != BG:
            parts.append(f'<rect x="{num(span[0] * CELL_W)}" width="{num((span[2] - span[0]) * CELL_W)}" '
                         f'height="{CELL_H}" fill="{hex_colour(span[1])}"/>')

    for x, _, width, style in cells:
        bg = colours(style)[1]
        if span is not None and (bg != span[1] or x != span[2]):
            fill()
            span = None
        if span is None:
            span = [x, bg, x + width]
        else:
            span[2] = x + width
    fill()
    run = None

    def flush():
        if run is None:
            return
        text = run['text'].rstrip(' ')
        if not text.strip():
            return
        cols = run['cols'] - (len(run['text']) - len(text))
        attrs = [f'x="{num(run["x"] * CELL_W)}"', f'y="{BASELINE}"',
                 f'textLength="{num(cols * CELL_W)}"', f'fill="{hex_colour(run["fg"])}"']
        bold, italic, underline, strike = run['look']
        if bold:
            attrs.append('font-weight="700"')
        if italic:
            attrs.append('font-style="italic"')
        decoration = ' '.join(d for d, on in (('underline', underline), ('line-through', strike)) if on)
        if decoration:
            attrs.append(f'text-decoration="{decoration}"')
        parts.append(f'<text {" ".join(attrs)}>{escape(text)}</text>')

    for x, ch, width, style in cells:
        fg, _ = colours(style)
        key = (fg, (style.bold, style.italic, style.underline, style.strike))
        if run is not None and ch == ' ' and run['fg'] == fg:
            run['text'] += ch
            run['cols'] += width
            continue
        if run is None or (run['fg'], run['look']) != key or x != run['x'] + run['cols']:
            flush()
            if ch == ' ':
                run = None
                continue
            run = {'x': x, 'text': '', 'cols': 0, 'fg': fg, 'look': key[1]}
        run['text'] += ch
        run['cols'] += width
    flush()
    return ''.join(parts)


def row_is_blank(row):
    return all(cell is None or (cell[0] == ' ' and colours(cell[1])[1] == BG) for cell in row)


def row_key(row):
    return tuple(None if cell is None else
                 (cell[0], cell[1].fg, cell[1].bg, cell[1].bold, cell[1].dim, cell[1].italic,
                  cell[1].underline, cell[1].reverse, cell[1].strike) for cell in row)


def film_svg(frames, title, desc):
    """FRAMES as one SVG: a list of (grid, hold in ms). One frame is a still."""
    cols = len(frames[0][0][0])
    rows = len(frames[0][0])
    width = cols * CELL_W + 2 * PAD
    height = rows * CELL_H + 2 * PAD
    shared = {}
    bodies = []
    for grid, _ in frames:
        uses = []
        for y, row in enumerate(grid):
            if row_is_blank(row):
                continue
            key = row_key(row)
            if key not in shared:
                shared[key] = (f'r{len(shared)}', row_svg(row))
            uses.append(f'<use href="#{shared[key][0]}" y="{y * CELL_H}"/>')
        bodies.append(''.join(uses))
    defs = ''.join(f'<g id="{ident}">{body}</g>' for ident, body in shared.values())
    css = [f'text{{font-family:{FONT};font-size:{FONT_SIZE}px;white-space:pre}}']
    if len(frames) == 1:
        groups = f'<g>{bodies[0]}</g>'
    else:
        total = sum(hold for _, hold in frames)
        css.append(f'.f{{opacity:0;animation-duration:{total / 1000:.2f}s;'
                   'animation-iteration-count:infinite;animation-timing-function:steps(1,end)}'
                   '.poster{opacity:1}')
        groups = []
        at = 0
        for i, ((_, hold), body) in enumerate(zip(frames, bodies)):
            begin, end = at / total * 100, (at + hold) / total * 100
            at += hold
            steps = (f'0%{{opacity:1}}{num(end)}%{{opacity:0}}' if begin == 0 else
                     f'0%{{opacity:0}}{num(begin)}%{{opacity:1}}{num(end)}%{{opacity:0}}')
            if end >= 100:
                steps = f'0%{{opacity:0}}{num(begin)}%{{opacity:1}}100%{{opacity:1}}'
            css.append(f'.f{i}{{animation-name:f{i}}}@keyframes f{i}{{{steps}}}')
            poster = ' poster' if i == len(frames) - 1 else ''
            groups.append(f'<g class="f f{i}{poster}">{body}</g>')
        groups = ''.join(groups)
        css.append('@media (prefers-reduced-motion:reduce){svg .f{animation:none}}')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {num(width)} {num(height)}" '
            f'width="{num(width)}" height="{num(height)}" role="img" aria-labelledby="title desc">'
            f'<title id="title">{escape(title)}</title><desc id="desc">{escape(desc)}</desc>'
            f'<style>{"".join(css)}</style><defs>{defs}</defs>'
            f'<rect x=".5" y=".5" width="{num(width - 1)}" height="{num(height - 1)}" '
            f'fill="{hex_colour(BG)}" stroke="{RULE}"/>'
            f'<g transform="translate({PAD} {PAD})">{groups}</g></svg>\n')
