"""kshot's scenario, colour and screen parsing, and its font choice.

These run without tmux or Pillow (scripts/kshot.test.mjs runs them in
`npm run check`): drawing the PNG is covered by running a scenario.
"""

import os
import tempfile
import unittest

import kshot


class ScenarioTest(unittest.TestCase):
    def test_steps_keep_their_line_numbers_and_skip_comments(self):
        steps = kshot.parse_scenario(
            '# a comment\n'
            '\n'
            'size 80 24\n'
            'start node app.js\n'
            '  type hello there  \n'
            'snap first\n')
        self.assertEqual(steps, [
            (3, 'size', '80 24'),
            (4, 'start', 'node app.js'),
            (5, 'type', 'hello there'),
            (6, 'snap', 'first'),
        ])

    def test_refuses_a_bad_scenario_before_anything_runs(self):
        cases = {
            'start x\nfrobnicate\n': "line 2: unknown step 'frobnicate'",
            'size 80\nstart x\n': 'line 1: size takes two positive numbers',
            'start x\nwait soon\n': 'line 2: wait takes milliseconds',
            'start x\nidle a\n': 'line 2: idle takes milliseconds',
            'start x\nsnap ../out\n': 'line 2: snap takes a file name',
            'start x\nsnap error\n': "line 2: the snap name 'error' is kept",
            'env 1X=y\nstart x\n': 'line 1: env takes KEY=VALUE',
            'start x\ntype\n': 'line 2: type needs an argument',
            'type hi\nstart x\n': 'line 1: type needs the app',
            'start x\nstart y\n': 'line 2: the app is already started',
            'start x\nsize 80 24\n': 'line 2: size must come before start',
            'sh true\n': 'the scenario never starts the app',
        }
        for text, message in cases.items():
            with self.subTest(text=text):
                with self.assertRaises(kshot.KshotError) as caught:
                    kshot.parse_scenario(text)
                self.assertIn(message, str(caught.exception))

    def test_a_trailing_number_is_the_wait_limit(self):
        self.assertEqual(kshot.waitfor_argument('faux echo: hi there'),
                         ('faux echo: hi there', kshot.WAITFOR_MS))
        self.assertEqual(kshot.waitfor_argument('ready 2000'), ('ready', 2000))
        self.assertEqual(kshot.waitfor_argument('42'), ('42', kshot.WAITFOR_MS))
        self.assertEqual(kshot.waitfor_argument('100% done'),
                         ('100% done', kshot.WAITFOR_MS))

    def test_expands_the_three_places(self):
        places = {'WORK': '/w', 'KHOME': '/h', 'REPO': '/r'}
        self.assertEqual(kshot.expand('node $REPO/bin in $WORK as $KHOME',
                                      places),
                         'node /r/bin in /w as /h')

    def test_finds_a_scenario_by_name(self):
        self.assertEqual(kshot.resolve_scenario('panels'),
                         os.path.join(kshot.SCENARIOS, 'panels.kshot'))
        with self.assertRaises(kshot.KshotError) as caught:
            kshot.resolve_scenario('no-such-scenario')
        self.assertIn('panels', str(caught.exception))

    def test_every_shipped_scenario_parses(self):
        for name in os.listdir(kshot.SCENARIOS):
            with self.subTest(name=name):
                with open(os.path.join(kshot.SCENARIOS, name)) as handle:
                    self.assertTrue(kshot.parse_scenario(handle.read()))


class ColourTest(unittest.TestCase):
    def test_reads_truecolor_256_and_base_colours(self):
        style = kshot.Style()
        kshot.apply_sgr(style, '1;38;2;255;0;10;48;5;196')
        self.assertTrue(style.bold)
        self.assertEqual(style.fg, (255, 0, 10))
        self.assertEqual(style.bg, (255, 0, 0))
        kshot.apply_sgr(style, '22;31;104')
        self.assertFalse(style.bold)
        self.assertEqual(style.fg, kshot.ANSI16[1])
        self.assertEqual(style.bg, kshot.ANSI16[12])
        kshot.apply_sgr(style, '39;49')
        self.assertIsNone(style.fg)
        self.assertIsNone(style.bg)

    def test_switches_attributes_on_and_off(self):
        style = kshot.Style()
        kshot.apply_sgr(style, '2;3;4;7;9')
        self.assertEqual((style.dim, style.italic, style.underline,
                          style.reverse, style.strike), (True,) * 5)
        kshot.apply_sgr(style, '23;24;27;29')
        self.assertEqual((style.italic, style.underline, style.reverse,
                          style.strike), (False,) * 4)
        kshot.apply_sgr(style, '')
        self.assertFalse(style.dim)

    def test_maps_the_256_colour_cube_and_greys(self):
        self.assertEqual(kshot.xterm256(16), (0, 0, 0))
        self.assertEqual(kshot.xterm256(231), (255, 255, 255))
        self.assertEqual(kshot.xterm256(232), (8, 8, 8))


class ScreenTest(unittest.TestCase):
    def test_pads_the_grid_and_carries_styles_across_lines(self):
        grid = kshot.parse_screen('\x1b[31mred\nstill red\x1b[0m', 12, 3)
        self.assertEqual(len(grid), 3)
        self.assertTrue(all(len(row) == 12 for row in grid))
        self.assertEqual(''.join(cell[0] for cell in grid[1][:9]), 'still red')
        self.assertEqual(grid[1][0][1].fg, kshot.ANSI16[1])
        self.assertIsNone(grid[1][10][1].fg)

    def test_a_wide_character_takes_two_cells(self):
        row = kshot.parse_screen('a张b', 6, 1)[0]
        self.assertEqual(row[1][0], '张')
        self.assertIsNone(row[2])
        self.assertEqual(row[3][0], 'b')

    def test_drops_marks_and_hyperlinks(self):
        text = 'é \x1b]8;;https://example.com\x07link\x1b]8;;\x07'
        row = kshot.parse_screen(text, 8, 1)[0]
        self.assertEqual(''.join(cell[0] for cell in row[:6]), 'e link')


class FontTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='kshot-fonts-')

    def tearDown(self):
        for name in os.listdir(self.dir):
            os.remove(os.path.join(self.dir, name))
        os.rmdir(self.dir)

    def touch(self, *names):
        for name in names:
            open(os.path.join(self.dir, name), 'w').close()

    def test_prefers_the_first_installed_family(self):
        self.touch('DejaVuSansMono.ttf', 'DejaVuSansMono-Bold.ttf', 'Menlo.ttc')
        faces = kshot.choose_faces(kshot.font_index([self.dir]))
        menlo = os.path.join(self.dir, 'Menlo.ttc')
        self.assertEqual(faces, [(menlo, 0), (menlo, 1), (menlo, 2),
                                 (menlo, 3)])

    def test_a_missing_face_is_the_regular_one(self):
        self.touch('DejaVuSansMono.ttf', 'DejaVuSansMono-Bold.ttf')
        faces = kshot.choose_faces(kshot.font_index([self.dir]))
        regular = (os.path.join(self.dir, 'DejaVuSansMono.ttf'), 0)
        bold = (os.path.join(self.dir, 'DejaVuSansMono-Bold.ttf'), 0)
        self.assertEqual(faces, [regular, bold, regular, regular])

    def test_a_font_file_brings_its_siblings(self):
        self.touch('Mono-Regular.ttf', 'Mono-Bold.ttf')
        regular = os.path.join(self.dir, 'Mono-Regular.ttf')
        faces = kshot.choose_faces({}, regular)
        self.assertEqual(faces, [(regular, 0),
                                 (os.path.join(self.dir, 'Mono-Bold.ttf'), 0),
                                 (regular, 0), (regular, 0)])

    def test_says_how_to_fix_a_missing_font(self):
        with self.assertRaises(kshot.KshotError) as caught:
            kshot.choose_faces({})
        self.assertIn('--font', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
