"""kshot's scenario, colour and screen parsing, its scrubs and its font choice.

These run without tmux or Pillow (scripts/kshot.test.mjs runs them in
`npm run check`): drawing the PNG is covered by running a scenario.
"""

import os
import tempfile
import unittest

import kshot
import model


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
            'start x\nmodel m.json\n': 'line 2: model must come before start',
            'model a.json\nmodel b.json\nstart x\n':
                'line 2: the scenario already has a model',
            'start x\nframe soon\n': 'line 2: frame takes how long',
            'start x\nframe 0\n': 'line 2: frame takes how long',
            'frame 100\nstart x\n': 'line 1: frame needs the app',
            'scrub 12:34\nstart x\n': 'line 1: scrub takes REGEX => TEXT',
            'scrub ( => x\nstart x\n': "line 1: scrub: '(' is not a regex",
            'start x\nsnap film\n': "line 2: the snap name 'film' is kept",
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
            if not name.endswith('.kshot'):
                continue
            with self.subTest(name=name):
                with open(os.path.join(kshot.SCENARIOS, name)) as handle:
                    self.assertTrue(kshot.parse_scenario(handle.read()))

    def test_every_shipped_model_script_loads(self):
        for name in os.listdir(kshot.SCENARIOS):
            if not name.endswith('.json'):
                continue
            with self.subTest(name=name):
                with open(os.path.join(kshot.SCENARIOS, name)) as handle:
                    self.assertTrue(model.load_script(handle.read())['replies'])

    def test_a_scrub_keeps_its_regex_and_its_text(self):
        steps = kshot.parse_scenario('scrub \\d\\d:\\d\\d => 09:41\nstart x\n')
        pattern, text = kshot.parse_scrub(steps[0][2])
        self.assertTrue(pattern.search('at 05:04'))
        self.assertEqual(text, '09:41')


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

    def test_a_scrub_overwrites_in_place_and_keeps_the_styles(self):
        grid = kshot.parse_screen(
            '\x1b[2msession 01a1…00f4\x1b[0m │ 05:04', 30, 1)
        kshot.scrub_grid(grid, [
            kshot.parse_scrub(r'\w{4}…\w{4} => 0193…a7c2'),
            kshot.parse_scrub(r'(\d\d):\d\d => \1:41'),
            kshot.parse_scrub('session => id'),
        ])
        self.assertEqual(kshot.grid_text(grid), '     id 0193…a7c2 │ 05:41\n')
        self.assertTrue(grid[0][10][1].dim)
        self.assertFalse(grid[0][22][1].dim)

    def test_a_longer_scrub_keeps_its_end(self):
        grid = kshot.parse_screen('read · 1ms', 12, 1)
        kshot.scrub_grid(grid, [kshot.parse_scrub(r'\b\d+ms\b => 12ms')])
        self.assertEqual(kshot.grid_text(grid), 'read · 2ms\n')

    def test_the_docs_scenarios_scrub_a_timing_whatever_its_width(self):
        # A tool card ends with a right-aligned label (`✓ exit 0 · 105ms`): a
        # wider timing moves the whole label left, so the docs scenarios scrub
        # the gap before it too, and the docs images stay the same run to run.
        for name in ('docs-tour', 'readme-session'):
            with open(kshot.resolve_scenario(name), encoding='utf-8') as file:
                scrubs = [kshot.parse_scrub(rest) for _, verb, rest
                          in kshot.parse_scenario(file.read())
                          if verb == 'scrub']
            for label in ('✓ exit 0 · ', '+2 −0 · ', '6 lines · '):
                texts = set()
                for ms in ('7', '48', '105', '2345'):
                    row = f'  ● bash  x.js{(label + ms + "ms").rjust(40)}'
                    grid = kshot.parse_screen(row, 80, 1)
                    kshot.scrub_grid(grid, scrubs)
                    texts.add(kshot.grid_text(grid))
                self.assertEqual(len(texts), 1, f'{name}: {sorted(texts)}')
                self.assertTrue(texts.pop().endswith(f'{label}12ms\n'))

    def test_a_grid_written_back_as_ansi_reads_the_same(self):
        grid = kshot.parse_screen(
            '\x1b[1;38;2;255;0;77mKUBIC\x1b[0m a张b \x1b[7;48;5;196mx', 12, 2)
        again = kshot.parse_screen(kshot.grid_ansi(grid).rstrip('\n'), 12, 2)
        self.assertEqual(kshot.grid_text(again), kshot.grid_text(grid))
        for row, other in zip(grid, again):
            for cell, copy in zip(row, other):
                if cell is None:
                    self.assertIsNone(copy)
                    continue
                for name in kshot.Style.__slots__:
                    self.assertEqual(getattr(cell[1], name),
                                     getattr(copy[1], name), name)


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
