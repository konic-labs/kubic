"""kshot's SVG screens: one row's runs, a still and a film."""

import re
import unittest

import film
import kshot


def grid(*lines, cols=24):
    return kshot.parse_screen('\n'.join(lines), cols, len(lines))


class RowTest(unittest.TestCase):
    def test_a_run_spans_its_cells_and_keeps_its_spaces(self):
        svg = film.row_svg(grid('\x1b[1;38;2;255;0;77mKUBIC\x1b[0m   two words')[0])
        self.assertIn('<text x="0" y="13.5" textLength="42" fill="#ff004d" '
                      'font-weight="700">KUBIC</text>', svg)
        self.assertIn('x="67.2" y="13.5" textLength="75.6"', svg)
        self.assertIn('>two words</text>', svg)

    def test_draws_backgrounds_but_not_the_default_one(self):
        svg = film.row_svg(grid('plain \x1b[48;2;14;38;23m+ added \x1b[0m')[0])
        self.assertEqual(svg.count('<rect'), 1)
        self.assertIn('<rect x="50.4" width="67.2" height="18" fill="#0e2617"/>', svg)

    def test_reverse_swaps_the_colours(self):
        svg = film.row_svg(grid('\x1b[7m ok \x1b[0m')[0])
        self.assertIn(f'fill="{film.hex_colour(film.FG)}"/>', svg)
        self.assertIn(f'fill="{film.hex_colour(film.BG)}">ok</text>', svg)

    def test_escapes_markup_and_counts_wide_characters_twice(self):
        svg = film.row_svg(grid('a<b>&c 张x')[0])
        self.assertIn('textLength="84" fill="#ececf1">a&lt;b&gt;&amp;c 张x</text>', svg)


class FilmTest(unittest.TestCase):
    def test_a_still_has_no_motion(self):
        svg = film.film_svg([(grid('hello'), 0)], 'Kubic', 'A still.')
        self.assertNotIn('@keyframes', svg)
        self.assertIn('<title id="title">Kubic</title>', svg)
        self.assertNotIn('<script', svg)

    def test_a_film_shares_its_rows_and_holds_each_frame(self):
        first = grid('same row', 'one')
        second = grid('same row', 'two')
        svg = film.film_svg([(first, 1000), (second, 3000)], 'Kubic', 'A film.')
        self.assertEqual(svg.count('<g id="r'), 3)
        self.assertEqual(svg.count('<use href="#r0"'), 2)
        self.assertIn('animation-duration:4.00s', svg)
        self.assertIn('@keyframes f0{0%{opacity:1}25%{opacity:0}}', svg)
        self.assertIn('@keyframes f1{0%{opacity:0}25%{opacity:1}100%{opacity:1}}', svg)
        self.assertIn('class="f f1 poster"', svg)
        self.assertIn('prefers-reduced-motion', svg)

    def test_blank_rows_are_not_drawn(self):
        svg = film.film_svg([(grid('', 'text', ''), 0)], 'Kubic', 'A still.')
        self.assertEqual(re.findall(r'<use href="#r\d+" y="(\d+)"', svg), ['18'])


if __name__ == '__main__':
    unittest.main()
