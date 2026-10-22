"""The brand art's wordmark, dither field and icons.

These run without fontTools or the fonts (scripts/art.test.mjs runs them in
`npm run check`): the type is covered by drawing the art.
"""

import unittest

import art


class WordmarkTest(unittest.TestCase):
    def test_reads_the_tui_wordmark(self):
        with open(art.PREFLIGHT, encoding='utf-8') as handle:
            rows = art.wordmark_rows(handle.read())
        self.assertEqual(len(rows), 2)
        self.assertEqual(len(rows[0]), len(rows[1]))

    def test_a_half_block_lights_half_a_cell(self):
        pixels = art.wordmark_pixels(('█▀ ', '▄ █'))
        self.assertEqual(sorted(pixels), [(0, 0), (0, 1), (0, 3), (1, 0), (2, 2), (2, 3)])

    def test_refuses_a_glyph_it_cannot_draw(self):
        with self.assertRaises(art.ArtError):
            art.wordmark_pixels(('█▌', '  '))
        with self.assertRaises(art.ArtError):
            art.wordmark_rows('const OTHER = 1;')

    def test_the_drawn_wordmark_assembles_left_to_right(self):
        svg = art.draw_wordmark([(0, 0), (3, 0)], 10, 20, 5, '#f00')
        self.assertIn('animation-delay:0.00s" x="10" y="20" width="5" height="5"', svg)
        self.assertIn('animation-delay:0.14s" x="25" y="20"', svg)


class DitherTest(unittest.TestCase):
    COLOURS = {'accent': ('#ff004d', 1), 'quiet': ('#fff', 0.22)}

    def field(self, **options):
        return art.dither((0, 0, 320, 160), 'right', 0.4, 0.12, 6.0, self.COLOURS, **options)

    def test_thresholds_cover_the_matrix_once(self):
        values = {art.bayer8(x, y) for x in range(8) for y in range(8)}
        self.assertEqual(len(values), 64)
        self.assertTrue(all(0 < v < 1 for v in values))

    def test_the_hash_is_stable_and_in_range(self):
        self.assertEqual(art.unit_hash(3, 7), art.unit_hash(3, 7))
        self.assertNotEqual(art.unit_hash(3, 7), art.unit_hash(7, 3))
        self.assertTrue(all(0 <= art.unit_hash(x, 11) < 1 for x in range(500)))

    def test_dots_along_a_row_move_relatively(self):
        self.assertEqual(art.stroke_dots([(5, 40), (5, 8), (21, 8)], 6),
                         'M8 5h6m26 0h6M8 21h6')

    def test_the_field_is_the_same_every_time(self):
        self.assertEqual(self.field(), self.field())

    def test_dots_stay_inside_the_box_and_clear_of_the_keep_out(self):
        svg, _ = self.field(keep_out=200)
        for x, y in art_points(svg):
            self.assertGreaterEqual(x, 200)
            self.assertLess(x, 320)
            self.assertLess(y, 160)

    def test_a_swinging_dot_shares_its_band_and_arc(self):
        svg, css = self.field()
        self.assertRegex(svg, r'class="(accent|quiet) dg b\d+ k\d"')
        self.assertIn('@keyframes k1{', css)
        self.assertIn('.b0{animation-duration:', css)
        self.assertIn('.quiet{stroke:#fff;stroke-opacity:0.22}', css)


class FileTest(unittest.TestCase):
    def test_every_icon_is_a_titled_twelve_pixel_grid(self):
        for name, (title, rows) in art.ICONS.items():
            with self.subTest(name=name):
                self.assertEqual(len(rows), 12)
                self.assertTrue(all(len(r) == 12 and set(r) <= {'.', '#'} for r in rows))
                self.assertIn(f'<title>{title}</title>', art.icon(name))

    def test_a_file_names_itself_and_carries_nothing_outside(self):
        svg = art.svg(10, 10, 'Kubic', 'A test.', '.a{}', '<rect width="10" height="10"/>')
        self.assertIn('<title id="title">Kubic</title><desc id="desc">A test.</desc>', svg)
        for forbidden in ('<script', 'href=', '@import', 'url('):
            self.assertNotIn(forbidden, svg + art.icon('journal'))


def art_points(svg):
    """The (x, y) of every dot a dither path draws."""
    import re
    points = []
    for d in re.findall(r' d="([^"]+)"', svg):
        x = y = 0
        for cmd, a, b in re.findall(r'([Mm])(-?\d+) (-?\d+)', d):
            x, y = (int(a), int(b)) if cmd == 'M' else (x + int(a), y + int(b))
            points.append((x, y))
            x += 6
    return points


if __name__ == '__main__':
    unittest.main()
