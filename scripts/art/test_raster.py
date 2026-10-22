"""raster.py: its style sheet, colour and transform reading, its coverage,
and drawing a file.

The reading and the coverage run without Pillow or fontTools
(scripts/art.test.mjs runs them in `npm run check`); drawing needs both and
is skipped without them.
"""

import importlib.util
import unittest

import raster

DRAWS = all(importlib.util.find_spec(name) for name in ('PIL', 'fontTools'))


def svg(width, height, body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
            f'width="{width}" height="{height}">{body}</svg>')


class StyleTest(unittest.TestCase):
    def test_reads_class_rules_and_leaves_out_motion(self):
        css = ('.px{animation:px .7s backwards;transform-origin:50% 50%}'
               '@keyframes px{from{opacity:0}to{opacity:1}}'
               '.quiet{stroke:#fff;stroke-opacity:0.22}'
               '@media (prefers-reduced-motion:reduce){svg .px{animation:none}}')
        self.assertEqual(raster.class_rules(css), [
            ('px', {}), ('quiet', {'stroke': '#fff', 'stroke-opacity': '0.22'})])

    def test_refuses_a_rule_a_still_would_have_to_honour(self):
        for css in ('.a{opacity:.5}', 'svg .a{fill:#fff}', '.a{fill:#fff', '.a{}x'):
            with self.subTest(css=css), self.assertRaises(raster.RasterError):
                raster.class_rules(css)

    def test_reads_colours(self):
        self.assertEqual(raster.colour('#ff004d'), (255, 0, 77))
        self.assertEqual(raster.colour('#fff'), (255, 255, 255))
        self.assertIsNone(raster.colour('none'))
        with self.assertRaises(raster.RasterError):
            raster.colour('red')

    def test_places_a_translate_then_a_scale_inside_the_outer_one(self):
        at = raster.transform('translate(80 359) scale(0.5)', (2, 2, 0, 0))
        self.assertEqual(at, (1.0, 1.0, 160.0, 718.0))
        with self.assertRaises(raster.RasterError):
            raster.transform('rotate(45)', (1, 1, 0, 0))


class CoverageTest(unittest.TestCase):
    def test_a_box_on_whole_pixels_covers_them_fully(self):
        counts = raster.coverage([[(1, 1), (3, 1), (3, 2), (1, 2)]], (0, 0, 4, 3), ss=4)
        self.assertEqual(counts, [[0, 0, 0, 0], [0, 16, 16, 0], [0, 0, 0, 0]])

    def test_an_edge_through_a_pixel_covers_part_of_it(self):
        counts = raster.coverage([[(0, 0), (1.5, 0), (1.5, 1), (0, 1)]], (0, 0, 2, 1), ss=4)
        self.assertEqual(counts, [[16, 8]])

    def test_a_contour_wound_the_other_way_is_a_hole(self):
        outer = [(0, 0), (3, 0), (3, 3), (0, 3)]
        hole = [(1, 1), (1, 2), (2, 2), (2, 1)]
        self.assertEqual(raster.coverage([outer, hole], (0, 0, 3, 3), ss=2)[1], [4, 0, 4])

    def test_contours_wound_alike_fill_their_overlap_once(self):
        left = [(0, 0), (2, 0), (2, 1), (0, 1)]
        right = [(1, 0), (3, 0), (3, 1), (1, 1)]
        self.assertEqual(raster.coverage([left, right], (0, 0, 3, 1), ss=2), [[4, 4, 4]])


@unittest.skipUnless(DRAWS, 'drawing needs Pillow and fontTools')
class DrawTest(unittest.TestCase):
    def test_draws_rects_strokes_and_paths_at_its_scale(self):
        image = raster.draw(svg(8, 4, '<style>.dot{stroke:#ff0000}</style>'
                                '<rect width="8" height="4" fill="#ffffff"/>'
                                '<g fill="none" stroke-width="2"><path class="dot" d="M0 1h2"/></g>'
                                '<path fill="#0000ff" d="M4 0h4v4h-4z"/>'), 2)
        self.assertEqual((image.mode, image.size), ('RGB', (16, 8)))
        self.assertEqual(image.getpixel((1, 1)), (255, 0, 0))
        self.assertEqual(image.getpixel((1, 5)), (255, 255, 255))
        self.assertEqual(image.getpixel((12, 4)), (0, 0, 255))

    def test_an_icon_keeps_its_clear_ground(self):
        image = raster.draw(svg(4, 4, '<path fill="#ff004d" d="M0 0h2v2h-2z"/>'), 1)
        self.assertEqual(image.mode, 'RGBA')
        self.assertEqual(image.getpixel((0, 0)), (255, 0, 77, 255))
        self.assertEqual(image.getpixel((3, 3))[3], 0)

    def test_refuses_an_element_it_cannot_draw(self):
        for body in ('<circle r="2"/>', '<rect width="2" height="2" rx="1"/>'):
            with self.subTest(body=body), self.assertRaises(raster.RasterError):
                raster.draw(svg(4, 4, body), 1)


if __name__ == '__main__':
    unittest.main()
