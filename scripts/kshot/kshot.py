#!/usr/bin/env python3
"""kshot: screenshots of the Kubic TUI, driven by a scenario.

The TUI runs in a real pseudo-terminal inside a private tmux server (tmux is
the terminal emulator). A scenario types into it, and every `snap` step
writes the screen four ways:

  NAME.png   the screen drawn cell by cell: colours, bold, italic, underline,
             strikethrough, reverse video, dim text and the cursor
  NAME.svg   the same screen as vector text, sharp at any size
  NAME.txt   the plain text of the screen
  NAME.ansi  the screen with its SGR colour sequences

Usage: kshot.py SCENARIO [--out DIR] [--keep] [--font PATH] [--scale N]

SCENARIO is a file, or the name of one in scripts/kshot/scenarios (`panels`
for scenarios/panels.kshot). The snapshots go to .kshot/NAME/ in the
checkout unless --out names another directory. --scale draws each PNG N
times as large, for high-density screens.

A scenario has one step per line; '#' starts a comment. $WORK, $KHOME and
$REPO expand to a fresh workspace, a fresh HOME and the Kubic checkout.

  size COLS ROWS      the terminal size, before start (default 120 40)
  env KEY=VALUE       a variable for the sh steps and the app (repeatable)
  model FILE          answer the app with the scripted model in FILE (a
                      path beside the scenario), before start: see model.py
  sh COMMAND          run a shell command in $WORK, e.g. to seed files
  start COMMAND       launch the app in $WORK
  type TEXT           type TEXT as it is (trailing spaces are dropped:
                      use `key Space`)
  key KEY...          press keys by their tmux names: Enter Escape Up Tab
                      BSpace Space C-p M-Down ...
  wait MS             sleep for MS milliseconds
  waitfor TEXT [MS]   wait until the screen shows TEXT; a trailing number is
                      the limit in milliseconds (default 8000)
  idle [MS]           wait until the screen holds still for MS (default 400)
  scrub REGEX => TEXT in every later snap and frame, put TEXT where REGEX
                      matches, padded or cut on the left to the same width:
                      a clock, an id or a timing that changes every run
  snap NAME           write NAME.png, NAME.svg, NAME.txt and NAME.ansi
  frame MS            add the screen to the scenario's film, shown for MS
                      milliseconds; a run with frames writes film.svg, which
                      plays them on a loop

Commands see only PATH, HOME=$KHOME, a UTF-8 locale, a truecolor
xterm-256color terminal, KUBIC_PROVIDER=faux (unless a model step names the
model), KUBIC_TRUST_PROJECT=1 and the scenario's env steps: nothing else from
the caller's environment, so no key or setting leaks in. When a step fails
after start, the screen at that moment is written as error.png (with .svg,
.txt and .ansi), and kshot exits 1.

Needs tmux, and Pillow to draw the PNG (python3 -m pip install Pillow).
"""

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata

import film
import model

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCENARIOS = os.path.join(REPO, 'scripts', 'kshot', 'scenarios')

DEFAULT_SIZE = (120, 40)
WAITFOR_MS = 8000
IDLE_MS = 400
# An idle step stops waiting after this long, so an app that never holds
# still (a spinner) still gets its snapshot.
IDLE_LIMIT_S = 10
POLL_S = 0.05

STEPS = ('size', 'env', 'model', 'sh', 'start', 'type', 'key', 'wait',
         'waitfor', 'idle', 'scrub', 'snap', 'frame')
# The steps that act on the running app.
APP_STEPS = ('type', 'key', 'waitfor', 'idle', 'snap', 'frame')
# The steps that set up the app, so come before it starts.
SETUP_STEPS = ('size', 'model')
# The snapshot a failed step writes, and the film frames make.
ERROR_SNAP = 'error'
FILM = 'film'
SCRUB_ARROW = ' => '

FONT_SIZE = 15
PAD = 12
DEFAULT_FG = (205, 214, 244)
DEFAULT_BG = (17, 17, 27)
CURSOR = (255, 200, 0)
# The 16 base colours, close to xterm's but softer on a dark background.
ANSI16 = [
    (40, 42, 54), (230, 80, 80), (80, 200, 120), (230, 200, 80),
    (90, 140, 240), (200, 110, 220), (80, 200, 210), (205, 214, 244),
    (110, 115, 140), (255, 110, 110), (110, 230, 150), (255, 225, 110),
    (120, 170, 255), (230, 140, 250), (110, 230, 240), (255, 255, 255),
]

# Where fonts are looked for, macOS first, then the Linux directories.
FONT_DIRS = (
    '~/Library/Fonts',
    '/Library/Fonts',
    '/System/Library/Fonts',
    '~/.local/share/fonts',
    '~/.fonts',
    '/usr/local/share/fonts',
    '/usr/share/fonts',
)
# Monospace families in order of preference, each as its regular, bold,
# italic and bold-italic files. `NAME#N` is face N of a font collection.
FAMILIES = (
    ('JetBrainsMonoNerdFont-Regular.ttf', 'JetBrainsMonoNerdFont-Bold.ttf',
     'JetBrainsMonoNerdFont-Italic.ttf', 'JetBrainsMonoNerdFont-BoldItalic.ttf'),
    ('JetBrainsMono-Regular.ttf', 'JetBrainsMono-Bold.ttf',
     'JetBrainsMono-Italic.ttf', 'JetBrainsMono-BoldItalic.ttf'),
    ('Menlo.ttc#0', 'Menlo.ttc#1', 'Menlo.ttc#2', 'Menlo.ttc#3'),
    ('DejaVuSansMono.ttf', 'DejaVuSansMono-Bold.ttf',
     'DejaVuSansMono-Oblique.ttf', 'DejaVuSansMono-BoldOblique.ttf'),
    ('LiberationMono-Regular.ttf', 'LiberationMono-Bold.ttf',
     'LiberationMono-Italic.ttf', 'LiberationMono-BoldItalic.ttf'),
)
# Where a glyph the family lacks is looked for next.
SYMBOL_FONTS = ('Apple Symbols.ttf', 'DejaVuSans.ttf',
                'NotoSansSymbols2-Regular.ttf', 'Symbola.ttf')
# An unassigned code point: every font draws its missing-glyph box for it.
UNASSIGNED = '͸'


class KshotError(Exception):
    """A scenario that cannot run, or a step that failed."""


# --- the scenario ----------------------------------------------------------

def check_argument(verb, rest):
    """Refuse a step whose argument cannot work."""
    if verb == 'size':
        parts = rest.split()
        if len(parts) != 2 or not all(p.isdigit() and int(p) > 0 for p in parts):
            raise KshotError('size takes two positive numbers: COLS ROWS')
    elif verb == 'env':
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*=.*', rest):
            raise KshotError('env takes KEY=VALUE')
    elif verb == 'wait':
        if not rest.isdigit():
            raise KshotError('wait takes milliseconds')
    elif verb == 'idle':
        if rest and not rest.isdigit():
            raise KshotError('idle takes milliseconds, or nothing')
    elif verb == 'frame':
        if not rest.isdigit() or int(rest) == 0:
            raise KshotError('frame takes how long to show it, in milliseconds')
    elif verb == 'scrub':
        pattern, arrow, _ = rest.partition(SCRUB_ARROW)
        if not arrow or not pattern:
            raise KshotError(f'scrub takes REGEX{SCRUB_ARROW}TEXT')
        try:
            re.compile(pattern)
        except re.error as error:
            raise KshotError(f'scrub: {pattern!r} is not a regex ({error})') from None
    elif verb == 'snap':
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', rest):
            raise KshotError('snap takes a file name: letters, digits, . _ -')
        if rest in (ERROR_SNAP, FILM):
            raise KshotError(f'the snap name {rest!r} is kept for kshot')
    elif not rest:
        raise KshotError(f'{verb} needs an argument')


def parse_scenario(text):
    """The steps of a scenario, as (line number, verb, argument).

    Every line is checked before anything runs: an unknown step, a bad
    argument, a step that needs the app before `start`, a second `start`, a
    `size` or `model` after it and a second `model` all fail with their line
    number.
    """
    steps = []
    started = False
    modelled = False
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        verb, _, rest = line.partition(' ')
        rest = rest.strip()
        try:
            if verb not in STEPS:
                raise KshotError(f'unknown step {verb!r}')
            check_argument(verb, rest)
            if verb in APP_STEPS and not started:
                raise KshotError(f'{verb} needs the app: start it first')
            if verb == 'start' and started:
                raise KshotError('the app is already started')
            if verb in SETUP_STEPS and started:
                raise KshotError(f'{verb} must come before start')
            if verb == 'model' and modelled:
                raise KshotError('the scenario already has a model')
        except KshotError as error:
            raise KshotError(f'line {number}: {error}') from None
        started = started or verb == 'start'
        modelled = modelled or verb == 'model'
        steps.append((number, verb, rest))
    if not started:
        raise KshotError('the scenario never starts the app')
    return steps


def expand(text, places):
    """$WORK, $KHOME and $REPO replaced by their directories."""
    for key, value in places.items():
        text = text.replace(f'${key}', value)
    return text


def waitfor_argument(rest):
    """The text to wait for and the limit in ms (a trailing number)."""
    text, _, last = rest.rpartition(' ')
    if text and last.isdigit():
        return text, int(last)
    return rest, WAITFOR_MS


def resolve_scenario(name):
    """A scenario file: the path itself, or a name in scripts/kshot/scenarios."""
    if os.path.isfile(name):
        return name
    candidate = os.path.join(SCENARIOS, f'{name}.kshot')
    if os.sep not in name and os.path.isfile(candidate):
        return candidate
    known = sorted(f[:-len('.kshot')] for f in os.listdir(SCENARIOS)
                   if f.endswith('.kshot'))
    raise KshotError(f'no scenario {name!r}: pass a file, or one of '
                     f'{", ".join(known)}')


# --- the screen ------------------------------------------------------------

class Style:
    __slots__ = ('fg', 'bg', 'bold', 'dim', 'italic', 'underline', 'reverse',
                 'strike')

    def __init__(self):
        self.reset()

    def reset(self):
        self.fg = None
        self.bg = None
        self.bold = self.dim = self.italic = False
        self.underline = self.reverse = self.strike = False

    def copy(self):
        other = Style()
        for name in self.__slots__:
            setattr(other, name, getattr(self, name))
        return other


def xterm256(n):
    """An xterm 256-colour index as RGB."""
    if n < 16:
        return ANSI16[n]
    if n < 232:
        n -= 16
        steps = (0, 95, 135, 175, 215, 255)
        return (steps[n // 36], steps[(n // 6) % 6], steps[n % 6])
    level = 8 + (n - 232) * 10
    return (level, level, level)


# One SGR attribute switch per code.
FLAGS = {
    1: ('bold', True), 2: ('dim', True), 3: ('italic', True),
    4: ('underline', True), 7: ('reverse', True), 9: ('strike', True),
    23: ('italic', False), 24: ('underline', False), 27: ('reverse', False),
    29: ('strike', False),
}


def apply_sgr(style, params):
    """Apply one SGR sequence's parameters (`1;38;2;255;0;0`) to a style."""
    nums = [int(c) if c.isdigit() else 0 for c in re.split('[;:]', params)] \
        if params else [0]
    i = 0
    while i < len(nums):
        n = nums[i]
        if n == 0:
            style.reset()
        elif n in FLAGS:
            name, value = FLAGS[n]
            setattr(style, name, value)
        elif n == 22:
            style.bold = style.dim = False
        elif 30 <= n <= 37 or 90 <= n <= 97:
            style.fg = ANSI16[n - 30 if n < 90 else n - 90 + 8]
        elif 40 <= n <= 47 or 100 <= n <= 107:
            style.bg = ANSI16[n - 40 if n < 100 else n - 100 + 8]
        elif n == 39:
            style.fg = None
        elif n == 49:
            style.bg = None
        elif n in (38, 48) and i + 1 < len(nums):
            colour = None
            if nums[i + 1] == 5 and i + 2 < len(nums):
                colour = xterm256(nums[i + 2])
                i += 2
            elif nums[i + 1] == 2 and i + 4 < len(nums):
                colour = tuple(nums[i + 2:i + 5])
                i += 4
            if n == 38:
                style.fg = colour
            else:
                style.bg = colour
        i += 1


# An SGR sequence (group 1 holds its parameters) or an OSC string, such as a
# hyperlink, which draws nothing.
ESCAPE = re.compile(r'\x1b\[([0-9;:]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)')


def char_width(ch):
    """Terminal cells a character takes: 2 for wide ones, 0 for marks."""
    if unicodedata.combining(ch) or unicodedata.category(ch) == 'Cf':
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1


def parse_screen(ansi, cols, rows):
    """The screen as rows of cells: (char, Style), or None for the second
    half of a wide character. Styles carry over from line to line, as tmux
    writes them."""
    grid = []
    style = Style()

    def put(row, text):
        for ch in text:
            width = char_width(ch)
            if width == 0:
                continue
            row.append((ch, style.copy()))
            if width == 2:
                row.append(None)

    for line in ansi.split('\n')[:rows]:
        row = []
        pos = 0
        for match in ESCAPE.finditer(line):
            put(row, line[pos:match.start()])
            if match.group(1) is not None:
                apply_sgr(style, match.group(1))
            pos = match.end()
        put(row, line[pos:])
        row = row[:cols]
        while len(row) < cols:
            row.append((' ', Style()))
        grid.append(row)
    while len(grid) < rows:
        grid.append([(' ', Style()) for _ in range(cols)])
    return grid


def parse_scrub(rest):
    """A scrub step's (compiled regex, replacement)."""
    pattern, _, text = rest.partition(SCRUB_ARROW)
    return re.compile(pattern), text


def scrub_grid(grid, scrubs):
    """Put each scrub's text where its regex matches a row, padded or cut on
    the left to the matched width, so nothing else on the row moves and a
    number keeps its unit (`12ms` in a three-cell match is `2ms`). The cells
    keep their styles."""
    for row in grid:
        for pattern, text in scrubs:
            line = ''.join('\0' if cell is None else cell[0] for cell in row)
            for match in pattern.finditer(line):
                width = match.end() - match.start()
                fill = match.expand(text).rjust(width)[-width:] if width else ''
                for offset, ch in enumerate(fill):
                    cell = row[match.start() + offset]
                    if cell is not None:
                        row[match.start() + offset] = (ch, cell[1])
    return grid


def grid_text(grid):
    """The plain text of a grid, one line per row, trailing spaces dropped."""
    return '\n'.join(''.join(cell[0] for cell in row if cell is not None).rstrip()
                     for row in grid) + '\n'


def sgr(style):
    """The SGR sequence that sets STYLE from a reset."""
    codes = ['0']
    for name, code in (('bold', '1'), ('dim', '2'), ('italic', '3'),
                       ('underline', '4'), ('reverse', '7'), ('strike', '9')):
        if getattr(style, name):
            codes.append(code)
    if style.fg is not None:
        codes.append('38;2;%d;%d;%d' % style.fg)
    if style.bg is not None:
        codes.append('48;2;%d;%d;%d' % style.bg)
    return f'\x1b[{";".join(codes)}m'


def grid_ansi(grid):
    """A grid written back as text with SGR sequences."""
    lines = []
    for row in grid:
        out, last = [], None
        for cell in row:
            if cell is None:
                continue
            code = sgr(cell[1])
            if code != last:
                out.append(code)
                last = code
            out.append(cell[0])
        lines.append(''.join(out) + '\x1b[0m')
    return '\n'.join(lines) + '\n'


# --- fonts and the PNG -----------------------------------------------------

def pillow():
    """Pillow's modules, imported only when a PNG is drawn."""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        raise KshotError('drawing the PNG needs Pillow: '
                         'python3 -m pip install Pillow') from None
    return Image, ImageDraw, ImageFont


def font_index(dirs=FONT_DIRS):
    """Every font file under the font directories, by file name; the first
    directory that has a name wins."""
    index = {}
    for base in dirs:
        for folder, _, files in os.walk(os.path.expanduser(base)):
            for name in sorted(files):
                index.setdefault(name, os.path.join(folder, name))
    return index


def locate(index, entry):
    """(path, face) of a FAMILIES entry, or None when it is not installed."""
    name, _, face = entry.partition('#')
    path = index.get(name)
    return None if path is None else (path, int(face or 0))


def choose_faces(index, override=None):
    """The (path, face) of the regular, bold, italic and bold-italic faces:
    the --font file and its siblings, or the first installed family. A face
    the family lacks is the regular one."""
    if override:
        if not os.path.isfile(override):
            raise KshotError(f'no font file {override!r}')
        folder, name = os.path.split(override)
        faces = [(override, 0)]
        for style in ('Bold', 'Italic', 'BoldItalic'):
            sibling = os.path.join(folder, name.replace('Regular', style))
            faces.append((sibling, 0) if 'Regular' in name
                         and os.path.isfile(sibling) else (override, 0))
        return faces
    for family in FAMILIES:
        faces = [locate(index, entry) for entry in family]
        if faces[0] is not None:
            return [face or faces[0] for face in faces]
    raise KshotError('no monospace font found (JetBrains Mono, Menlo, DejaVu '
                     'Sans Mono or Liberation Mono): pass --font FILE')


class Fonts:
    """The faces a screen is drawn with, and the cell they make."""

    def __init__(self, faces, symbols, scale=1):
        _, _, image_font = pillow()
        self.scale = scale
        size = FONT_SIZE * scale
        self.main = {}
        for key, (path, face) in zip(((False, False), (True, False),
                                      (False, True), (True, True)), faces):
            self.main[key] = image_font.truetype(path, size, index=face)
        # Without a bold face, bold text is drawn twice, one pixel apart.
        self.synthetic_bold = faces[1] == faces[0]
        self.fallbacks = [image_font.truetype(path, size)
                          for path in symbols]
        regular = self.main[(False, False)]
        self.cell_w = round(regular.getlength('M'))
        ascent, descent = regular.getmetrics()
        self.cell_h = ascent + descent
        self.missing = {}
        self.notdef = {}

    def has_glyph(self, font, ch):
        if id(font) not in self.notdef:
            self.notdef[id(font)] = glyph_bitmap(font, UNASSIGNED)
        return glyph_bitmap(font, ch) != self.notdef[id(font)]

    def font_for(self, ch, bold, italic):
        """The face for a character: the family's, else the first fallback
        that has the glyph."""
        font = self.main[(bold, italic)]
        key = (ch, bold, italic)
        if key not in self.missing:
            self.missing[key] = ch.strip() != '' and not self.has_glyph(font, ch)
        if not self.missing[key]:
            return font
        for fallback in self.fallbacks:
            if self.has_glyph(fallback, ch):
                return fallback
        return font


def glyph_bitmap(font, ch):
    image_module, draw_module, _ = pillow()
    image = image_module.new('L', (40, 40), 0)
    draw_module.Draw(image).text((4, 4), ch, font=font, fill=255)
    return image.tobytes()


def blend(a, b, t):
    return tuple(round(x * (1 - t) + y * t) for x, y in zip(a, b))


def render_png(grid, cursor, path, fonts):
    """Draw the cells, then a box on the cursor cell; lines and the padding
    grow with the fonts' scale."""
    image_module, draw_module, _ = pillow()
    s = fonts.scale
    pad = PAD * s
    cols = len(grid[0]) if grid else 0
    image = image_module.new('RGB', (cols * fonts.cell_w + 2 * pad,
                                     len(grid) * fonts.cell_h + 2 * pad),
                             DEFAULT_BG)
    draw = draw_module.Draw(image)
    for y, row in enumerate(grid):
        for x, cell in enumerate(row):
            if cell is None:
                continue
            ch, style = cell
            fg = style.fg or DEFAULT_FG
            bg = style.bg or DEFAULT_BG
            if style.reverse:
                fg, bg = bg, fg
            if style.dim:
                fg = blend(fg, bg, 0.45)
            wide = x + 1 < cols and row[x + 1] is None
            left = pad + x * fonts.cell_w
            top = pad + y * fonts.cell_h
            right = left + fonts.cell_w * (2 if wide else 1) - 1
            bottom = top + fonts.cell_h - 1
            if bg != DEFAULT_BG:
                draw.rectangle([left, top, right, bottom], fill=bg)
            if ch.strip():
                font = fonts.font_for(ch, style.bold, style.italic)
                draw.text((left, top), ch, font=font, fill=fg)
                if style.bold and fonts.synthetic_bold:
                    draw.text((left + s, top), ch, font=font, fill=fg)
            if style.underline:
                draw.rectangle([left, bottom - 2 * s + 1, right, bottom - s], fill=fg)
            if style.strike:
                middle = top + fonts.cell_h // 2
                draw.rectangle([left, middle, right, middle + s - 1], fill=fg)
    if cursor is not None:
        left = pad + cursor[0] * fonts.cell_w
        top = pad + cursor[1] * fonts.cell_h
        draw.rectangle([left, top, left + fonts.cell_w - 1,
                        top + fonts.cell_h - 1], outline=CURSOR, width=s)
    image.save(path)


# --- the run ---------------------------------------------------------------

class Tmux:
    """A private tmux server: its own socket and no user configuration, so
    the caller's sessions and tmux.conf are never touched."""

    SESSION = 'kshot'

    def __init__(self):
        if shutil.which('tmux') is None:
            raise KshotError('kshot needs tmux on PATH')
        self.socket = f'kshot-{os.getpid()}'
        self.started = False

    def __call__(self, *args, check=True):
        result = subprocess.run(
            ['tmux', '-L', self.socket, '-f', '/dev/null', *args],
            capture_output=True, text=True, check=False)
        if check and result.returncode != 0:
            raise KshotError(f'tmux {args[0]}: {result.stderr.strip()}')
        return result.stdout

    def start(self, command, cwd, cols, rows):
        # The pane stays after the app exits, so a last snap can show its
        # final screen, and the window keeps the scenario's size.
        self('new-session', '-d', '-s', self.SESSION, '-x', str(cols),
             '-y', str(rows), '-c', cwd, command,
             ';', 'set-option', '-g', 'remain-on-exit', 'on',
             ';', 'set-option', '-g', 'window-size', 'manual')
        self.started = True

    def screen(self, styled=False):
        flags = ['-e', '-N'] if styled else []
        return self('capture-pane', '-p', *flags, '-t', self.SESSION)

    def cursor(self):
        x, y, shown = self('display-message', '-p', '-t', self.SESSION,
                           '#{cursor_x} #{cursor_y} #{cursor_flag}').split()
        return (int(x), int(y)) if shown == '1' else None

    def close(self):
        if self.started:
            self('kill-server', check=False)
            self.started = False


def capture(tmux, cols, rows, scrubs):
    """The screen as a grid, scrubbed."""
    ansi = tmux.screen(styled=True)
    return scrub_grid(parse_screen(ansi.rstrip('\n'), cols, rows), scrubs)


def snapshot(tmux, out_dir, name, cols, rows, fonts, scrubs=()):
    """Write NAME.ansi, NAME.txt, NAME.png and NAME.svg; return the PNG's
    path."""
    grid = capture(tmux, cols, rows, scrubs)
    with open(os.path.join(out_dir, f'{name}.ansi'), 'w') as handle:
        handle.write(grid_ansi(grid))
    with open(os.path.join(out_dir, f'{name}.txt'), 'w') as handle:
        handle.write(grid_text(grid))
    with open(os.path.join(out_dir, f'{name}.svg'), 'w') as handle:
        handle.write(film.film_svg([(grid, 0)], 'Kubic', f'The Kubic TUI: {name}.'))
    png = os.path.join(out_dir, f'{name}.png')
    render_png(grid, tmux.cursor(), png, fonts)
    return png


def write_film(out_dir, frames, scenario):
    path = os.path.join(out_dir, f'{FILM}.svg')
    with open(path, 'w') as handle:
        handle.write(film.film_svg(frames, 'Kubic', f'A Kubic session in the TUI, '
                                   f'recorded by kshot from {scenario}.'))
    return path


def serve_model(step_file, scenario, khome, env):
    """Serve the script beside SCENARIO and point the app at it: a
    models.json in HOME names it, and the faux provider is dropped."""
    path = os.path.join(os.path.dirname(os.path.abspath(scenario)), step_file)
    try:
        with open(path) as handle:
            script = model.load_script(handle.read())
    except OSError as error:
        raise KshotError(f'model: cannot read {step_file}: {error.strerror}') from None
    except model.ScriptError as error:
        raise KshotError(f'model: {step_file}: {error}') from None
    served = model.ScriptedModel(script)
    folder = os.path.join(khome, '.kubic', 'models')
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, 'models.json'), 'w') as handle:
        json.dump({'providers': {script.get('provider', 'kshot'):
                                 model.provider_entry(script, served.base_url)}}, handle, indent=2)
    env.pop('KUBIC_PROVIDER', None)
    return served


def base_env(khome):
    """The only environment a scenario's commands see."""
    return {
        'PATH': os.environ.get('PATH', ''),
        'HOME': khome,
        'TERM': 'xterm-256color',
        'COLORTERM': 'truecolor',
        'LANG': 'en_US.UTF-8',
        'LC_ALL': 'en_US.UTF-8',
        'KUBIC_PROVIDER': 'faux',
        'KUBIC_TRUST_PROJECT': '1',
    }


def wait_for_text(tmux, text, limit_ms):
    deadline = time.monotonic() + limit_ms / 1000
    while text not in tmux.screen():
        if time.monotonic() > deadline:
            raise KshotError(f'timed out after {limit_ms} ms waiting for '
                             f'{text!r}')
        time.sleep(POLL_S)


def wait_for_idle(tmux, quiet_ms):
    last = None
    since = time.monotonic()
    deadline = since + IDLE_LIMIT_S
    while time.monotonic() < deadline:
        screen = tmux.screen(styled=True)
        if screen != last:
            last, since = screen, time.monotonic()
        elif time.monotonic() - since >= quiet_ms / 1000:
            return
        time.sleep(POLL_S)


def run(scenario, out_dir, keep, font=None, scale=1):
    with open(scenario) as handle:
        steps = parse_scenario(handle.read())
    fonts = Fonts(choose_faces(font_index(), font),
                  [path for name, path in sorted(font_index().items())
                   if name in SYMBOL_FONTS], scale)
    tmux = Tmux()
    os.makedirs(out_dir, exist_ok=True)
    for ext in ('png', 'txt', 'ansi'):
        stale = os.path.join(out_dir, f'{ERROR_SNAP}.{ext}')
        if os.path.exists(stale):
            os.remove(stale)
    # Real paths, so the app's `~` matches HOME where /tmp is a link.
    work = os.path.realpath(tempfile.mkdtemp(prefix='kshot-work-'))
    khome = os.path.realpath(tempfile.mkdtemp(prefix='kshot-home-'))
    places = {'WORK': work, 'KHOME': khome, 'REPO': REPO}
    cols, rows = DEFAULT_SIZE
    env = base_env(khome)
    scrubs = []
    frames = []
    served = None
    try:
        for number, verb, raw in steps:
            rest = expand(raw, places)
            try:
                if verb == 'size':
                    cols, rows = (int(v) for v in rest.split())
                elif verb == 'env':
                    key, _, value = rest.partition('=')
                    env[key] = value
                elif verb == 'model':
                    served = serve_model(rest, scenario, khome, env)
                elif verb == 'scrub':
                    scrubs.append(parse_scrub(raw))
                elif verb == 'frame':
                    frames.append((capture(tmux, cols, rows, scrubs), int(rest)))
                elif verb == 'sh':
                    code = subprocess.run(rest, shell=True, cwd=work,
                                          env=env).returncode
                    if code != 0:
                        raise KshotError(f'sh exited {code}')
                elif verb == 'start':
                    assignments = ' '.join(f'{k}={shlex.quote(v)}'
                                           for k, v in env.items())
                    tmux.start(f'env -i {assignments} {rest}', work, cols,
                               rows)
                elif verb == 'type':
                    tmux('send-keys', '-t', Tmux.SESSION, '-l', rest)
                elif verb == 'key':
                    tmux('send-keys', '-t', Tmux.SESSION, *rest.split())
                elif verb == 'wait':
                    time.sleep(int(rest) / 1000)
                elif verb == 'waitfor':
                    wait_for_text(tmux, *waitfor_argument(rest))
                elif verb == 'idle':
                    wait_for_idle(tmux, int(rest) if rest else IDLE_MS)
                elif verb == 'snap':
                    png = snapshot(tmux, out_dir, rest, cols, rows, fonts, scrubs)
                    print(f'snap {rest}: {png}')
            except KshotError as error:
                raise KshotError(f'line {number}: {error}') from None
        if frames:
            path = write_film(out_dir, frames, os.path.basename(scenario))
            print(f'film of {len(frames)} frames: {path}')
    except KshotError:
        if tmux.started:
            png = snapshot(tmux, out_dir, ERROR_SNAP, cols, rows, fonts, scrubs)
            print(f'the screen at the failure: {png}', file=sys.stderr)
        raise
    finally:
        tmux.close()
        if served is not None:
            served.close()
        if keep:
            print(f'kept: WORK={work} KHOME={khome}')
        else:
            shutil.rmtree(work, ignore_errors=True)
            shutil.rmtree(khome, ignore_errors=True)


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog='kshot',
        description='Screenshots of the Kubic TUI, driven by a scenario. '
                    'The scenario language is described at the top of '
                    'scripts/kshot/kshot.py.')
    parser.add_argument('scenario',
                        help='a scenario file, or the name of one in '
                             'scripts/kshot/scenarios')
    parser.add_argument('--out', help='where the snapshots go (default: '
                                      '.kshot/NAME in the checkout)')
    parser.add_argument('--keep', action='store_true',
                        help='keep $WORK and $KHOME, and print where they are')
    parser.add_argument('--font', default=os.environ.get('KSHOT_FONT'),
                        help='the regular face to draw with, a .ttf or .otf '
                             'file; its Bold, Italic and BoldItalic siblings '
                             'are used when present (default: $KSHOT_FONT, '
                             'else the first of JetBrains Mono, Menlo, DejaVu '
                             'Sans Mono and Liberation Mono found)')
    parser.add_argument('--scale', type=int, choices=(1, 2, 3), default=1,
                        help='draw each PNG this many times as large, for '
                             'high-density screens (default: 1)')
    args = parser.parse_args(argv)
    try:
        scenario = resolve_scenario(args.scenario)
        name = os.path.splitext(os.path.basename(scenario))[0]
        out_dir = args.out or os.path.join(REPO, '.kshot', name)
        run(scenario, out_dir, args.keep, args.font, args.scale)
    except KshotError as error:
        print(f'kshot: {error}', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == '__main__':
    sys.exit(main())
